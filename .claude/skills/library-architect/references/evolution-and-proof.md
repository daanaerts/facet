# Evolution & Proof

> How a public library is allowed to change over time, and why every property it advertises must
> be mechanically proven rather than asserted. This is the "rigorous & honest" file. Pairs with
> checklist group 4.

A library's relationship with its adopters is a long one. The two ways to betray it are: (1)
**break** something they depend on, and (2) **claim** something that isn't true. This file is the
discipline against both.

---

## Accretion, not breakage

The foundational idea, from Rich Hickey's *Spec-ulation* keynote (2016): software should grow by
**accretion** (adding) and **relaxation** (requiring less / providing more), and should **never
break** (changing or removing the meaning of something that exists). His sharp framing:

- **Adding** a new function/field is fine — old callers are unaffected.
- **Relaxing** a requirement (accept a wider input) or **strengthening** a guarantee (return a
  narrower, more-defined output) is fine — old callers still hold.
- **Breaking** — removing a name, narrowing an accepted input, widening a returned output,
  changing a behavior — is *not* "a major version." It's **making a different thing and giving it
  the old name.** Renaming is breakage in disguise (a remove + an add).

So when this skill fires, **classify the change first**:

| Change | Class | Cost |
|---|---|---|
| New optional field, new export, new port-with-default | **Accretion** | Free — ship it |
| Accept a previously-rejected input; add a default that preserves old behavior | **Relaxation** | Free — ship it |
| Remove/rename an export or field; change a signature; change an error code or observable behavior | **Breakage** | A major version — a tax on *every* adopter |

The default recommendation is always: **find the accretive form of the change.** Most "breaking"
ideas have an additive sibling (a new function beside the old; a new optional field; a v2 export
path).

---

## Semver is a social contract over the *whole* observable surface

Semantic Versioning is the promise: patch = fixes, minor = additions, **major = breakage**. Two
things make it real:

- **The contract is types + runtime behavior + observable behavior** — not just signatures.
  Changing a default, an error code, an ordering, or timing can break someone (Hyrum's Law). Bump
  accordingly; a "minor" that changes behavior is a broken promise.
- **The import-compatibility rule** (Russ Cox, Go modules): *if an old package and a new package
  have the same import path, the new must be backward compatible with the old.* The corollary for
  Facet: when you truly must break, the honest move can be a **new name / new subpath**
  (`@facet/http` → `@facet/http/v2`, or a new export) rather than silently redefining the old one.

Major versions aren't free even when "allowed": every adopter must read a migration guide and do
work, and some won't — they'll pin the old version and fork the ecosystem. Treat a major bump as a
serious event to **batch and sequence**, not a routine release valve.

---

## Freeze the public contract *before* adopters exist

There is exactly one cheap moment to make a breaking decision: **before anyone depends on it.**
This is why Facet front-loaded its highest-stakes contract calls (`TODO.md` P0):

- **Standard Schema** had to land *before* adopters, because the validation type is in **every
  downstream `.cap.ts`**. Changing `input`/`output` from `ZodType` to `StandardSchemaV1` is free
  today (≈3 capabilities) and a catastrophic break once thousands of capability files exist.
- **Streaming** changed `execute()`'s effective return story (unary vs. async-generator with
  per-chunk validation) — a breaking shape change deliberately sequenced **before 1.0**.

The rule when this skill fires: **if the change will appear in every downstream capability file,
or in a type/return adopters build against, get it right *now*.** Pre-1.0 is the budget for
breaking moves — spend it deliberately, then stop. After 1.0, the same change costs a migration
for everyone.

---

## Additive-by-construction

Design new features so they *can't* break old users:

- **New fields optional, and ignored by the engine where possible.** `reversible?` is optional and
  the engine attaches no behavior to it (`capability.ts`) — every existing capability and surface
  is unaffected by its existence.
- **New defaults must reproduce old behavior.** If a default changes what existing code does, it's
  breakage wearing a default's clothes.
- **Additions shouldn't cost N edits.** The bar is the surprise-capability test: a new capability
  lights up everywhere with **zero** adapter edits (`tests/surprise-capability.test.ts`). If a
  proposed feature requires touching all four surfaces to add *one* thing, the abstraction is in
  the wrong place — that's an O(N) tax disguised as a feature. Reshape so it's O(1).

