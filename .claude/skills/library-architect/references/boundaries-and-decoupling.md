# Boundaries & Decoupling

> Where the lines are drawn between the engine, the host, and the surfaces — and how to keep them
> from blurring. This is the "composable & orthogonal" file, and it's where a library's
> long-term health is won or lost. Pairs with checklist group 3.

A library decays when concepts leak across boundaries: the core starts knowing about a product, a
surface starts re-implementing the engine, the engine starts deciding policy that belongs to the
host. Each leak is invisible at first and expensive to reverse later. The discipline here keeps
the boundaries crisp.

---

## Ports & adapters (hexagonal architecture)

Alistair Cockburn's **hexagonal architecture** ("ports and adapters"): the core depends only on
**small interfaces it defines** (ports); concrete implementations (adapters) plug in from
outside. The core never imports a concretion. This is what makes a library both portable (swap
the adapter per environment) and testable (swap in a fake).

Facet's ports:

- **`Ledger`** (`ledger.ts`) — `claim` / `commit` / `read`. The engine needs *atomic
  insert-once dedup*; it does not need Postgres or Redis. The host supplies the adapter (a `UNIQUE`
  constraint, `SET NX`, or a `Map` for dev). Crucially, **the atomicity is the adapter's job** —
  the engine claims-then-commits and needs no lock of its own.
- **`SchemaAdapter`** (`schema-adapter.ts`) — `toJsonSchema`. The engine needs *a projector*; the
  default is Zod, but any lib can register one via `setSchemaAdapter`.
- **`audit`, `tracer`/`profiler` (planned)** — present ⇒ the engine emits; absent ⇒ one `if`, zero
  overhead (`TODO.md`).

**The test for a good port:** is the interface the *smallest verb set* the core actually needs,
named in the core's language (not the adapter's)? `Ledger` is three verbs, not "a database." When
a change wants to pull a concretion into the core, the recommendation is almost always: define a
3-method port, ship one default adapter, and depend on the port.

---

## The single chokepoint

The most important boundary in Facet is that **every call flows through exactly one function**,
`execute()` / `executeStream()` (`execute.ts:54`). The seven invariants — resolve, validate,
authz, confirm, idempotency, audit, run+output-check — live there once and *cannot be skipped*,
because there is no other path to a handler.

This buys two things at once:

1. **Correctness for free across surfaces.** Add a surface, and it inherits validation, authz,
   confirmation, and audit without writing any of them. A surface's *only* jobs are to build a
   `Context` and translate errors.
2. **The security wedge.** Because the gate is *structural* (not per-surface opt-in), an agent
   over MCP is gated exactly like a GUI click. The funded competitor gates only in its in-app
   loop and leaves the MCP `tools/call` path running destructive actions ungated — a hole Facet
   *can't* have, because there's one door (`docs/VALIDATION-PLAN.md`, the wedge).

**This is non-negotiable #1.** When a change proposes *any* path to a handler that doesn't pass
through the chokepoint — a "fast path", a surface that calls `def.handler` directly, a cache that
returns before authz — flag it as breaking the core invariant *and* the security property. The
surface-purity tripwire (`tests/surface-purity.test.ts`) exists to catch exactly this: it fails if
any surface validates, authorizes, or calls a handler itself.

---

## The carve: subtract host concepts

The single most instructive event in Facet's history is the **carve** — extracting the engine
from Moral Fabric. The finding (`README.md`, "Carve log"; `capability.ts` and `execute.ts` CARVE
NOTEs): the extraction was **mostly subtraction.** What had to go were *host/product concepts that
had leaked into a supposedly-generic core*:

| Leaked into core | Why it was a leak | Where it belongs |
|---|---|---|
| `Context.tenant` (required) | Multi-tenancy is a product's spine, not a capability concept | The host seam — fold into `scopes` + claims |
| `Installs` port + install-gating as `execute()` **step 1** | "Is this app installed for this tenant" is MF's app model | The host gates *before* calling `execute()` |
| `CapabilityDef.appId` | App-ownership from file paths is MF layout | A capability is owned by nothing but its `id` |
| `Context.db` (a Drizzle handle) | A specific datastore client | Handlers import their own domain modules |

