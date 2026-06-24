import { createFetchHandler } from "@facet/http";
import { saasAuthenticate } from "./host";
import { saasRegistry } from "./registry";

/**
 * The multi-tenant app projected onto HTTP (`bun run examples/saas/serve.ts`, port 3003 / `PORT`). The tenant
 * rides in the `Authorization: Bearer <token>` header — a different token is a different workspace, isolated
 * end to end. With no header it defaults to the dev tenant (`acme`) so the curls below need no ceremony.
 *
 *   curl localhost:3003/cap                                            # the catalogue (four capabilities)
 *   curl -X POST localhost:3003/cap/projects.list -d '{}' \
 *        -H 'content-type: application/json'                           # → acme's projects (the dev default)
 *   curl -X POST localhost:3003/cap/projects.list -d '{}' \
 *        -H 'content-type: application/json' \
 *        -H 'authorization: Bearer tok_globex_admin'                  # → globex's projects — a DIFFERENT set
 *   curl -i -X POST localhost:3003/cap/projects.delete -d '{"id":"proj_1"}' \
 *        -H 'content-type: application/json'                          # → 409 confirmation_required (the wedge)
 *   curl -X POST localhost:3003/cap/projects.delete -d '{"id":"proj_1"}' \
 *        -H 'content-type: application/json' -H 'x-facet-confirm: true' # admin + confirm → deleted
 *
 * To run against REAL auth, swap the one argument below for the JWT adapter and mint a signed token:
 *   import { jwtAuthenticator } from "./auth";
 *   authenticate: saasAuthenticate({ auth: jwtAuthenticator(process.env.SAAS_JWT_SECRET!) })
 * `jwtAuthenticator` is a real Web-Crypto HS256 verifier (see auth.ts); a production host points it at its
 * provider (Clerk / Auth0 / a JWKS endpoint) with no change downstream.
 */

const port = Number(process.env.PORT ?? 3003);
const handler = createFetchHandler(saasRegistry(), { authenticate: saasAuthenticate() });

const server = Bun.serve({ port, fetch: handler });

console.log(`saas (multi-tenant) HTTP surface on http://${server.hostname}:${server.port}`);
console.log("  GET  /cap                          — the http catalogue");
console.log("  POST /cap/:id                      — run a capability");
console.log(
  "  Authorization: Bearer <token>      — selects the workspace (tok_acme_admin | tok_globex_admin | …)",
);
