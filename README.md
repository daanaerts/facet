# Facet

**One typed, headless capability → every surface. The agent is the primary consumer.**

> Define a use-case **once**, as a transport-agnostic capability. The agent surface (MCP / in-app copilot)
> is the one you design for; HTTP, CLI, and the human GUI are **projections** of the same capability — no
> per-surface code.

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

## Run it

```bash
bun test           # every package + examples + the extraction proof (90 tests)
bun run typecheck
bun run lint
```

Then **play** the full one-definition-many-surfaces demo (HTTP + CLI + MCP + agent, with streaming):
see [`examples/todo/README.md`](examples/todo/README.md) for literal, copy-paste commands —
`bun run examples/todo/serve.ts` and curl a `todos.add` / `todos.list` / the `todos.watch` SSE stream,
the same via `bun run examples/todo/cli.ts`, and the stdio MCP server via `bun run examples/todo/mcp.ts`.

## The two primitives (unchanged from the pitch)

- **`defineCapability`** — id, `input`/`output` Zod schemas, `risk` (`read`/`write`/`destructive`),
  `scopes`, `idempotent`, `handler(input, ctx)`. The whole surface area an author touches.
- **`execute(registry, id, rawInput, ctx)`** — the one chokepoint every surface flows through:
  resolve → validate → authz → confirm → idempotency → audit → run + output-check.

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

## Layout

```
packages/core/          @facet/core — the carved engine (no MF concepts)
packages/http/          @facet/http — one generic POST /cap/:id + /cap catalogue (SSE for streaming)
packages/cli/           @facet/cli — one generic `<cap.id> --json … --yes --key …` runner
packages/mcp/           @facet/mcp — one generic stdio server, one tool per capability
packages/agent/         @facet/agent — the primary surface: in-process toolset + dispatchToolCall
packages/parity/        @facet/parity — normalized surface drivers for the cross-surface parity proof
examples/logs/          an unrelated domain: logs + jobs (+ the four surface entrypoints)
  store.ts              in-memory domain state (the framework knows nothing about it)
  host.ts               the host's whole contribution: makeContext() + a MemoryLedger (~40 lines)
  capabilities/*.cap.ts logs.tail / logs.follow (reads), jobs.list (read), jobs.start (write), jobs.cancel (destructive)
examples/todo/          the playable to-do app on all four surfaces (its own README + serve/cli/mcp entrypoints)
tests/headless.test.ts  the extraction proof
tests/streaming.test.ts the streaming proof (one definition → every surface)
```

Carved from the Moral Fabric v2 spike (`../apps-demo`).
