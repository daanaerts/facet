# Facet

**One typed, headless capability → every surface. The agent is the primary consumer.**

> Define a use-case **once**, as a transport-agnostic capability. The agent surface (MCP / in-app copilot)
> is the one you design for; HTTP, CLI, and the human GUI are **projections** of the same capability — no
> per-surface code.

Facet is a **library you call + adapters you mount** — not an inversion-of-control framework. The host owns
the entry point and calls `execute(...)`; the surface adapters turn the registry into *mountable artifacts*
(a Web fetch handler, a CLI runner, an MCP server, an in-process toolset) and never own your process or your
router. It is **Bun-first but not Bun-only**: the engine is **runtime-pure** and runs on Bun, Node 22+ and
Deno — every runtime-specific bit (discovery, HTTP serving, validation library) lives behind a port with a
portable default.

This is not the pitch repo. **This repo is an experiment with a yes/no question:**

> Is the Facet capability engine actually domain-agnostic — or is it Moral Fabric (the app it was spiked
> inside) wearing a costume?

The only way to know is to pull the core out of MF and stand it up on a domain that shares **none** of MF's
spine. That is what's here: a carved `@facet/core` plus an unrelated example domain (`logs` & `jobs` — no
tenants, roles, circles, or installs anywhere).

## The decision rule

- **Clean extraction** + the streaming read projecting cleanly to all four surfaces → the abstraction is
  real; proceed to build Facet as a framework, with the agent as the primary surface.
- **Leaky** (the core keeps reaching back for an MF concept) → reshape the boundary, or stop, having spent
  days instead of quarters.

## Status

| Piece | State |
|---|---|
| Carved `@facet/core` (`defineCapability`, `execute`, registry, errors, ports) | ✅ |
| Headless proof — the chokepoint runs an unrelated domain with a bare Context | ✅ `bun test` |
| HTTP surface (one generic `POST /cap/:id` + a `/cap` catalogue) | ✅ branded `x-facet-*` headers; written once, generic over the registry |
| CLI surface (`<cap.id> --json … --yes --key …`) | ✅ branded `--yes` / `--key` / `--actor` flags; in-process testable, exit-code leaf |
| MCP surface (stdio server, one tool per capability) | ✅ dots→`__` wire names; `confirm`/`idempotencyKey` merged into each tool schema |
| Agent surface (in-process toolset + `dispatchToolCall`) | ✅ the primary surface — no transport; same `confirmation_required` handshake |
| Streaming as an agent-primary projection (`logs.tail` / `todos.watch`) | ✅ the design spike held — one streaming def → SSE / CLI lines / MCP progress / drain-to-final |
| Playable to-do demo across all four surfaces | ✅ `examples/todo` — one capability set, zero per-surface code; cross-surface parity proven |
| **Validation contract → Standard Schema** | ✅ `input`/`output` typed to `StandardSchemaV1` (inlined, no dep); validates with any compliant lib (Zod/Valibot/ArkType), Zod kept as the default projection adapter |
| **Portable HTTP** — a Web `(req) => Response` fetch handler | ✅ `@facet/http` `createFetchHandler` on pure Web APIs; mounts in `Bun.serve` / `Deno.serve` / Node-via-adapter / inside Elysia–Hono |
| **Runtime-pure discovery** | ✅ `node:fs` recursive walk (Bun + Node 22+ + Deno); the last `Bun.Glob` leak is gone |
| **Atomic idempotency ledger** | ✅ `claim`/`commit`/`read` insert-once port — survives concurrent double-submit, not just sequential retries |
| **Mid-stream error contract + cross-surface streaming parity** | ✅ the keystone corner: K chunks then one native terminal error on every surface — see [`docs/STREAMING-CONTRACT.md`](docs/STREAMING-CONTRACT.md) |
| **Promoted `@facet/parity`** | ✅ generic harness: raw `execute()`/`executeStream()` baseline leg + all four surfaces, unary AND mid-stream (throw / bad-chunk / raw-throw) |
| **Structural surface-purity tripwire + surprise-capability test** | ✅ a surface re-implements *none* of the chokepoint (textual guard), and a brand-new cap lights up on all four surfaces with zero adapter edits |

## Run it

```bash
bun test           # every package + examples + the extraction & parity proofs (the full suite)
bun run typecheck
bun run lint
```

The engine is **dependency-free** beyond Zod (the default validator/projector) and runtime-pure, so the
same `bun test` body runs on Node 22+ and Deno; the Bun/Node/Deno CI matrix that *proves* this is the
human's to add (deferred — see `TODO.md`).

