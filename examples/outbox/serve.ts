import { createFetchHandler } from "@facet/http";
import { devAuthenticate } from "./host";
import { outboxRegistry } from "./registry";

/**
 * The outbox app projected onto HTTP (`bun run examples/outbox/serve.ts`, port 3005 / `PORT`). Writes have an
 * external, irreversible effect, so they are confirmation-gated:
 *
 *   curl localhost:3005/cap
 *   curl -X POST localhost:3005/cap/messages.list -d '{}' -H 'content-type: application/json'
 *   curl -i -X POST localhost:3005/cap/email.send \
 *     -d '{"to":"cust@acme.example","subject":"Hi","body":"Hello"}' \
 *     -H 'content-type: application/json'                                  # → 409 confirmation_required
 *   curl -X POST localhost:3005/cap/email.send \
 *     -d '{"to":"cust@acme.example","subject":"Hi","body":"Hello"}' \
 *     -H 'content-type: application/json' -H 'x-facet-confirm: true'       # confirmed → sent (provider: memory)
 *
 * Default uses the in-memory connectors. Set `RESEND_API_KEY` / `GITHUB_TOKEN` and wire the real adapters in
 * `host.ts` to deliver for real with the SAME handlers — see connectors.ts.
 */

const port = Number(process.env.PORT ?? 3005);
const handler = createFetchHandler(outboxRegistry(), { authenticate: devAuthenticate() });

const server = Bun.serve({ port, fetch: handler });

console.log(`outbox HTTP surface on http://${server.hostname}:${server.port}`);
console.log("  GET  /cap                     — the http catalogue");
console.log(
  "  POST /cap/:id                 — run a capability (x-facet-confirm / x-facet-idempotency-key)",
);
