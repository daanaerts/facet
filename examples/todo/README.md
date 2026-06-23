# todo — a playable to-do app on Facet

A real, **playable** to-do app built on `@facet/core`, projected onto **all four surfaces** — HTTP, CLI,
MCP, and the in-app agent — from **one** set of typed capabilities, with **zero per-surface code**. It is
spine-free: no tenant, no install, no `appId`, no db. A todo is owned by nothing but its `id`. The host's
entire contribution is `host.ts` (~110 lines): authenticate, grant the `todos:*` scopes, and supply an
in-memory idempotency ledger.

The point is that you can actually run it and poke it. Everything below is literal and runnable from the
repo root (`/Users/daan/workspace/mf/facet`).

## The capabilities

| id | risk | input | output |
|---|---|---|---|
| `todos.add` | write (idempotent) | `{ title }` | the created todo |
| `todos.list` | read | `{ done? }` | `{ todos: [...] }` |
| `todos.complete` | write | `{ id }` | the updated todo (404 if absent) |
| `todos.remove` | destructive | `{ id }` | `{ id, removed: true }` (404 if absent) |
| `todos.watch` | read (**streaming**) | `{ done? }` | one chunk per todo, then `{ count }` |

A `read` auto-runs on every surface. A `write`/`destructive` is **confirmation-gated** by the chokepoint —
but each surface *asserts* confirmation in its own idiom (a GUI's button / a CLI's `--yes` / an agent's
propose→confirm two-step); the gate itself lives in `execute()`, so no surface re-implements it.
`confirmation_required` is the engine's **safety net**, not a round-trip a human performs — see
[`docs/CONFIRMATION.md`](../../docs/CONFIRMATION.md).

The store seeds two todos (`todo_1` "buy milk", `todo_2` "write the README") so there is something to poke
at immediately. Each entrypoint has its own fresh in-memory store.

---

## HTTP — `serve.ts`

Branded headers: `x-facet-confirm: true` on writes, `x-facet-idempotency-key: <k>` to dedupe a retry.

Start the server (port `3002`, override with `PORT`):

```bash
bun run examples/todo/serve.ts
```

Then, in another terminal:

```bash
# health + the catalogue (the registry projected to HTTP — five capabilities, their schemas)
curl localhost:3002/health
curl localhost:3002/cap
curl localhost:3002/cap/todos.add          # one capability's entry (id, risk, input/output JSON Schema)

# read — auto-runs, no confirmation
curl -X POST localhost:3002/cap/todos.list -H 'content-type: application/json' -d '{}'
curl -X POST localhost:3002/cap/todos.list -H 'content-type: application/json' -d '{"done":false}'

# write WITHOUT the confirm header → 409 confirmation_required (the gate; a GUI/client sends the header WITH
# the action — confirmation_required is the safety net, not a step a human performs. See docs/CONFIRMATION.md)
curl -i -X POST localhost:3002/cap/todos.add -H 'content-type: application/json' -d '{"title":"ship it"}'

# write WITH the confirm header → runs, returns the created todo (todo_3)
curl -X POST localhost:3002/cap/todos.add \
  -H 'content-type: application/json' -H 'x-facet-confirm: true' \
  -d '{"title":"ship it"}'

# complete a todo (a write — needs the confirm header)
curl -X POST localhost:3002/cap/todos.complete \
  -H 'content-type: application/json' -H 'x-facet-confirm: true' \
  -d '{"id":"todo_1"}'

# remove a todo (destructive — same confirm header; returns { id, removed: true })
curl -X POST localhost:3002/cap/todos.remove \
  -H 'content-type: application/json' -H 'x-facet-confirm: true' \
  -d '{"id":"todo_2"}'

# idempotency — the SAME key replays the first result instead of adding a second todo (same id both times)
curl -X POST localhost:3002/cap/todos.add \
  -H 'content-type: application/json' -H 'x-facet-confirm: true' -H 'x-facet-idempotency-key: k1' \
  -d '{"title":"once"}'
curl -X POST localhost:3002/cap/todos.add \
  -H 'content-type: application/json' -H 'x-facet-confirm: true' -H 'x-facet-idempotency-key: k1' \
  -d '{"title":"this-title-is-ignored-on-replay"}'
```

### Streaming over HTTP — `todos.watch` as Server-Sent Events

`todos.watch` is a streaming read. Ask for SSE with the standard `Accept: text/event-stream` header and the
surface renders one `data:` frame per todo, then a terminal `event: result` frame carrying the final
`{ count }`. `-N` disables curl's buffering so you see the frames arrive:

```bash
curl -N -X POST localhost:3002/cap/todos.watch \
  -H 'content-type: application/json' -H 'accept: text/event-stream' \
  -d '{}'
```

```
data: {"todo":{"id":"todo_1","title":"buy milk","done":false,"createdAt":"..."},"n":1}

data: {"todo":{"id":"todo_2","title":"write the README","done":false,"createdAt":"..."},"n":2}

event: result
data: {"count":2}
```

Without the `Accept: text/event-stream` header the same capability is **drained** to its final JSON
(`{"count":2}`) — a plain client still gets the terminal value, exactly as a non-streaming read would.

---

