# Facet — Tech & Positioning TODOs

> Source: tech/architecture review, 2026-06-23.
> **Governing decision:** Facet is a **public, adoptable npm framework**, built as a **library + optional adapters** (NOT inversion-of-control), **Bun-first but runs on Node 22+ and Deno too**.

## Decisions log
- **2026-06-23** — Audience = public, adoptable framework.
- **2026-06-23** — Shape = **library you call + adapters you mount**, confirmed. Not an IoC framework.
- **2026-06-23** — Runtime = **Bun-first, NOT Bun-only.** Bun is the recommended/optimized runtime + dev toolchain; published packages must also run on Node 22+ and Deno. ⇒ engine is runtime-pure; runtime-specific bits (glob, high-res timing, deep profilers, HTTP serving) live behind ports/adapters with a Bun-optimized default + Node/Deno fallbacks. CI proves it with a Bun/Node/Deno matrix.
- **2026-06-23** — New first-class workstream: **agentic self-inspection (debug + profiling)**. See its section.

---

## Positioning (decided — record, don't re-litigate)

- **Library you call + optional adapters you mount.** Host owns the entry point and calls `execute(...)`. "No per-surface code" comes from projection adapters that generate wiring from the registry — not from Facet owning your app. **Discipline:** adapters produce *mountable artifacts*; they never own the process or the router.
- **Facet rides on top of the transport — does not replace Elysia/Hono.** Elysia/Hono = HTTP layer (socket, router, parsing). Facet = capability engine. Facet replaces the *per-endpoint glue* and the re-implementation across CLI/MCP/agent, not the web framework.
- **HTTP adapter emits a Web `(req: Request) => Promise<Response>` fetch handler** — the portable artifact. Mount it in `Bun.serve` / `Deno.serve` (native) or Node via a tiny adapter (`@hono/node-server` / `srvx`), or inside Elysia/Hono for their middleware. Facet does not pick the framework.

---

## NEW — Agentic self-inspection (debug + profiling)

**Why it's almost free here:** (1) `execute()` is the *single chokepoint* every call flows through — instrument it once, profile every capability on every surface. (2) *Everything is a capability, including introspection* — expose profiler output as `facet.*` capabilities; an agent inspects through the same `execute()`/MCP/HTTP it already uses. Self-hosting introspection.

- [ ] **(P0 seam — do while `execute` is small) Optional `tracer`/`profiler` port on `Context`** (alongside `ledger`/`connector`). Present ⇒ `execute()` wraps each of its 7 steps in a span; absent ⇒ one `if`, zero overhead. Span tree per invocation.
- [ ] **(P0 seam) Handler self-instrumentation:** `ctx.span(name, fn)` / `ctx.mark(name)`; sub-spans nest under the handler span automatically. "The handler writes its own profiling."
- [ ] **(P0 seam) Portable timing:** default `performance.now()` (Bun + Node + Deno); use `Bun.nanoseconds()` as an optional high-res path on Bun. Keep timing behind the port so runtime-specific clocks don't leak into the engine.
- [ ] **(P1 tooling) Debug mode** (`FACET_DEBUG=1` / host flag): Context carries a real tracer + structured per-invocation logs — per-step timings, I/O sizes, replay-vs-run, scopes checked, validation cost, idempotency hit/miss. Off in prod.
- [ ] **(P1 tooling) Introspection capabilities** (structured output, so agents reason over it, not parse logs):
  - `facet.capabilities.list` / `facet.describe(id)` — enumerate the registry (id, summary, schemas, risk, scopes).
  - `facet.trace.last` / `facet.trace.get(id)` — span tree of a recent invocation.
  - `facet.profile.summary` — p50/p95/max per capability + per-step breakdown + top hotspots.
- [ ] **(P1 tooling) Profiler exports:** dump spans in **Chrome Trace Event format** (→ `chrome://tracing` / Perfetto / speedscope flamegraphs). Deep profiling behind a runtime adapter: Bun `--inspect` + `Bun.generateHeapSnapshot()`; Node `--inspect` / `node:inspector` / `v8.getHeapSnapshot()`; Deno `--inspect`.
- [ ] **Target agentic loop:** boot host in debug mode → `facet.capabilities.list` → call an endpoint N× → `facet.profile.summary` → spot hotspot → edit → re-run → compare. (The workflow that produced ~20x before.)

---

## Cross-surface parity — the guardrail that makes "no per-surface code" *enforceable*

