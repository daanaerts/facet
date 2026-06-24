# API Surface & Contract

> The beauty of a library is mostly what it *doesn't* make you see. This file is about the
> public surface — keeping it small, deep, typed, and honest — so it stays both lovely to use
> and cheap to keep promising. Pairs with checklist group 1.

---

## Every export is a forever-promise

The contract is not your README. The contract is **everything an adopter can observe**: exports,
type shapes, field names, default values, error codes, ordering, even timing.

- **Hyrum's Law** (Hyrum Wright, *Software Engineering at Google*): *"With a sufficient number of
  users of an API, it does not matter what you promise in the contract — all observable
  behaviors of your system will be depended on by somebody."* The defense is not discipline from
  your users; it's **a smaller observable surface from you**.
- **"APIs are forever"** (Werner Vogels, AWS). AWS still serves its 2006 S3 API. Assume you
  will too. The cheapest promise to keep is the one you never made.

**The move:** export the minimum. Keep helpers, internal types, and "might be useful" utilities
*un-exported* until a real adopter need appears. You can always add later (accretion is free);
you can't remove without a major (breakage is a tax). Facet's `packages/core/src/index.ts` is a
deliberately short, curated barrel — read it as the *whole* contract of the core, because that's
what it is.

---

## Deep modules, not shallow ones

From John Ousterhout, *A Philosophy of Software Design*: a module's value is **interface
simplicity divided by implementation power**. A *deep* module hides a lot behind a little. A
*shallow* module (a wrapper that adds a layer without hiding complexity) is negative value — it's
more surface to learn and maintain for no abstraction gained. Ousterhout's name for the disease
of many tiny shallow classes/functions is **"classitis."**

Facet is deep on purpose:

- `execute(registry, id, rawInput, ctx)` is **one function** — behind it sits a 7-step pipeline
  (resolve → validate → authz → confirm → idempotency → audit → run+check; `execute.ts:54`).
- `defineCapability(spec)` is **one call** — behind it sits id validation, default resolution,
  and the type machinery that infers the handler's input/output from the schemas (`define.ts`).

**Smell to flag:** a proposed export that's a thin pass-through to another export, or a new
function that only reorders/forwards arguments. Ask: does this *hide* complexity, or just *add a
name* for it? If the latter, it's classitis — push back.

---

## Types are the contract

For a TypeScript library, the types *are* the API documentation that can't go stale, and the
first thing an adopter feels. Hold the bar:

- **Full inference, no leaks.** The author writes schemas; the handler's `input`/`output` types
  should follow with zero annotations. Facet threads `StandardSchemaV1.InferOutput<I>` /
  `InferInput<O>` from the spec into the handler signature (`define.ts:37-41`) — the author
  never restates a type. A single `any` or an `as any` that surfaces to the caller breaks this
  and is worth blocking.
- **Make illegal states unrepresentable.** Prefer a union or a discriminated type over a runtime
  check + a comment. `Risk = "read" | "write" | "destructive"` (`capability.ts:12`) means an
  invalid risk *can't be typed*, not "is rejected at runtime."
- **Don't make the engine generic where the host owns the meaning.** `Context` is deliberately
  *not* generic over its claims — that would ripple a type parameter through the whole engine.
  Instead the caller names the type at the read site: `requireClaim<string>(ctx, "workspace")`
  (`claims.ts`). Generic-where-it-pays, concrete-where-it-doesn't is a taste call worth making
  explicitly.

---

## Errors are a typed taxonomy, not strings

Two moves, both from the "rigorous & honest" bar:

1. **Define errors out of existence** (Ousterhout) where you can — design the API so the error
   *can't* arise. Streaming capabilities are `risk: "read"` *by construction*
   (`capability.ts`), so "what if someone streams a destructive op?" is not a runtime branch; it
   is an unrepresentable state.