---

## Deprecation, when you must move on

You will occasionally need to retire something. Do it gracefully:

1. **Deprecate, don't delete.** Mark it (`@deprecated` JSDoc — it shows up in adopters' editors),
   keep it working for at least one major.
2. **Ship the replacement first**, so there's a migration target before the old path warns.
3. **Document the migration** in one place, with a before/after.
4. **Remove only on a major**, and say so in the changelog.

Changesets (`docs/PUBLISHING.md` §4) is the mechanism: one changeset per logical change, with the
major/minor/patch intent recorded *at authoring time* and a generated, adopter-readable changelog.
A public framework lives or dies on predictable changelogs.

---

## Prove it; don't assert it

This is the other half of honesty. **Every property Facet advertises must be enforced by a
mechanism, or it isn't true — it's a hope.** For a public framework, an unproven claim is both a
latent bug and a credibility risk the day an adopter finds the gap.

What Facet proves, and with what (the model to extend):

| Claim | Mechanism | File |
|---|---|---|
| "No capability-aware per-surface code" | Structural tripwire (scans surface dirs; fails on `safeParse`/`~standard`/`requireScope`/`.handler(`) | `tests/surface-purity.test.ts` |
| "A new capability works everywhere, zero edits" | Surprise-capability test | `tests/surprise-capability.test.ts` |
| "Every surface agrees: output, confirmation, error codes, ordered stream + termination" | The `@facet/parity` matrix incl. the **mid-stream-error** keystone | `packages/parity/`, `docs/STREAMING-CONTRACT.md` |
| "Runs on Node 22+ and Deno" | A Bun/Node/Deno CI matrix on the built output | *deferred* — `docs/PUBLISHING.md` §7 |
| "The install is correct" | `publint` + `@arethetypeswrong/cli` as a merge gate | *deferred* — `docs/PUBLISHING.md` §6 |

**When a change adds or relies on a property, the recommendation must include: what test makes
this true, and what would catch its regression?** If the answer is "nothing yet," say so plainly —
an honest "claimed but unproven (no CI yet)" beats a confident assertion. Note the gaps that still
exist (e.g. `advertise == enforce` is asserted by construction but not yet by an explicit test;
the runtime CI matrix is deferred to the human) rather than implying full coverage.

---

## Honest scope is a feature

The "rigorous & honest" bar applies to *claims about what the library does*, not just code:

- **Say what it does *not* do.** `docs/VALIDATION-PLAN.md` explicitly scopes v0: confirmation
  wedge mandatory, streaming a bonus, "pagination / partial-updates / optimistic writes
  **explicitly OUT** — do not claim them." Naming the boundary builds more trust than implying
  completeness, and it prevents an adopter from building on a feature that isn't really there.
- **Don't overclaim the wedge.** Lead with *divergence-correctness* (surfaces are projections),
  never "humans and agents get the exact same capabilities" — that line contradicts the
  extraction finding and sounds like a clone of the incumbent.
- **Record decisions so they aren't re-litigated.** The CARVE NOTEs in the source, the decisions
  log in `TODO.md`, and the memory files are this discipline. When a change reverses a recorded
  decision, that's not a casual edit — surface it as a reversal and make the case.

---

## Worked example: "we need to change `execute()`'s signature"

> **Proposal:** add a required `options` argument to `execute()`.
>
> - **Class:** changing an existing signature to add a *required* parameter is **breakage** — every
>   call site breaks.
> - **Accretive form?** Make it **optional** with a default that preserves today's behavior — now
>   it's accretion, free to ship. (Can the need be met by a field on the existing `Context`
>   instead of a new positional arg? Usually yes — that's even less surface.)
> - **Timing:** if it genuinely must be required and breaking, it belongs in the **pre-1.0
>   budget**, batched with any other breaking changes, not dribbled out.
> - **Proof:** whatever the new option does, what test asserts it — and does the parity matrix
>   still pass across all five legs?
> - **Recommendation:** optional param (or a `Context` field) with a behavior-preserving default;
>   add the test; ship as a minor. Reserve the signature break for a deliberate pre-1.0 batch only
>   if the additive form genuinely can't express it.