**Status (2026-06-23, audited by the other session):** The negative property **holds today, behaviourally** — grep of `packages/{http,cli,mcp,agent}/src` finds zero `safeParse` / `~standard` / `requireScope` / `def.handler(`; every surface routes through `execute()`/`executeStream()`, branching only on generic `def.stream` / `def.risk`, never on a capability id. **But it rests on intent + current tests, not a mechanism.** Specifics:
- `@facet/parity` is a **stub** (`export {}`). The only real harness is a copy in `examples/todo/tests/` (drives `todos.add` + `todos.list` through agent/cli/http/mcp via `surfaces.ts`).
- Parity asserts identical happy-path output + identical `confirmation_required` across 4 surfaces. **Missing:** validation / forbidden / not_found parity, and a **raw `execute()` baseline leg** — agent currently stands in as baseline, so agent-surface drift would be invisible.
- **No surprise-capability test. No structural guard** (MF's eslint boundaries were dropped in scaffold). **No CI** (`.github/` absent).
- Streaming: per-surface tests are strong (HTTP ordered SSE `data:` → `event: result`, pre-stream errors as JSON; MCP one `progress` per chunk + final `structuredContent`). **But no cross-surface streaming parity, and mid-stream error behaviour is undefined** — once HTTP commits a 200 SSE stream there is no termination contract if chunk N fails validation. The genuine open corner.
- Advertise == enforce: holds by construction (surfaces advertise `toJsonSchema(def.input)`; execute enforces the same Zod object) but unasserted; only real looseness = a Zod `.refine()` JSON Schema can't express.

**Plan (sequenced):**
- [ ] **NOW — standalone hardening commit, before the reconcile pass:**
  - [ ] **Structural tripwire FIRST** (grep/AST test + lint step): forbid `.handler(` / `safeParse` / `~standard` / `requireScope` in the four surface dirs (allow read-only `toJsonSchema(def.input)` / `def.risk` / `def.stream`). Do it before the reconcile — that pass edits core + all four surfaces, which is exactly when drift sneaks in. Guard before refactor.
  - [ ] **Surprise-capability test:** register a never-before-seen cap into a fresh registry → assert live + correct on all four surfaces with zero adapter edits. Cleanest positive proof of "no per-surface code."
- [ ] **In the reconcile pass (P0 — carries design decisions):**
  - [ ] **Promote the harness from `examples/todo` into `@facet/parity`**, parameterized over (registry, surfaces, cases); add the **raw `execute()` baseline leg**; extend the matrix to **validation / forbidden / not_found**.
  - [ ] **Mid-stream error contract — DESIGN, the keystone corner (not just a test):** define what each surface does when `executeStream` throws after chunk N (e.g. a terminal `error` frame carrying the FacetError code — HTTP SSE `event: error`, MCP final error, CLI stderr + nonzero exit, agent iterator throws), THEN assert cross-surface streaming parity (same ordered chunks + termination) for `logs.follow` / `todos.watch`.
  - [ ] Assert advertised-minus-merged(`confirm`/`idempotencyKey`) == enforced schema; flag `.refine()` cases. (Minor: the confirm/idempotencyKey merge is duplicated in `@facet/mcp` + `@facet/agent` — centralize.)
- [ ] **Then CI:** run test + typecheck + lint + tripwire on every PR; Bun first, Node/Deno via the portability matrix.

---

## P0 — freeze into the public contract BEFORE adopters exist

- [ ] **1. Schema contract → Standard Schema.** Type `defineCapability` `input`/`output` to `StandardSchemaV1` instead of `ZodType` (`define.ts`, `capability.ts`); `execute.ts` uses `await def.input['~standard'].validate(...)`. Keep a `SchemaAdapter` port (`toJsonSchema`) with a default Zod adapter (`z.toJSONSchema()`) for projection. Validation = any lib; projection ships Zod first. Do now (~3 capabilities); irreversible once in every downstream `.cap.ts`.
- [ ] **3. Sequence the streaming spike before 1.0.** Real streaming changes `execute()`'s return type (`Promise<O>` → async iterable + per-chunk validation) — breaking. Use Web Streams / async generators (native on Bun/Node/Deno; SSE works on all three server APIs).

---

## P1 — portability + table stakes before `npm i` works

- [ ] **2. Make the package run on Node 22+ and Deno (the "don't exclude" promise).**
  - Keep the **engine runtime-pure** (`execute`/`define`/`Registry`/errors/context already are — only `discover.ts` leaks via `import { Glob } from "bun"`).
  - **Portable discovery:** replace `Bun.Glob` with `tinyglobby` (pure JS, Bun+Node; Deno via npm:) or a pluggable discovery port; or move glob-discovery to an optional subpath so the engine imports clean everywhere.
  - **CI matrix: Bun + Node + Deno** running the engine tests — this is what *proves* "doesn't exclude Node/Deno" instead of just claiming it.
- [ ] **4. Build + publish story.** Compiled `.js` + `.d.ts`, proper `exports` map (per-runtime conditions if needed), `publint` + `arethetypeswrong` in CI. Currently ships raw `./src/index.ts`.

---

## P2 — hygiene, anytime

- [ ] **5. `biome migrate --write`** to clear config version drift. Keep Biome (dev-only). Add a narrow `typescript-eslint` pass later only if `noFloatingPromises`-class type-aware rules are wanted.
- Dev toolchain stays Bun (`bun:test`, install) — doesn't ship, so it doesn't affect the Node/Deno promise. (CI matrix above is what exercises the other runtimes.)

---

## Leave alone (already correct)

- **DB decoupling** — `Context.db` gone; `Ledger` is a pure port; handlers import their own domain. Keep persistence port-shaped.
- **tsconfig** — already `strict` + `noUncheckedIndexedAccess` + `isolatedModules` + bundler resolution.

## Open correctness note

- **Idempotency ledger must be atomic insert-once.** `execute.ts` does `lookup` → handler → `record` non-atomically, so concurrent same-key writes both run the handler. Protects sequential retries, not concurrent double-submit. When picking storage, require atomic insert-once (Postgres unique constraint / Redis `SET NX`); consider reshaping the port to `claim`/`commit`.

## Naming (open — see chat)

- Avoid "MMAPI / multi-modal API" ("multi-modal" = text/image/audio in AI land; "modal" collides). What you have is multi-**surface**. Vocabulary: **capabilities** (units) → **surfaces** (projections) → **capability host / server** (the runnable). The HTTP API is just one surface, so "API" undersells it.