2. **Where an error is real, make it a typed code, not a message.** Facet's `FacetError` family
   carries stable codes (`validation`, `forbidden`, `not_found`, `confirmation_required`,
   `conflict`, `unauthorized`, `internal`; `errors.ts`). Codes are part of the contract — every
   surface renders the *same* code (asserted by `@facet/parity`). A string message is for humans
   and may change; a code is for programs and may not.

**Fail loud over fail silent.** `requireClaim` throws a typed 401 the moment a required claim is
missing, rather than threading `undefined` downstream to fail somewhere confusing later
(`claims.ts`). When you add a field a handler will depend on, give it a loud, typed accessor.

---

## Defaults and the pit of success

The phrase **"pit of success"** comes from the .NET framework-design culture (Rico Mariani): a
well-designed library makes the easy, obvious path the *correct* one, so users "fall into"
working code. The opposite — a "pit of despair" — is an API that's easy to misuse and only
correct if you read the docs carefully.

Tune defaults so the 80% case needs no configuration:

- `risk` defaults to `"read"` (the safe, common case); `idempotent` defaults to `true` for
  reads and `false` for writes; `surfaces` defaults to all; `enabled` to `true`
  (`define.ts:59-71`). The minimal capability is just `id` + `summary` + `input`/`output` +
  `handler`.
- Defaults are **part of the contract** — changing one is a behavior change (Hyrum). Choose them
  as carefully as signatures.

---

## Footguns: design them out, or make them audible

A footgun documented is still a footgun. The hierarchy, best to worst:

1. **Design it out** — make the wrong thing impossible (types, construction).
2. **Make the right thing the default** — pit of success.
3. **Make the failure audible** — if it must be possible and silent, emit a one-time, mutable
   warning so a misconfiguration can't masquerade as success.
4. **Document it** — the weakest mitigation; use only when 1–3 are impossible.

Both live in Facet:

- `for await` over an async generator **silently drops the generator's return value** — a JS
  language footgun that bit 3 of 10 dogfood implementations. The fix is an *API*, not a doc:
  `collectStream(gen)` returns `{ chunks, final }` so the final can't be lost
  (`execute-stream.ts`). That's level 1–2.
- An `idempotent` capability called with a key but **no ledger** degrades silently to
  non-idempotent. It can't always be designed out (the ledger is the host's to wire), so the
  engine makes it **audible**: a one-time-per-id `stderr` warning, muted by
  `FACET_SILENCE_WARNINGS` (`execute.ts:26-35`). That's level 3 done right — control flow
  unchanged, silence made loud.

When a change introduces a way to "hold it wrong," your recommendation should climb this ladder,
not jump to "we'll note it in the docs."

---

## Naming is part of the contract

Names ship forever, same as signatures (Rich Hickey, *Spec-ulation*: renaming is breakage
wearing a friendly face — it's removal + addition). So:

- **One stable name per concept, everywhere.** A capability's `id` (dotted, lowercase, ≥2
  segments; `ID_RE` in `define.ts:8`) is *the* name on HTTP, CLI, MCP, and the agent. There is
  no per-surface alias to drift.
- Name by **what it is to the caller**, not how it's built (`createFetchHandler`, not
  `buildElysialessWebRequestRouter`).
- Renaming an export later costs a major version. Get it right, or keep it internal until you're
  sure.

---

## Worked example: "should this be a new top-level export?"

> **Proposal:** add `formatAuditEvent(event)` to `@facet/core`'s public exports.
>
> - **Smallest surface?** Is it needed by *adopters*, or only by Facet's own surfaces? If
>   internal, don't export — keep it in the module and out of the contract.
> - **Deep?** It's a formatting helper — shallow by nature. A shallow helper in the public
>   barrel is classitis unless adopters genuinely need exactly this shape.
> - **Forever-promise?** Once exported, its output string format is a Hyrum-contract someone will
>   parse. That's a heavy promise for a convenience function.
> - **Recommendation:** keep it internal. If an adopter asks, expose the *data* (a typed event
>   object) rather than a *formatted string* — data is a cleaner, more stable contract than
>   formatting.