## CLI — `cli.ts`

Branded flags: `--yes` (confirm), `--key <k>` (idempotency), `--actor <email>`, `--json '<input>'`.

```bash
# list the registry (the projection to the terminal)
bun run examples/todo/cli.ts ls

# read — auto-runs, prints pretty JSON
bun run examples/todo/cli.ts todos.list
bun run examples/todo/cli.ts todos.list --json '{"done":false}'

# write WITHOUT --yes → ✗ confirmation_required (exit 1)
bun run examples/todo/cli.ts todos.add --json '{"title":"ship it"}'

# write WITH --yes → runs, prints the created todo (todo_3)
bun run examples/todo/cli.ts todos.add --json '{"title":"ship it"}' --yes

# complete a todo (a write — needs --yes)
bun run examples/todo/cli.ts todos.complete --json '{"id":"todo_1"}' --yes

# remove a todo (destructive — needs --yes; prints { id, removed: true })
bun run examples/todo/cli.ts todos.remove --json '{"id":"todo_2"}' --yes

# 404 — the shared not_found taxonomy, rendered as ✗ not_found (exit 1)
bun run examples/todo/cli.ts todos.complete --json '{"id":"todo_999"}' --yes

# idempotency — same --key replays the first result (same id both times)
bun run examples/todo/cli.ts todos.add --json '{"title":"once"}' --yes --key k1
bun run examples/todo/cli.ts todos.add --json '{"title":"ignored-on-replay"}' --yes --key k1
```

### Streaming on the CLI — `todos.watch`

A streaming read prints **one JSON line per chunk as it arrives** (so a follow scrolls live), then the
validated final line:

```bash
bun run examples/todo/cli.ts todos.watch
```

```
{"todo":{"id":"todo_1","title":"buy milk","done":false,"createdAt":"..."},"n":1}
{"todo":{"id":"todo_2","title":"write the README","done":false,"createdAt":"..."},"n":2}
{"count":2}
```

---

## MCP — `mcp.ts` (stdio server for agents)

Launch the stdio MCP server — exactly what an MCP client (Claude Desktop, the SDK `Client`, an agent host)
launches and speaks JSON-RPC to over stdin/stdout:

```bash
bun run examples/todo/mcp.ts
```

Point an MCP client at it with the **absolute** path:

```jsonc
// e.g. an MCP client config
{
  "command": "bun",
  "args": ["run", "/Users/daan/workspace/mf/facet/examples/todo/mcp.ts"]
}
```

What an agent sees on `tools/list` (one tool per capability; the dotted id is mapped to an
Anthropic-regex-safe wire name, dots → `__`, with the original id on `annotations.title`):

| tool name | from capability | notes |
|---|---|---|
| `todos__add` | `todos.add` | write — `confirm` field **required**; optional `idempotencyKey` |
| `todos__complete` | `todos.complete` | write — `confirm` field **required** |
| `todos__list` | `todos.list` | read — auto-runs |
| `todos__remove` | `todos.remove` | destructive — `confirm` required, `destructiveHint: true` |
| `todos__watch` | `todos.watch` | streaming read — emits MCP progress notifications per chunk |

The `confirm` and `idempotencyKey` fields are **merged into each tool's input schema** by the surface, so
the propose→confirm handshake is modelled in the schema, not in surface code:

- call `todos__list` with `{}` → `structuredContent` with the todos.
- call `todos__add` with `{ "title": "ship it" }` → an `isError` result carrying
  `{"code":"confirmation_required", ...}` (the propose step).
- re-call `todos__add` with `{ "title": "ship it", "confirm": true }` → `structuredContent` with the
  created todo.

The MCP surface is also exercised in-process by the parity test (`tests/surfaces.ts` drives the SDK `Client`
over an in-memory transport), if you want to see the exact call shape in code.

---

## The agent surface (in-process)

The in-app copilot is Facet's **primary** surface, and the shortest: it runs in process, so there is no
transport at all. The host's driver advertises `agentToolset(registry)` to its model and calls
`dispatchToolCall(registry, { name, arguments }, { contextFor })` when the model emits a tool call. A write
called without `confirm` comes back `{ errorCode: "confirmation_required" }`; the driver surfaces the
proposed action to the human and re-dispatches with `confirm: true`. See `tests/surfaces.ts` `viaAgent` for
the exact dispatch path, and `host.ts` `devAgentContextFor` for the seam.

---

## Tests

```bash
bun test examples/todo
```

- `tests/headless.test.ts` — the todo capabilities through the chokepoint with a **bare** Context (mirror of
  the repo's `tests/headless.test.ts`): read, the done filter, validation, scope authz, the confirmation
  gate, idempotency replay, destructive + 404, kill-switch, and `todos.watch` streaming.
- `tests/parity.test.ts` — the **cross-surface parity** proof: `todos.add` returns the **same** output via
  HTTP, CLI (in-process `runCli`), MCP (the SDK `Client` over an in-memory transport), and the agent
  (`dispatchToolCall`), and **all four refuse with the same `confirmation_required` code** when unconfirmed.
  The normalized surface drivers live in `tests/surfaces.ts`, carved spine-free from
  `apps-demo/packages/parity/src/surfaces.ts`.
