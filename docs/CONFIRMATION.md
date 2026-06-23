# Confirmation — the per-surface idiom

> Status: **normative**. How `risk` + `confirm` are meant to be asserted on each surface.
> Source decision: facet-demo/review.md **F16** ("the propose→confirm round-trip is agent/CLI-shaped; a human
> GUI should not trip it").

## The invariant (the same on every surface)

A capability declares a `risk`: `read` auto-runs; `write` and `destructive` are **confirmation-gated**. The
gate lives in the one chokepoint — `execute()` step 4 — and fires identically no matter which surface called:

```ts
if (def.risk !== "read" && !ctx.confirm) throw new ConfirmationRequiredError(id, def.risk);
```

A handler never checks this; a surface never re-implements it. What differs per surface is **how `ctx.confirm`
gets set** — i.e. how that surface *asserts* the caller's intent to proceed.

## The thing to get right

**`confirm` is a fact each surface asserts in its own idiom, from user/caller intent — NOT a round-trip to
perform.** The "fire without confirm → read `confirmation_required` → re-send with `confirm: true`" two-step
is the **agent** idiom. It is wrong for a human GUI (no real web app does *submit → "please confirm" → submit
again*) and unnecessary for the CLI. `confirmation_required` is the engine's **safety net** — the error a
surface gets when it *forgot* to assert intent — never the happy path for a human.

The trap: "every surface is a projection of the same capability" actively invites you to project the agent
handshake into the GUI, where it does not belong. The **gate** is uniform; the **idiom** is per-surface.

## Per-surface idiom

| Surface | How it asserts `confirm` | Notes |
| --- | --- | --- |
| **HTTP / GUI** | The user action asserts it. An ordinary **write**: the button click / form submit *is* the confirmation → send `x-facet-confirm: true` **with the action**. A **destructive** action: a client-side "are you sure?" gated on the `risk` the catalogue advertises, then send the header. | A raw HTTP client likewise sends the header on the request. The GUI never round-trips through `confirmation_required` — see `examples/todo/public/console.html`. |
| **CLI** | `--yes` asserts it. | A destructive command may additionally prompt, but `--yes` *is* the assertion; there is no re-run. |
| **MCP / agent** | **The propose→confirm two-step** — and this is where it belongs. The model calls **without** `confirm` (or with `confirm: false`) → gets `confirmation_required` → a human approves → the driver re-calls with `confirm: true`. | The LLM proposes; a human disposes. The two-step *is* the value here: a typed pause for human-in-the-loop, modelled in the schema, not coded in the surface. |

## The GUI rule, concretely

A human GUI gates from `risk` (already on every catalogue entry), client-side:

- `read` → run.
- `write` → the Run/Save click is the confirmation; send `x-facet-confirm: true`.
- `destructive` → a client-side "are you sure?" (a dialog, a typed-name guard, an undo window…) → then send
  `x-facet-confirm: true`.

`confirmation_required` coming back to a GUI means a bug (the surface didn't assert intent) — render it as an
error, don't turn it into a "click again" step.

## Why defense-in-depth still holds

Asserting `confirm` client-side does **not** weaken anything: the chokepoint still enforces scopes, validation,
idempotency and the gate itself server-side. A GUI that sends `x-facet-confirm: true` for a capability the
caller lacks the scope for still gets `forbidden` from `execute()` — confirmation is *consent to proceed*, not
*authority to*. The two are orthogonal and both live in the core.
