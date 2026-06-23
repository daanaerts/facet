# Streaming — the mid-stream-error contract

> Status: **normative**. This is the auditable spec the four surfaces are tested against.
> Scope: what happens when a stream fails **after** `K` chunks have already been emitted.
> Source decision: TODO.md, "Mid-stream error contract — DESIGN, the keystone corner."

## The problem

`execute()` returns one value, so a unary failure is always *pre-result*: nothing has been sent, and the
surface renders the `FacetError` natively (HTTP status, MCP `isError`, CLI exit code). Streaming breaks that
symmetry. `executeStream()` is an async generator: it yields `K` validated chunks **and only then** may fail,
because a chunk fails its `chunk` schema or the handler throws part-way through iteration. By the time it
fails, the surface has often already **committed** to a success framing — an HTTP `200` with an open
`text/event-stream` body, MCP progress notifications, CLI lines on stdout. There is no taking those back.

Two distinct failure points, deliberately treated **differently**:

| When it fails | What it is | Rendering |
| --- | --- | --- |
| **Pre-stream** (before chunk 1) | unknown id · kill-switch · not-streaming · bad **input** · missing scope | the surface's **native error** (HTTP JSON status, MCP `isError`, CLI exit 1) — unchanged from today |
| **Mid-stream** (after chunk `K ≥ 1`) | a **chunk** fails its `chunk` schema · the handler **throws** mid-iteration | `K` chunks are delivered in order, then the surface's **terminal in-band error** (see per-surface table) — *never* a silent truncation, *never* a fake success terminator |

The whole contract is the second row. The first row is settled and only restated so the boundary is explicit.

## Core — the canonical reference behavior (`@facet/core` `executeStream`)

`executeStream()` is the single definition of "what failed and when"; every surface is a *rendering* of it and
re-implements none of its checks. The generator:

1. runs the read gates **before chunk 1** — resolve → validate(input) → authz → audit. Any failure here throws
   a `FacetError` on the **first pull**, before a single chunk escapes (this is the *pre-stream* row).
2. drives the handler generator, and for **each** yielded value validates it against `chunk`. A valid chunk is
   re-yielded; an **invalid** chunk throws `FacetError("internal", "…produced an invalid chunk", 500, …)`
   **after** the `K` good chunks already yielded.
3. if the **handler throws** while producing chunk `K+1`, that throw propagates out of the generator after the
   `K` good chunks. It is normalized so a surface always sees one error type: a thrown **`FacetError` passes
   through unchanged**; any **non-`FacetError`** is wrapped as `FacetError("internal", message, 500, …)` —
   exactly the `internal` mapping every surface already applies to a non-`FacetError` on the unary path.
4. validates the handler's **return** against `output`; an invalid final throws `FacetError("internal", …)`.

> **Invariant (the keystone):** a mid-stream failure is **always a thrown `FacetError`, raised after the
> already-yielded chunks** — never a silent `return`, never a truncated-but-"clean" completion. A consumer that
> drove the generator with `for await` sees the `K` chunks then the throw. This is the behavior `streamToolCall`
> (the agent surface) exposes verbatim, and it is the reference the other three surfaces must match.

`drainStream()` (the bridge that lets unary `execute()` serve a streaming capability) inherits this for free: a
mid-stream throw propagates out of the drain exactly as a unary handler failure would, so a non-streaming caller
of a streaming capability sees the same `FacetError` it would see from any other failed `execute()`.

## agent (`@facet/agent` `streamToolCall`) — the reference, unchanged

The driver consumes the `AsyncGenerator<Chunk, Final>` with `for await`. It observes the `K` validated chunks,
then the loop **throws** the `FacetError`. Nothing is translated to an `{ errorCode }` here (that is the unary
`dispatchToolCall` shape); a streaming refusal or mid-stream failure surfaces as the thrown typed error, which
the driver catches. This surface is the canonical shape; the three below are defined to reproduce it.

## HTTP SSE (`@facet/http`) — terminal `event: error` frame

