# TAM & Adoption Friction

> TAM = the set of developers who can adopt Facet **without changing their stack**. This is the
> "wide TAM" file. Every architectural choice either widens that set or narrows it; there is no
> neutral dependency. Pairs with checklist group 2.

The mental model: picture the next 1,000 developers who might `npm i @facet/core`. Each forced
choice — a runtime, a validator, a framework, a bundler assumption, a transitive dependency —
quietly removes a slice of them. Beautiful, widely-adopted libraries are **subtractive about what
they demand of you.** Your job when this skill fires is to find the demand hiding in the change
and remove it.

---

## The dependency ladder

Every dependency is three costs at once: an **install-size tax**, a **version-conflict surface**
(your `zod@4` vs. their `zod@3`), and a **contract you don't control** (Rich Hickey, *Spec-ulation*:
"you are at the mercy of your dependencies' decisions about breakage"). So when a change wants a
new dependency, walk *down* this ladder and stop at the first rung that works:

1. **Inline it.** If it's small and stable, copy it in. Facet inlines the entire
   `StandardSchemaV1` interface (~20 lines) in `packages/core/src/standard-schema.ts` rather than
   taking a dependency on `@standard-schema/spec`. Zero install cost, zero version conflict, zero
   supply-chain surface — for a type-only contract, inlining is strictly better.
2. **Make it a port with a default adapter.** Depend on a *small interface you define*, ship one
   default implementation, let adopters swap it. `Ledger` (`ledger.ts`) and `SchemaAdapter`
   (`schema-adapter.ts`) are this: the engine needs *a* dedup store / *a* JSON-Schema projector,
   not *your* Redis / *Zod specifically*.
3. **Optional peer dependency.** If adopters who want a feature already have the package, make it
   a peer and mark it optional, so the rest don't pay for it. Facet's plan moves `elysia` to
   `peerDependencies` + `peerDependenciesMeta.optional` and splits it to an `./elysia` subpath
   (`docs/PUBLISHING.md` §3) — a Hono or bare-`Bun.serve` user never installs Elysia.
4. **Hard dependency — last resort.** Only when the value is core and the library is rock-stable.
   Facet's *one* runtime dependency is Zod, and even that is positioned as the *default
   projection adapter*, not a hard requirement of the validation type. Justify any addition to
   this rung out loud.

> When a change adds a hard dependency, your default recommendation is "can this be rung 1, 2, or
> 3 instead?" Usually it can.

---

## Never force the adopter's sibling tools

The fastest way to narrow TAM is to make an adopter rip out a tool they already chose. Facet's
whole architecture is organized to avoid this — depend on **contracts and ports**, not on
specific tools:

| Adopter already chose… | The narrowing move (avoid) | Facet's widening move |
|---|---|---|
| A validation library (Valibot, ArkType, Zod 3…) | Hard-require Zod | Type `input`/`output` to **Standard Schema**; validate via `['~standard']` — any compliant lib works (`define.ts`, `execute.ts:76`) |
| A web framework (Hono, Express, Elysia, none) | Ship a framework you must mount inside | A **portable `(req) => Response` fetch handler** (`createFetchHandler`); Elysia is an *optional* wrapper |
| A datastore (Postgres, Redis, in-memory) | Bake in a DB client | The `Ledger` **port** (`claim`/`commit`/`read`); the host backs it with a unique constraint or `SET NX` |
| A runtime (Node, Deno, Bun) | `import { Glob } from "bun"` | Runtime-pure engine; `node:fs` discovery that runs on all three (`discover.ts`) |

**Standard Schema is the canonical lesson here.** It's an industry contract (2024) created by the
authors of Zod, Valibot, and ArkType precisely so libraries can accept *any* validator via a
shared `~standard` key — "depend on the contract, not the implementation," validated by the
ecosystem itself. Facet adopting it is the single highest-leverage TAM move in the codebase: it
turns "Facet users must use Zod" into "Facet users use whatever they already use." When a change
touches validation, this is the bar.

> **Nuance — projection vs. validation.** Standard Schema makes *validation* library-agnostic, but
> *projection* (turning a schema into JSON Schema for the HTTP catalogue / MCP tool declaration)
> still needs a per-library adapter. Facet keeps that as a separate Zod-first seam
> (`schema-adapter.ts`) so `advertise == enforce` for the common case. Don't conflate the two: a
> change can be validation-agnostic and still projection-specific, and that's fine — just keep the
> projection behind the `SchemaAdapter` port so another lib can be added without touching the
> engine.

---

## Runtime portability: pure core, runtime bits behind ports

"Bun-first, not Bun-only" is a TAM decision (most adopters are on Node). The rule:

