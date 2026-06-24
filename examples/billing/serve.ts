import { createFetchHandler } from "@facet/http";
import { devAuthenticate } from "./host";
import { billingRegistry } from "./registry";

/**
 * The billing app projected onto HTTP (`bun run examples/billing/serve.ts`, port 3004 / `PORT`). The wedge is
 * sharpest here — a refund is `destructive` AND `reversible: false`, so an unconfirmed refund is refused:
 *
 *   curl localhost:3004/cap                                              # the catalogue (four capabilities)
 *   curl -X POST localhost:3004/cap/payments.list -d '{}' \
 *        -H 'content-type: application/json'
 *   curl -i -X POST localhost:3004/cap/payments.refund -d '{"paymentId":"pay_2"}' \
 *        -H 'content-type: application/json'                            # → 409 confirmation_required (the wedge)
 *   curl -X POST localhost:3004/cap/payments.refund -d '{"paymentId":"pay_2"}' \
 *        -H 'content-type: application/json' -H 'x-facet-confirm: true' # confirmed → refunded
 *   # idempotency — the SAME key replays the first refund instead of refunding twice
 *   curl -X POST localhost:3004/cap/payments.refund -d '{"paymentId":"pay_1"}' \
 *        -H 'content-type: application/json' -H 'x-facet-confirm: true' -H 'x-facet-idempotency-key: r1'
 *   curl -X POST localhost:3004/cap/payments.refund -d '{"paymentId":"pay_1"}' \
 *        -H 'content-type: application/json' -H 'x-facet-confirm: true' -H 'x-facet-idempotency-key: r1'
 *
 * Default runs on the in-memory gateway. Set `STRIPE_SECRET_KEY` (a TEST-mode key) to hit real Stripe with the
 * SAME handlers — see gateway.ts.
 */

const port = Number(process.env.PORT ?? 3004);
const handler = createFetchHandler(billingRegistry(), { authenticate: devAuthenticate() });

const server = Bun.serve({ port, fetch: handler });

console.log(`billing HTTP surface on http://${server.hostname}:${server.port}`);
console.log("  GET  /cap                     — the http catalogue");
console.log(
  "  POST /cap/:id                 — run a capability (x-facet-confirm / x-facet-idempotency-key)",
);
console.log(`  gateway: ${process.env.STRIPE_SECRET_KEY ? "Stripe (real)" : "in-memory (dev)"}`);
