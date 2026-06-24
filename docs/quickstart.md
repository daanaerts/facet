# Facet quickstart

> Build your first capability and get it on HTTP, CLI, MCP, and agent.

---

## What Facet is

One capability definition. One chokepoint. Every surface.

You write a capability once — id, schemas, risk level, scopes, a handler — and `execute()` runs the same
seven-step pipeline for every surface that calls it. The surfaces (HTTP, CLI, MCP, agent) establish a
`Context` and translate errors. They validate nothing, authorize nothing, and share no implementation beyond
`@facet/core` and `@facet/surface-kit`.

---

## Two primitives

### `defineCapability` — unary

A unary capability takes validated input and returns a single output.

```ts
import { defineCapability } from "@facet/core";
import { z } from "zod";

export default defineCapability({
  id: "orders.place",           // dotted, lowercase, ≥2 segments — the one stable name on every surface
  summary: "Place an order.",
  input: z.object({
    sku: z.string(),
    qty: z.number().int().positive(),
  }),
  output: z.object({
    id: z.string(),
    total: z.number(),
  }),
  scopes: ["orders:write"],
  risk: "write",                // "read" | "write" | "destructive"
  reversible: false,            // optional — true=recoverable, false=permanent, omit=unspecified
  idempotent: true,             // a retry with the same idempotency key replays the stored result
  handler: async (input, ctx) => {
    // input is fully parsed and typed; ctx is the full Context
    ctx.audit("orders.placed", { sku: input.sku, qty: input.qty });
    return { id: "ord_123", total: input.qty * 9.99 };
  },
});
```

`risk` defaults to `"read"`. `idempotent` defaults to `true` for reads, `false` for writes. Export the
result as the file's default so `discoverCapabilities("**/*.cap.ts")` picks it up automatically.

### `defineStreamingCapability` — generator

A streaming capability yields incremental chunks and returns a terminal final value. It is always
`risk: "read"` by construction — streaming is a read idiom, so the confirmation and idempotency gates
never apply.

```ts
import { defineStreamingCapability } from "@facet/core";
import { z } from "zod";

export default defineStreamingCapability({
  id: "orders.watch",
  summary: "Stream orders as they arrive.",
  input: z.object({ since: z.string().optional() }),
  chunk: z.object({ id: z.string(), status: z.string() }),   // validated on every yield
  output: z.object({ count: z.number().int() }),              // validated once at the end
  scopes: ["orders:read"],
  async *handler(input, ctx) {
    yield { id: "ord_1", status: "new" };
    yield { id: "ord_2", status: "paid" };
    return { count: 2 };
  },
});
```

Every yield is validated against `chunk`; the return value is validated against `output`. A non-streaming
caller that calls `execute()` on a streaming capability gets the final value via an internal drain — no
per-surface streaming code needed.

---

## The execute() 7-step pipeline

Every surface calls `execute(registry, id, rawInput, ctx)`. The seven steps are invariant:

| Step | What it does |
|------|--------------|
| 1. **resolve** | Look the capability up in the registry. Throw `NotFoundError` if unknown, `KillSwitchError` if `enabled: false`. |
| 2. **validate** | Parse `rawInput` through the capability's own `input` schema (Standard Schema). Throw `ValidationError` if it fails. The surface never validates. |
| 3. **authz** | Enforce every declared scope via `ctx.requireScope(scope)`. Throw `ScopeError` (code `"forbidden"`, 403) for any missing scope. |
| 4. **confirm** | Gate `write` and `destructive` capabilities behind `ctx.confirm`. Throw `ConfirmationRequiredError` (code `"confirmation_required"`) when `ctx.confirm` is false. |
| 5. **idempotency** | For a non-read with an `idempotencyKey` and a `ctx.ledger`: atomically claim the key. A loser replays the winner's stored result and never runs the handler. |
| 6. **audit** | Record `actor + capability + surface` for every invocation via `ctx.audit()`. |
| 7. **run + check** | Execute the handler, then validate its output through the `output` schema before it leaves the core. An invalid output is `FacetError("internal", …, 500)`. |

`executeStream()` runs the same pipeline for streaming capabilities, with step 7 split into per-chunk
validation on every yield and final validation on the return.

---

## The host seam — buildContext

A surface calls `buildContext(opts)` once per request to assemble a `Context`. The required trio is
`actor` (who), `scopes` (what they may do), and `surface` (where from). Everything else is optional.

