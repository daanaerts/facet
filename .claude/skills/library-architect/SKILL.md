---
name: library-architect
description: >-
  The architect's lens for evolving Facet as a beautiful, wide-TAM public library.
  Use BEFORE any non-trivial architecture change — a public export/type/package, a
  dependency, a port/adapter, the execute() pipeline, the Context or capability shape,
  a new surface, or build/publish setup. Skip for plain bugfixes.
---

# Library Architect

You are about to change the **architecture of a public library**. Facet is not an app — it is
a thing other developers `npm i` and build their products on. That flips the cost of every
decision: a clumsy internal choice costs *you* a refactor; a clumsy *public* choice costs
*every adopter* a migration, forever. This skill is the lens an experienced library architect
applies so the change makes Facet **more adoptable and more beautiful, not less**.

This skill is **advisory**. When it fires: name the change, run the checklist, report the
impact on the two things that matter (TAM and the contract), then recommend the *smallest*
change that preserves both — and let the human decide. Push back with rationale; don't block.

---

## When this fires (and when it doesn't)

**Fires — this is architecture:**

- A new/renamed/removed **public export**, or a changed public **type or signature**.
- A new **dependency**, or moving something dep ↔ peer ↔ inlined.
- Touching the **`execute()` / `executeStream()` pipeline**, the **`Context`** shape,
  `CapabilityDef`/`CapabilitySpec`, the `Registry`, or the **error taxonomy**.
- Adding/changing a **port** (`Ledger`, `SchemaAdapter`, tracer) or an **adapter/surface**.
- **Build, exports map, module format, runtime targeting, publish config.**
- Anything that will end up in **every downstream `.cap.ts`**, or that an adopter imports.

**Doesn't fire — bugfix / cosmetic:**

- A logic fix *inside* a handler or adapter that changes **no signature and no observable
  public behavior**.
- Tests, comments, doc typos, formatting, internal refactors with zero public-surface change.

> ⚠️ The trap: a "bugfix" that changes **observable behavior an adopter could already depend
> on** is a contract change, not a bugfix — it fires. (Hyrum's Law: with enough users, *every*
> observable behavior is someone's contract.) When in doubt, it fires.

---

## The two questions every change must answer

Everything below is in service of these two. Lead your report with them.

1. **Does this widen or narrow the TAM?**
   TAM = the set of developers who can adopt Facet *without changing their stack*. Every forced
   choice (a runtime, a validation library, a web framework, a bundler, a dependency, an IoC
   container) subtracts from that set. Beautiful libraries are *subtractive about what they
   demand of you*.

2. **What does this add to the public contract that we can never take back?**
   Every export, type, field, default, and observable behavior is a forever-promise. The
   cheapest contract to keep is the one you never made. Prefer internal-first; export later.

---

## The beauty bar

A change should leave Facet stronger on all four (these are the qualities the project optimizes
for). Each line names the failure it guards against and a place Facet already gets it right.

| Quality | The bar | Guards against | Living example |
|---|---|---|---|
| **Small & deep** | Tiny public surface over a powerful engine; one obvious way to do each thing | Shallow wrappers, "classitis", API bloat | Two primitives (`defineCapability` + `execute`) front a 7-step engine — `define.ts`, `execute.ts:54` |
| **Composable & orthogonal** | Independent pieces that combine cleanly; no hidden coupling | A change in one piece forcing edits in N others | A surprise capability lights up on all four surfaces with **zero** adapter edits — `tests/surprise-capability.test.ts` |
| **Pit of success** | The easy path *is* the correct path; footguns are designed out | Correct usage requiring a doc you have to remember | `collectStream` exists because `for await` silently drops the final value — `execute-stream.ts` |
| **Rigorous & honest** | Typed contracts, explicit tradeoffs, scope stated plainly, invariants *proven* not asserted | Prose promises the tests don't keep; quiet failures | The surface-purity tripwire + `@facet/parity` matrix make "no per-surface code" mechanical |

---

## The checklist

Run these when the skill fires. Each group links to a reference for the full reasoning + canon.

### 1 · Surface & contract → `references/api-surface-and-contract.md`
- [ ] Is this the **smallest** public surface that does the job? One export instead of three? A
      parameter or a sensible default instead of a new function?
- [ ] Is every new export something we'll **support for years**? If unsure, keep it internal.
- [ ] Do **types carry the contract** end-to-end — full inference, no `any`/`as any` leaking to
      the caller?
- [ ] **One obvious way**, with defaults tuned so the common case needs no config?
- [ ] Are errors a **typed taxonomy** (codes), not strings?

### 2 · TAM & adoption friction → `references/tam-and-adoption.md`
- [ ] New dependency? Walk the ladder: **inline it → port with a default adapter → optional
      peer → hard dep (last resort, justify).**
- [ ] Does it **force the adopter's stack** — a validation lib, web framework, runtime, DB,
      bundler? If yes, you narrowed the TAM. Adapt to what they have.
- [ ] **Runtime-pure?** Any `from "bun"` / Node-only / Deno-hostile API in the *shipped* path
      must move behind a port with a portable default.
- [ ] Does the **install Just Work** — ESM-correct exports map, types resolving under
      node16/bundler, tree-shakeable? (`publint` + `attw`.)
- [ ] Library **call**, or does it **seize control** (IoC)? The host owns the entry point;
      adapters emit *mountable artifacts*, never own the process or router.

### 3 · Boundaries & decoupling → `references/boundaries-and-decoupling.md`
- [ ] Does the core **reach back for a host/product concept** (tenant, app, a specific DB
      handle)? That's a leak — push it to the host seam (claims / scopes / a port).
- [ ] Could this be **subtraction** instead of addition? The best architecture moves often
      *remove* a concept.
- [ ] Do invariants (validate / authz / confirm / idempotency / audit) stay in the **one
      chokepoint**, never re-implemented per surface?
- [ ] Does the engine **attach semantics it shouldn't**? Prefer "host owns meaning" (claims are
      opaque; `reversible` gates nothing).