Then **play** the full one-definition-many-surfaces demo (HTTP + CLI + MCP + agent, with streaming):
see [`examples/todo/README.md`](examples/todo/README.md) for literal, copy-paste commands —
`bun run examples/todo/serve.ts` and curl a `todos.add` / `todos.list` / the `todos.watch` SSE stream,
the same via `bun run examples/todo/cli.ts`, and the stdio MCP server via `bun run examples/todo/mcp.ts`.

## The two primitives (unchanged from the pitch)

- **`defineCapability`** — id, `input`/`output` schemas (any **Standard Schema** — Zod/Valibot/ArkType;
  the engine depends on the `~standard` contract, not on Zod), `risk` (`read`/`write`/`destructive`),
  `scopes`, `idempotent`, `handler(input, ctx)`. The whole surface area an author touches. A streaming
  capability uses `defineStreamingCapability` (adds a `chunk` schema + an async-generator handler).
- **`execute(registry, id, rawInput, ctx)`** — the one chokepoint every surface flows through:
  resolve → validate → authz → confirm → idempotency → audit → run + output-check. Idempotency is an
  **atomic `claim`/`commit`** against the `Ledger` port, so exactly one caller of a given key runs the
  handler even under concurrent double-submit. `executeStream(...)` is its streaming twin — an async
  generator that validates every chunk and, on a mid-stream failure, throws a `FacetError` *after* the
  chunks already yielded (the contract every surface renders natively).

## Carve log — what came out of MF, and the finding

The point of the experiment is *what had to change* to decouple the engine. Every removal below was an
MF platform concept that had leaked into the supposedly-generic core:

| Removed from the core | Why it was host-specific | How a host gets it back |
|---|---|---|
| `Context.tenant` (was **required**) | Multi-tenancy is a product's spine, not a capability concept | Fold the tenant into `scopes` + the idempotency key the host passes |
| `Installs` port + **install-gating as `execute()` step 1** | "Is this app installed for this tenant" is MF's app model | A host that wants it gates *before* calling `execute()` |
| `CapabilityDef.appId` + its discovery tagging | App-ownership derived from `apps/<id>/` paths is MF layout | Capabilities are owned by their `id` and nothing else |
| `Context.db` | A specific Drizzle handle | Handlers import their own domain modules (see `examples/logs/store.ts`) |
| `tenant` param on the `Ledger` port | Tenant-scoped dedup is the host's call | The host folds tenant into the dedup key |
| The `@mf/shared` ↔ `@mf/core` split | Existed only to keep `shared` free of the Drizzle import | With `db` gone, the split is unnecessary — one `@facet/core` |

**The finding so far (the headline):** the carved `execute()` is **`facet.md`'s 7-step pipeline verbatim.**
MF's real `execute()` had a *hidden 8th step in front* — install-gating — plus `tenant` threaded through
audit and the ledger. In other words the **doc already described the generic engine**; the *code* had
drifted host-ward. The extraction is mostly subtraction, which is the encouraging direction. (Also: the
typed error taxonomy `facet.md` files under "open questions" already exists and ported essentially
unchanged — see `packages/core/src/errors.ts`.)

**Now also proven (the second half of the bet):** all four surfaces project cleanly *without the spine*,
and **streaming survived** the one-definition-many-surfaces promise — the part most likely to find the
leak. Each surface (`@facet/http`, `@facet/cli`, `@facet/mcp`, `@facet/agent`) is written **once, generic
over the registry**; its only job is to establish a `Context` via a host authenticator and translate
errors — it validates nothing and authorizes nothing (that all stays in `execute()`), and the surfaces
share nothing but `@facet/core`. A single streaming definition (`logs.follow`, `todos.watch`) projects to
SSE over HTTP, one-JSON-line-per-chunk on the CLI, MCP progress notifications, and a plain drain-to-final
for non-streaming clients — no per-surface streaming code. The `examples/todo` app exercises the whole
thing end to end and its parity test asserts `todos.add` returns the **same** output and refuses with the
**same** `confirmation_required` code across HTTP, CLI, MCP, and the agent. No surface had to reach back
for an MF concept. The carve holds.

**"No per-surface code" is now ENFORCED, not just intended.** Two guards make the negative property
mechanical:

- **The surface-purity tripwire** (`tests/surface-purity.test.ts`) — a structural scan of the four surface
  `src` dirs that fails if any surface validates input (`~standard` / `safeParse` / `def.input.parse`),
  enforces scopes (`requireScope`), or calls a handler (`.handler(` / `.streamHandler`); and that asserts
  every surface DOES route through `execute()`/`executeStream()`. Guard before refactor.