```ts
import { buildContext } from "@facet/core";

const ctx = buildContext({
  actor: { kind: "user", id: "u1", email: "alice@acme.example" },
  // or: { kind: "agent", agentId: "copilot-v2" }
  // or: { kind: "service" }
  scopes: ["orders:read", "orders:write"],
  surface: "agent",        // "agent" | "http" | "cli" | "mcp"
  confirm: true,           // surface-asserted confirmation (the "[Yes]" gate for writes)
  idempotencyKey: "req-abc-001",      // optional — present on writes you want deduped
  ledger: myLedger,        // optional — an object implementing claim/commit/read
  audit: (event, data) => console.log(event, data),   // optional — defaults to no-op
});
```

The `Ledger` port is three methods: `claim(key, capabilityId)` → `"won" | "lost"`, `commit(key, capId,
result)`, and `read(key, capId)` → stored result or `undefined`. Back it with a Postgres unique-constraint
insert, a Redis `SET NX`, or an in-memory `Map` for dev.

---

## Multi-tenant apps — the claims channel

The Facet engine has no notion of a tenant. Multi-tenancy is the host's job, folded into the host seam.
The clean pattern (new as of the claims API):

**1. Return claims from your authenticator**

Use `@facet/surface-kit`'s `AuthParts` to carry typed claims alongside scopes:

```ts
// auth.ts
import type { AuthParts } from "@facet/surface-kit";
import { scopedLedger, sharedLedger } from "./ledger";

export function authPartsFor(workspaceId: string, userId: string): AuthParts {
  return {
    actor: { kind: "user", id: userId, email: `${userId}@example.com` },
    scopes: [`workspace:${workspaceId}`, "orders:read", "orders:write"],
    claims: { workspace: workspaceId },   // typed, opaque to the engine
    ledger: scopedLedger(sharedLedger, workspaceId),
  };
}
```

`claims` is carried onto `ctx.claims` by `contextFromParts`. The engine never reads it.

**2. Read claims in handlers**

```ts
import { requireClaim, claimOf } from "@facet/core";
// or equivalently: import { requireClaim, claimOf } from "@facet/surface-kit";

handler: async (input, ctx) => {
  // requireClaim — throws FacetError("unauthorized", 401) when absent
  const workspaceId = requireClaim<string>(ctx, "workspace");

  // claimOf — returns undefined when absent (non-throwing sibling)
  const role = claimOf<string>(ctx, "role");

  const orders = store.listOrders(workspaceId);
  return { orders };
},
```

`requireClaim<T>(ctx, key)` — use for any claim a handler structurally depends on. It throws
`FacetError("unauthorized", "missing required claim: <key>", 401)` if `ctx.claims` is unset or the key's
value is `undefined`. This fails loudly at the read rather than silently threading `undefined` downstream.

`claimOf<T>(ctx, key)` — use for optional claims. Returns `undefined` when `ctx.claims` is unset or the
key is absent.

Both are exported from `@facet/core` and re-exported from `@facet/surface-kit` so the write side
(`AuthParts.claims`) and read side live in one import.

**Why claims, not scopes?**

Scopes drive authz (`ctx.requireScope(scope)` gates entry). Claims carry typed context (`workspaceId`,
`role`, `planTier`) that handlers use to scope their data. Scanning `ctx.scopes` for a
`"workspace:acme"` prefix and slicing it was the pattern all ten dogfood hosts hand-wrote before the
claims API; it is fragile and stringly-typed. Claims are the sanctioned channel for "who, and in what
tenant/role."

---

## Risk and reversibility

`risk` drives the confirmation gate and the affordance on every surface:

- `"read"` — auto-runs everywhere, no confirmation.
- `"write"` — gated behind `ctx.confirm`. A surface asserts it from user intent.
- `"destructive"` — same gate; conventionally paired with an undo capability.

`reversible` (new, optional) adds a dimension `risk` alone cannot express:

```ts
defineCapability({
  id: "threads.archive",
  risk: "destructive",
  reversible: true,    // "move to trash" — can be undone
  // ...
});

defineCapability({
  id: "threads.delete",
  risk: "destructive",
  reversible: false,   // "permanently delete" — cannot be undone
  // ...
});
```

`reversible: true` signals recoverable; `false` signals permanent; omitting it leaves it unspecified. The
engine attaches no semantics to it — it gates nothing. It is surfaced alongside `risk` on the HTTP `/cap`
catalogue entry, on MCP tool annotations as `reversibleHint` (next to `destructiveHint`), and on the
agent toolset, so a surface or agent driver can calibrate its confirmation copy.

---

## Idempotency — and the no-ledger warning

For a `write` or `destructive` capability, an `idempotencyKey` + a `Ledger` in the context gives you
atomic dedup: the engine claims the key before running the handler, and every subsequent call with the
same key replays the stored result instead of re-running.

The engine dedupes only when `ctx.ledger` is provided. If a capability is `idempotent: true`, is called
with an `idempotencyKey`, but `ctx.ledger` is `undefined`, idempotency is silently inert — the handler
runs every time, and no error is thrown.