- [ ] Is the new piece **orthogonal** — usable without dragging in the others?

### 4 · Evolution & proof → `references/evolution-and-proof.md`
- [ ] Is this change **accretive** (add) or **breaking** (change/remove a signature, type, or
      behavior)? Breaking changes are a tax on every adopter — sequence before 1.0, batch, or
      avoid.
- [ ] Are we **freezing something into the contract before adopters exist**? If it'll be in
      every downstream `.cap.ts`, get it right *now* (Standard Schema was exactly this).
- [ ] Claiming a property (no per-surface code, parity, runtime-purity)? Is it **enforced by a
      test/tripwire**, or only asserted in prose?
- [ ] New footgun? **Mitigate it in the API**, not a doc warning. If you can't, make the silent
      failure **audible** (the inert-idempotency warning).
- [ ] **Honest scope:** do the docs say what this does *not* do?

---

## Facet's non-negotiables

Decided, recorded, not to be re-litigated (see `TODO.md`, `docs/VALIDATION-PLAN.md`, and memory).
A change that touches one of these must say so explicitly and make the case loudly.

1. **The single `execute()` chokepoint is the security property.** Never add a path that runs a
   handler without flowing through it. (The competitor's MCP path runs destructive actions
   *ungated*; Facet's chokepoint makes that hole structurally impossible — that is the wedge.)
2. **Library + adapters, never IoC.** Adapters produce mountable artifacts (`createFetchHandler`
   → `(req) => Response`); Facet never owns your process or your router.
3. **No forced sibling tooling.** Validation via **Standard Schema** (not Zod); HTTP via a
   **portable fetch handler** (not a forced framework); **Bun-first but Node 22+ and Deno must
   run** the shipped engine.
4. **The risk taxonomy (`read`/`write`/`destructive`) + the confirmation gate is the wedge.**
   Don't dilute it.
5. **The engine has no tenant/app concept.** Multi-tenancy lives in the host seam (claims).
6. **Surfaces are *projections*, not clones.** Never pitch "humans and agents get the exact same
   capabilities" — *divergence-correctness* is the whole point.

---

## How to run the lens (the advisor flow)

1. **Name the change** in one line ("add `X` to `Context`", "depend on `Y`", "new step in
   `execute()`").
2. **Run the checklist.** Note every box that's at risk — don't perform all-green.
3. **Report** in this shape:
   - **TAM impact:** widens / neutral / narrows — and *who* it adds or excludes.
   - **Contract added:** the exact new forever-promise (export, type, field, behavior), or "none".
   - **Non-negotiable touched:** which, if any.
   - **Beauty bar:** which of the four it helps or hurts.
4. **Recommend the smallest change** that preserves the contract and the TAM. Always offer the
   **subtraction alternative** ("could we do this by removing something instead?") and the
   **defer alternative** ("keep it internal until an adopter needs it").

### Worked example (the flow in miniature)

> **Proposal:** "Add built-in rate limiting as a new step in `execute()`."
>
> - **TAM:** *narrows.* It bakes a policy every adopter must accept and forces a limiter
>   implementation (a clock, maybe a store) into the runtime-pure core.
> - **Contract added:** a new pipeline step + its config surface — a forever-promise about
>   *when and how* Facet throttles.
> - **Non-negotiable touched:** #1 (a new step in the chokepoint) and #5/#3 (policy in the core).
> - **Recommendation:** *don't* add a step. Rate limiting is a **host concern** (gate before
>   calling `execute()`) or at most an **optional port** with a no-op default — same shape as
>   `Ledger`. This is precisely how MF's install-gating once leaked in as a hidden 8th step; the
>   carve removed it. Subtraction-minded, TAM-neutral, contract-free.

---

## References

- `references/api-surface-and-contract.md` — minimal surface, deep modules, types-as-contract,
  errors-as-taxonomy, defaults, pit-of-success, footgun design, naming.
- `references/tam-and-adoption.md` — the dependency ladder, never forcing sibling tools, runtime
  portability, library-not-framework, and install correctness as TAM (`publint`/`attw`).
- `references/boundaries-and-decoupling.md` — ports & adapters, the carve/subtraction discipline,
  the single chokepoint, host-owns-meaning, orthogonality.
- `references/evolution-and-proof.md` — accretion-not-breakage, semver as contract, freeze
  before adopters, deprecation, and proving claims mechanically.
