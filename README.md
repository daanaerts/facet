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
| HTTP surface (one generic `POST /cap/:id`) | ⬜ next |
| CLI / MCP / agent surfaces | ⬜ next |
| Streaming as an agent-primary projection (`logs.tail`) | ⬜ the real design spike |

## Run it

```bash
bun install
bun test           # the extraction proof
bun run typecheck
```

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

What is **not yet proven**: that the *surfaces* project cleanly without the spine (only the headless core
is exercised so far), and that **streaming** survives the one-definition-many-surfaces promise. Those are
the next steps, and streaming is the one most likely to find the leak.

## Layout

```
packages/core/          @facet/core — the carved engine (no MF concepts)
examples/logs/          an unrelated domain: logs + jobs
  store.ts              in-memory domain state (the framework knows nothing about it)
  host.ts               the host's whole contribution: makeContext() + a MemoryLedger (~40 lines)
  capabilities/*.cap.ts logs.tail (read), jobs.list (read), jobs.start (write), jobs.cancel (destructive)
tests/headless.test.ts  the extraction proof
```

Carved from the Moral Fabric v2 spike (`../apps-demo`).