**A dev-only warning catches this misconfiguration.** When these three are all true:

- the capability is `risk !== "read"`,
- `idempotent: true`,
- the call carries an `idempotencyKey`,
- but `ctx.ledger` is `undefined`

the engine writes once to `stderr`:

```
[facet] capability "orders.place" is idempotent and was called with an idempotencyKey, but ctx.ledger is
undefined — idempotency is INERT (no dedup will happen). Wire a Ledger into the Context, or drop the
idempotencyKey. Silence with FACET_SILENCE_WARNINGS=1.
```

The warning fires at most once per capability id per process and is muted wholesale by setting
`FACET_SILENCE_WARNINGS=1` in the environment. Control flow is unchanged — the call still proceeds, just
un-deduped. The warning is a wake-up that the host forgot to wire a ledger, not a per-call diagnostic.

---

## Streaming — defineStreamingCapability and collectStream

### Driving a stream

```ts
import { executeStream } from "@facet/core";

const gen = executeStream(registry, "orders.watch", { since: "2024-01-01" }, ctx);

// Safe: for-await gives you the chunks...
for await (const chunk of gen) {
  console.log(chunk);
}
// ...but the final return value F is SILENTLY DROPPED by for-await.
```

**Footgun: `for await` drops the final value.** `executeStream` returns `AsyncGenerator<Chunk, Final>`. A
`for await` loop only sees the yielded chunks; the generator's return value — the terminal `Final` — is
silently discarded by the JavaScript iterator protocol. Three of ten dogfood implementations shipped a
wrong first version for exactly this reason.

### collectStream — keep both halves

```ts
import { collectStream, executeStream } from "@facet/core";

const gen = executeStream<OrderChunk, WatchSummary>(
  registry, "orders.watch", { since: "2024-01-01" }, ctx,
);

const { chunks, final } = await collectStream(gen);
// chunks: OrderChunk[]   — every yield, in order
// final:  WatchSummary   — the generator's return value, which for-await would have dropped
```

`collectStream<C, F>(gen)` drives the generator to completion via `.next()` (the only API that exposes the
return) and returns `{ chunks: C[]; final: F }`. It is a pure consumer — it runs no gates, validates
nothing (the core already did). A mid-stream throw propagates unchanged: the good chunks accumulated so
far are lost with the throw, exactly as the streaming contract specifies.

Use `collectStream` whenever you need the final value. Use `for await` when you only care about chunks and
are processing them live.

---

## Putting it together — a minimal registry and smoke

```ts
import {
  buildContext,
  collectStream,
  defineCapability,
  defineStreamingCapability,
  execute,
  executeStream,
  Registry,
} from "@facet/core";
import { requireClaim } from "@facet/surface-kit";
import { z } from "zod";

// 1. Define capabilities (normally in *.cap.ts files)
const placeOrder = defineCapability({
  id: "orders.place",
  summary: "Place an order.",
  input: z.object({ sku: z.string(), qty: z.number().int().positive() }),
  output: z.object({ id: z.string(), total: z.number() }),
  scopes: ["orders:write"],
  risk: "write",
  reversible: false,
  idempotent: true,
  handler: async (input, ctx) => {
    const workspace = requireClaim<string>(ctx, "workspace");
    return { id: `ord_${Date.now()}`, total: input.qty * 9.99 };
  },
});

const watchOrders = defineStreamingCapability({
  id: "orders.watch",
  summary: "Stream recent orders.",
  input: z.object({}),
  chunk: z.object({ id: z.string(), status: z.string() }),
  output: z.object({ count: z.number() }),
  scopes: ["orders:read"],
  async *handler(input, ctx) {
    const workspace = requireClaim<string>(ctx, "workspace");
    yield { id: "ord_1", status: "new" };
    return { count: 1 };
  },
});

// 2. Register
const registry = new Registry();
registry.register(placeOrder);
registry.register(watchOrders);

// 3. Build a context
const ctx = buildContext({
  actor: { kind: "user", id: "u1", email: "alice@acme.example" },
  scopes: ["orders:read", "orders:write"],
  surface: "agent",
  confirm: true,
  idempotencyKey: "smoke-001",
  // ledger: myLedger,   // omit in dev; wire a real one for idempotency
  claims: { workspace: "ws_acme" },
  audit: (event, data) => console.log("[audit]", event, data),
});

// 4. Execute
const order = await execute(registry, "orders.place", { sku: "WIDGET", qty: 3 }, ctx);

// 5. Stream — use collectStream to capture the final value
const gen = executeStream<{ id: string; status: string }, { count: number }>(
  registry, "orders.watch", {}, ctx,
);
const { chunks, final } = await collectStream(gen);
console.log(chunks, final);
```

