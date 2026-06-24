# billing — money on Facet, where the wedge bites hardest

A real, runnable **payments** app on `@facet/core` — charges, refunds, and an export tape — projected onto
**all four surfaces** from **one** set of typed capabilities, with **zero per-surface code**. This is the
canonical "agent touches money" demo: the persona the validation plan targets (apps where an ungated agent
write is unacceptable), built so the **confirmation wedge** and **idempotency-as-safety** are the whole point.

## What it teaches (the axis: `reversible` + money-safe idempotency)

| Concern | How it's done here |
|---|---|
| **`reversible` ≠ `risk`** | `payments.charge` is `risk: "write", reversible: true` (recoverable — you can refund it). `payments.refund` is `risk: "destructive", reversible: false` (money out the door, permanent). A surface uses the flag to calibrate its confirmation copy. |
| **The confirmation wedge** | A refund is gated by the chokepoint. Ask an agent to "refund $5000" → `confirmation_required`, on every surface, because the gate lives in `execute()` — not in any surface that might forget it. |
| **Idempotency as money-safety** | `charge` and `refund` are `idempotent: true`. A double-submitted refund (retry, double-click, an agent that re-fired the tool) carrying the same key **replays** the first result instead of refunding twice. The atomic `claim` is what stands between a network blip and a duplicate refund. |
| **A port with two adapters** | The payment gateway is a seam: an in-memory fake (the default, tested) and a **real** Stripe client over `fetch` with an Idempotency-Key header (see [`gateway.ts`](./gateway.ts)). Flip with one env var. |

## The capabilities

| id | risk | reversible | input | output |
|---|---|---|---|---|
| `payments.list` | read | — | `{}` | `{ payments: [...] }` |
| `payments.charge` | write | **true** | `{ amountCents, currency?, customer }` | the payment |
| `payments.refund` | destructive | **false** | `{ paymentId, amountCents? }` | the updated payment (409 over-refund, 404 unknown) |
| `payments.export` | read (**streaming**) | — | `{}` | one row per payment + running net, then `{ count, netCents }` |

Money is integer **cents** throughout — never floats. The gateway seeds two payments: `pay_1` ($49.99) and
`pay_2` ($5000.00), so "refund $5000" is a real button.

## HTTP — `serve.ts`

```bash
bun run examples/billing/serve.ts     # port 3004 (override with PORT)
```

```bash
curl localhost:3004/cap
curl -X POST localhost:3004/cap/payments.list -d '{}' -H 'content-type: application/json'

# the wedge: a refund WITHOUT confirm → 409 confirmation_required
curl -i -X POST localhost:3004/cap/payments.refund -d '{"paymentId":"pay_2"}' \
  -H 'content-type: application/json'

# confirmed → the money moves
curl -X POST localhost:3004/cap/payments.refund -d '{"paymentId":"pay_2"}' \
  -H 'content-type: application/json' -H 'x-facet-confirm: true'

# idempotency-as-safety: the SAME key replays the first refund instead of refunding twice
curl -X POST localhost:3004/cap/payments.refund -d '{"paymentId":"pay_1"}' \
  -H 'content-type: application/json' -H 'x-facet-confirm: true' -H 'x-facet-idempotency-key: r1'
curl -X POST localhost:3004/cap/payments.refund -d '{"paymentId":"pay_1"}' \
  -H 'content-type: application/json' -H 'x-facet-confirm: true' -H 'x-facet-idempotency-key: r1'
```

`payments.export` streams as SSE with `accept: text/event-stream`.

## CLI — `cli.ts`

```bash
bun run examples/billing/cli.ts payments.list
bun run examples/billing/cli.ts payments.charge --json '{"amountCents":2500,"customer":"cus_x"}'        # ✗ confirmation_required
bun run examples/billing/cli.ts payments.charge --json '{"amountCents":2500,"customer":"cus_x"}' --yes  # runs
bun run examples/billing/cli.ts payments.refund --json '{"paymentId":"pay_2"}' --yes                    # the wedge, confirmed
bun run examples/billing/cli.ts payments.refund --json '{"paymentId":"pay_1"}' --yes --key r1           # idempotent
bun run examples/billing/cli.ts payments.refund --json '{"paymentId":"pay_1"}' --yes --key r1           # replays — no double refund
bun run examples/billing/cli.ts payments.export                                                         # the tape
```

## MCP — `mcp.ts`

A stdio MCP server. `payments__refund` carries a required `confirm` field and is annotated `destructiveHint`
with `reversibleHint: false` — so a careful agent driver knows the refund is permanent before it even proposes
it. Call it without `confirm` → `confirmation_required`; re-call with `confirm: true` → it runs.

## Going to real Stripe

The default gateway is in-memory — perfect for `bun run` and the test suite, never shipped. The real adapter
ships alongside it: `stripeGateway(secretKey)` in [`gateway.ts`](./gateway.ts) talks to Stripe's REST API over
`fetch` with the secret key and an Idempotency-Key on writes, mapping Stripe's objects onto the same `Payment`
shape. The active gateway is chosen once, by env — set a **test-mode** key and the same handlers hit Stripe:

```bash
STRIPE_SECRET_KEY=sk_test_… bun run examples/billing/serve.ts
```

It requires a network and a secret, so — unlike the in-memory adapter — it is **not** exercised by the test
suite; it is the real adapter that ships beside the default. A network failure surfaces as
`connector_unavailable`; a Stripe 4xx as the matching FacetError.

## Tests

```bash
bun test examples/billing
```

- `tests/headless.test.ts` — the chokepoint with a **bare** Context: read, the `risk`/`reversible` metadata,
  charge gating + idempotency, the refund wedge, partial/full refunds, **refund idempotency (no double refund)**,
  over-refund `conflict`, unknown-payment `not_found`, and the streaming export.
- `tests/parity.test.ts` — cross-surface parity via `@facet/parity`: a confirmed `payments.charge` returns the
  **same** payment via execute · agent · cli · http · mcp, and all five refuse an unconfirmed charge with the
  **same** `confirmation_required` code. Money moves identically on every surface, or not at all.