- **The surprise-capability test** (`tests/surprise-capability.test.ts`) — registers a never-before-seen
  capability into a fresh registry and asserts it is live and correct on all four surfaces with **zero**
  adapter edits. The cleanest positive proof.

And **`@facet/parity`** is now a real, generic harness (promoted out of the demo): it drives one capability
through a raw `execute()`/`executeStream()` **baseline leg** plus all four surfaces and asserts they agree —
on output, on the confirmation gate, on the error taxonomy, and on the **ordered stream + termination**.
Streaming parity covers the keystone corner: for a mid-stream failure (`logs.boom` — a typed throw, a chunk
that fails its schema, and a raw non-`FacetError` throw) every surface delivers the same `K` chunks then its
own native terminal error (SSE `event: error`, MCP `isError`, CLI `✗` + exit 1, the agent iterator throws).
The full contract is pinned in [`docs/STREAMING-CONTRACT.md`](docs/STREAMING-CONTRACT.md).

**Portability + the public contract were also frozen before adopters exist.** Validation now flows through
**Standard Schema** (`StandardSchemaV1`, inlined as ~20 lines rather than added as a dependency), so a
capability can be authored with any compliant library while the engine depends only on the `~standard`
contract; projection to JSON Schema (what the HTTP catalogue advertises and an MCP tool declares) stays a
separate Zod-first seam, so *advertise == enforce* for the common case. Discovery dropped its one Bun-only
leak (`Bun.Glob` → a `node:fs` recursive walk), the HTTP surface is a portable Web `(req) => Response` fetch
handler with no framework underneath, and the idempotency ledger is an atomic insert-once port. The engine
imports clean on Bun, Node 22+ and Deno.

## Layout

```
packages/core/          @facet/core — the carved, runtime-pure engine (no MF concepts)
  standard-schema.ts    the inlined StandardSchemaV1 validation contract (no dependency)
  schema-adapter.ts     the separate Zod-first JSON-Schema projection seam (toJsonSchema)
  discover.ts           portable node:fs recursive *.cap.ts discovery (Bun + Node 22+ + Deno)
  ledger.ts             the atomic claim/commit/read idempotency port
packages/http/          @facet/http — a portable Web (req) => Response fetch handler (createFetchHandler);
                        one generic POST /cap/:id + /cap catalogue (SSE for streaming). createHttpApp mounts
                        the same handler in Elysia; mounts equally in Bun.serve / Deno.serve / Node-via-adapter
packages/cli/           @facet/cli — one generic `<cap.id> --json … --yes --key …` runner
packages/mcp/           @facet/mcp — one generic stdio server, one tool per capability
packages/agent/         @facet/agent — the primary surface: in-process toolset + dispatchToolCall
packages/parity/        @facet/parity — the GENERIC cross-surface parity harness: a raw execute() baseline leg
                        + all four surface drivers, unary AND streaming (incl. mid-stream error parity)
examples/logs/          an unrelated domain: logs + jobs (+ the four surface entrypoints)
  store.ts              in-memory domain state (the framework knows nothing about it)
  host.ts               the host's whole contribution: makeContext() + a MemoryLedger (~40 lines)
  capabilities/*.cap.ts logs.tail / logs.follow (reads), jobs.list (read), jobs.start (write), jobs.cancel
                        (destructive), logs.boom (the mid-stream-failure fixture for streaming parity)
examples/todo/          the playable to-do app on all four surfaces (its own README + serve/cli/mcp entrypoints)
examples/saas/          MULTI-TENANT: projects keyed by a workspace claim — ctx.claims / requireClaim, a
                        per-tenant scopedLedger, tenant isolation; auth port = in-memory token map + real HS256 JWT
examples/billing/       MONEY: charge/refund/export — the reversible flag, the destructive-refund wedge, and
                        idempotency-as-safety (no double refund); gateway port = in-memory + real Stripe
examples/outbox/        EXTERNAL CONNECTORS: email.send / issues.open via the ctx.connector port, with loud
                        connector_unavailable; connector port = in-memory + real Resend / GitHub
docs/STREAMING-CONTRACT.md   the normative mid-stream-error + cross-surface streaming contract
tests/headless.test.ts       the extraction proof
tests/streaming.test.ts      the streaming proof (one definition → every surface)
tests/surface-purity.test.ts the structural tripwire (no surface re-implements the chokepoint)
tests/surprise-capability.test.ts  a brand-new cap lights up on all four surfaces, zero adapter edits
```

Carved from the Moral Fabric v2 spike (`../apps-demo`).