**The lesson for every future change:** when the core reaches back for a concept that only makes
sense in *one kind of app*, that's a leak — push it to the host seam. And the deeper lesson:
**the best architecture changes are often subtraction.** MF's `execute()` had a hidden 8th step
(install-gating) in *front* of the documented 7; removing it didn't lose a feature, it revealed
the real engine. Before adding a step/field/concept, always ask the subtraction question first:
*can we get this by removing something, or by letting the host do it?*

> This is also why **non-negotiable #1** and the carve reinforce each other: every host concept
> you keep *out* of the chokepoint is one the chokepoint can't accidentally couple to.

---

## Host owns meaning; the engine owns mechanism

A clean boundary needs a clear answer to "who decides what this *means*?" Facet's answer:
**mechanism in the engine, policy/meaning in the host.**

- **Claims are opaque to the engine.** `ctx.claims` carries "who, and in what tenant/role"; the
  engine attaches **zero** semantics to it — it never reads claims (`claims.ts`). The host writes
  them (via `AuthParts`), handlers read them (`requireClaim`/`claimOf`). The engine provides the
  *channel*; the host provides the *meaning*. (Contrast the fragile pattern the carve replaced:
  ten hosts hand-slicing a `"workspace:"` prefix out of `scopes`.)
- **`reversible` gates nothing.** It's a typed signal the engine carries verbatim and acts on
  *not at all* (`capability.ts:32-41`); surfaces use it to calibrate confirmation copy ("move to
  trash" vs "permanently delete"). The engine refuses to invent policy from it.
- **`scopes`** are the one thing the engine acts on, and even then only mechanically
  (`requireScope`) — it never interprets what a scope *means*.

**Smell to flag:** a change where the engine starts *interpreting* host data — branching on a
claim value, attaching behavior to `reversible`, deriving tenancy. That's policy migrating into
mechanism. Recommend: keep the engine carrying the data and the host deciding on it.

---

## Orthogonality: pieces that combine without coupling

Orthogonal pieces can be understood and changed independently; coupled pieces force edits to
ripple. The Unix-philosophy test: each piece does one thing, and they compose through narrow,
stable seams.

Facet's orthogonality, and how it's *proven*:

- **Surfaces share nothing but `@facet/core` (+ `surface-kit`).** No surface imports another. You
  can adopt just the agent surface, or just HTTP, with no dead weight.
- **Adding a capability ripples to zero adapters.** The surprise-capability test
  (`tests/surprise-capability.test.ts`) registers a brand-new capability and asserts it's live and
  correct on all four surfaces with **zero** adapter edits. That's composition working: the
  surfaces are generic over the registry, branching only on generic shape (`def.stream`,
  `def.risk`) — **never on a capability id.**

> **The line to hold (the honest caveat).** "No per-surface code" is more precisely "no
> *capability-aware* per-surface code." Streaming did force a generic `if (def.stream)` rendering
> branch into every surface, plus surface-specific encodings (SSE, MCP progress) — but those
> branch on a *generic capability shape*, not on *which* capability. That's the right kind of
> adapter code. The bright line a change must not cross: **a surface branching on a specific
> capability id.** If a proposal needs that, the abstraction is leaking — reshape it.

---

## Worked example: "add a built-in cache to `execute()`"

> **Proposal:** cache read results inside `execute()` to speed up repeated calls.
>
> - **Chokepoint:** a cache that *returns before authz* would let a stale result skip the scope
>   check — breaking non-negotiable #1. A cache *after* authz is safer but still adds a step to
>   the one function whose simplicity is the whole point.
> - **Host owns meaning:** cache *policy* (TTL, keying, invalidation) is deeply app-specific —
>   that's meaning, and meaning belongs to the host.
> - **Boundary verdict:** don't put it in the chokepoint. Two clean options: (a) the host caches
>   *around* `execute()` (it owns `main()`); or (b) if it must be inside, model it as an optional
>   **`Cache` port** that the engine consults *after* authz/confirm, no-op by default — same shape
>   as `Ledger`. Recommend (a) first; (b) only if a real adopter needs cross-surface caching they
>   can't do at the call site.