Once the first SSE frame is out, the response is **`200` with `Content-Type: text/event-stream` and committed**
— a mid-stream failure therefore **cannot** be an HTTP status. So:

- **Pre-stream** failure: unchanged. The first pull is primed **outside** the SSE generator (in the route), so a
  pre-stream `FacetError` is mapped to a normal JSON status response (`422`/`403`/`404`/…) and **no** stream is
  opened. The client never sees a `200` body that then breaks.
- **Mid-stream** failure: after the `K` `data: <chunk-json>` frames, emit a single terminal
  `event: error` frame whose `data:` is the `FacetError` triple `{ code, message }`, then **end** the stream.
  It is emphatically **not** an `event: result` frame — a client distinguishes "the stream ended in an error"
  (`event: error`) from "the stream completed with this final value" (`event: result`) purely by the terminal
  event name. A successful stream ends in exactly one `event: result`; a failed one ends in exactly one
  `event: error`; neither ever emits both.

Frame grammar (terminal frame, mutually exclusive):
```
data: {"line":"…","n":1}            ⟵ chunk 1            \n\n
…                                                          (K of these)
event: error                        ⟵ terminal on failure
data: {"code":"internal","message":"…"}                    \n\n
```

## CLI (`@facet/cli`) — printed chunks, then `✗` on stderr + exit 1

The CLI prints one JSON line per chunk to **stdout** as it arrives (so a `follow` scrolls live). On a mid-stream
failure it prints the `K` chunk lines already produced, then on the throw prints `✗ <code>: <message>` (plus the
error `data`, if any) to **stderr** and returns exit **1** (`EXIT.error`) — and crucially prints **no** final
result line. This is the exact rendering of a *pre-stream* CLI refusal (`✗ <code>` + exit 1), only now preceded
by the chunk lines that did make it out. A successful stream ends with the final value as its last stdout line
and exit 0; a failed one ends with `✗` on stderr and exit 1, with no final line.

## MCP (`@facet/mcp`) — `isError` tool result, same shape as a unary error

When a client requested progress, the surface emits one `notifications/progress` per chunk; those `K`
notifications have already gone out and cannot be recalled. On a mid-stream failure the surface returns an
**`isError`** tool result carrying `{ code, message }` as JSON **in `content` text** — and **NOT** as
`structuredContent`. This is byte-for-byte the same shape as a *unary* MCP error: every Facet tool declares an
`outputSchema`, so the SDK `Client` validates any `structuredContent` against it even on an error result; the
error body is not a valid capability output, so attaching it there would make the client throw `-32602` and
swallow the typed error. A successful stream returns the final as `structuredContent`; a failed one returns
`isError` + `{ code, message }` in text, with no `structuredContent`.

## Cross-surface parity (what the tests assert)

For the same mid-stream-failing capability and the same input, each surface must deliver **the same `K` chunks,
in the same order**, then render the failure in its **own native terminal form**:

| surface | the `K` chunks | terminal on mid-stream failure |
| --- | --- | --- |
| agent  | yielded by the generator | the generator **throws** the `FacetError` |
| http (SSE) | `K` `data:` frames | one `event: error` frame `{ code, message }`, then end |
| cli    | `K` stdout JSON lines | `✗ <code>: <message>` on stderr, exit 1, no final line |
| mcp    | `K` `notifications/progress` | `isError` result `{ code, message }` in `content` text |

Both triggers are covered for every surface: a **handler that throws** mid-iteration and a **chunk that fails
its schema** must produce the identical native terminal rendering (the only difference is the `code`/`message`:
a thrown `FacetError` keeps its own code; a bad chunk and a thrown non-`FacetError` are `internal`).

## Why the surfaces stay pure

These are **rendering** changes only. No surface gains a validation, an authz check, or a handler call — the
throw still originates inside `executeStream()` and the surface merely catches it on its way out and renders it
the way it already renders a pre-stream `FacetError`. The surface-purity tripwire stays green by construction.