- **The shipped engine must be runtime-pure** — no `from "bun"`, no Node-only globals, no
  Deno-hostile APIs in the path an adopter imports. `execute` / `define` / `Registry` / errors /
  context already are; the one leak (`Bun.Glob` in discovery) was carved out for a `node:fs`
  recursive walk (`discover.ts`).
- **Runtime-specific power lives behind a port with a portable default.** The planned
  tracer/profiler uses `performance.now()` by default (works everywhere) and `Bun.nanoseconds()`
  only as an *optional* high-res path behind the port (`TODO.md`, "Agentic self-inspection"). The
  Bun-optimized path is a bonus, never a requirement.
- **Prove it, don't assert it.** "Runs on Node 22+ and Deno" is only true when CI runs the built
  output on Node and Deno (the deferred Bun/Node/Deno matrix in `docs/PUBLISHING.md` §7). Until
  then it's a claim, not a fact — flag any change that *deepens* the runtime assumption without a
  test that would catch a regression.

When a change reaches for a runtime-specific API in shipped code, the recommendation is: move it
behind a port, default to the portable implementation, and keep the fast path optional.

---

## Library, not framework (the IoC tax)

A **library** is code your host *calls*. A **framework** *calls your code* and owns the entry
point — the "Hollywood principle": *don't call us, we'll call you.* Inversion of control is a TAM
narrower, because the cautious adopter with an existing app **can't drop an IoC framework into
it** — they'd have to rebuild around it. That's the highest-friction ask in software.

Facet is emphatically library + adapters (`TODO.md`, Positioning):

- The **host owns `main()`** and calls `execute(...)`. Facet never starts your server, owns your
  router, or controls your process.
- **Adapters produce mountable artifacts**, not running systems: `createFetchHandler` returns a
  `(req) => Response` you mount where *you* choose (`Bun.serve`, `Deno.serve`, Node via a tiny
  adapter, or inside Elysia/Hono). `runCli`, `createMcpServer`, `agentToolset` are the same shape
  — things you call and place.

**Smell to flag:** any change where Facet wants to "take over" something — own the HTTP server,
require a specific bootstrap order, demand a global registry singleton, install middleware into
the host's framework. Recommend the mountable-artifact shape instead: hand the host a value and
let them wire it.

---

## Install correctness *is* TAM

A library that doesn't install cleanly has a TAM of zero, no matter how elegant the API. The
modern bar (all in `docs/PUBLISHING.md`):

- **Don't ship raw `.ts`.** Compile to `.js` + `.d.ts`. Shipping `./src/index.ts` (the current
  pre-publish state) breaks plain Node and any bundler that doesn't special-case `.ts`.
- **ESM-correct `exports` map** with an `import` condition resolving `types` then `default`; keep
  legacy `main`/`types` as fallbacks for old resolvers.
- **Types must resolve under every `moduleResolution`** (`node16`, `bundler`, `node`). The tool
  that proves it is `@arethetypeswrong/cli` (attw); the tool that catches a broken exports map /
  missing `files` / `.ts` in exports is `publint`. Both belong in CI as a merge gate.
- **Tree-shakeable:** `"sideEffects": false` so adopters' bundlers can drop unused exports —
  which also rewards keeping the surface small.
- **ESM-only is a legitimate TAM call here**, not a gap: every target runtime supports ESM
  natively, and dual-publishing invites the **dual-package hazard** (two copies of the module in
  one graph → broken `instanceof`). Add CJS only if a real adopter needs it.

When a change touches packaging, module format, or exports, the recommendation must keep the
`publint` + `attw` gate green — treat a red there as "this narrows TAM to zero on some
toolchains."

---

## Worked example: "an adopter uses Valibot, not Zod"

> **Question:** a prospective adopter standardized on Valibot. Can they use Facet?
>
> - **Validation:** yes, unchanged. `defineCapability`'s `input`/`output` are typed to
>   `StandardSchemaV1`, and Valibot implements `~standard`, so `execute()` validates their
>   schemas with no Zod in sight (`execute.ts:76`). Their handler types infer correctly through
>   the spec.
> - **Projection (HTTP catalogue / MCP tool schema):** the default `SchemaAdapter` is Zod-first,
>   so JSON-Schema projection of a Valibot schema needs a Valibot adapter registered via
>   `setSchemaAdapter` — a *port swap*, not an engine change.
> - **TAM verdict:** **widened.** The hard part (validation + types) is agnostic by construction;
>   the soft part (projection) is a documented port. The recommendation if this comes up
>   repeatedly: ship a `@facet/valibot` projection adapter — additive, no core change, no new
>   forced dependency for Zod users.