---

## Surfaces — one registry, four projections

All four surfaces share the same registry; capability definitions require no per-surface code.

| Surface | Package | What it does |
|---------|---------|--------------|
| **agent** | `@facet/agent` | In-process toolset for an LLM driver. `agentToolset(registry)` → tool specs; `dispatchToolCall` → `execute()`. |
| **http** | `@facet/http` | `createFetchHandler(registry, { auth })` → a fetch-compatible request handler. Routes `/cap` (catalogue), `GET /cap/:id` (describe), `POST /cap/:id` (execute), `GET /cap/:id/stream` (SSE). |
| **cli** | `@facet/cli` | `runCli(registry, { auth })` → `bun run cli.ts <id> [args…]`. Renders chunks to stdout, errors to stderr. |
| **mcp** | `@facet/mcp` | `createMcpServer(registry, { auth })` → a stdio MCP server. Each capability becomes a tool; streaming capabilities emit progress notifications. |

Every surface uses `@facet/surface-kit` — specifically `contextFromParts` — to turn the host's
`AuthParts` (actor + scopes + ledger + claims + connector) plus the surface's own per-call fields (confirm,
idempotencyKey, surface kind) into a `Context`. The surface kind is set only by the surface itself,
never by the host.

---

## Example apps to learn from

Five complete, runnable apps live under `examples/`. Each is built on one registry of `*.cap.ts` capabilities
projected onto all four surfaces with **zero per-surface code**, has its own README with copy-paste commands,
and ships a `headless.test.ts` (the chokepoint with a bare Context) plus a `parity.test.ts` (the same call
agrees across execute · agent · cli · http · mcp). They are deliberately layered so each teaches **one** axis:

| Example | Teaches | Port shown (in-memory default + real adapter) |
|---|---|---|
| `examples/todo` | the baseline: one capability set, all four surfaces, streaming | SQLite store |
| `examples/logs` | an unrelated domain (logs + jobs); mid-stream error parity | in-memory store |
| `examples/saas` | **multi-tenancy** via `ctx.claims` (`requireClaim`/`claimOf`), per-tenant `scopedLedger`, tenant isolation | **auth**: in-memory token map → real HS256 JWT (Web Crypto) |
| `examples/billing` | **money**: the `reversible` flag, the destructive-refund wedge, idempotency-as-safety | **payments**: in-memory → real Stripe over `fetch` |
| `examples/outbox` | **external systems** via the `ctx.connector` port, with loud `connector_unavailable` | **connectors**: in-memory → real Resend / GitHub |

Each "real adapter" ships alongside an in-memory default selected by env or one constructor argument, so the
whole suite runs hermetically (`bun test`) while the real integration is present, typed, and one line away. The
in-memory default is what `bun run` and the test suite use; the real adapter is what production wires.

---

## Consumption recipe — source paths + Bun

The packages are currently `private: true` and export raw TypeScript. Consume them straight from source via
`tsconfig` paths:

```jsonc
// tsconfig.json
{
  "compilerOptions": {
    "paths": {
      "@facet/core":        ["../../facet/packages/core/src/index.ts"],
      "@facet/surface-kit": ["../../facet/packages/surface-kit/src/index.ts"],
      "@facet/http":        ["../../facet/packages/http/src/index.ts"],
      "@facet/cli":         ["../../facet/packages/cli/src/index.ts"],
      "@facet/mcp":         ["../../facet/packages/mcp/src/index.ts"],
      "@facet/agent":       ["../../facet/packages/agent/src/index.ts"]
    }
  }
}
```

Run everything with Bun — it resolves the paths and runs TypeScript directly with no build step:

```bash
bun run smoke.ts
bun run cli.ts orders.place --sku WIDGET --qty 3 --yes
```

For the published-package story (ESM build, `exports` map, Changesets versioning), see
[docs/PUBLISHING.md](./PUBLISHING.md).

---

## Quick reference — new API (recent additions)

| Export | Module | Signature |
|--------|--------|-----------|
| `requireClaim` | `@facet/core`, `@facet/surface-kit` | `requireClaim<T>(ctx, key): T` — throws 401 when absent |
| `claimOf` | `@facet/core`, `@facet/surface-kit` | `claimOf<T>(ctx, key): T \| undefined` — non-throwing |
| `collectStream` | `@facet/core` | `collectStream<C, F>(gen): Promise<{ chunks: C[]; final: F }>` |
| `reversible` | `@facet/core` (CapabilitySpec / CapabilityDef) | `reversible?: boolean` — signal distinct from risk |
| `FACET_SILENCE_WARNINGS` | env var | any truthy value mutes the inert-idempotency stderr warning |
