import { createLogsFetchHandler } from "./http";

/**
 * Serve the `logs` HTTP surface on a real port for human play (`bun run examples/logs/serve.ts`). Listens on
 * `PORT` (default 3001). This is the PORTABLE path: it mounts Facet's framework-agnostic Web fetch handler in
 * `Bun.serve({ fetch })` — the exact same `createLogsFetchHandler()` would mount under `Deno.serve(...)` or on
 * Node via a tiny WinterCG adapter, with no web framework in between. `http.ts` exports the handler itself so
 * tests drive it headlessly with `handler(new Request(...))`, no port and no real fetch.
 *
 * Try it once running:
 *   curl localhost:3001/health
 *   curl localhost:3001/cap                                  # the http catalogue
 *   curl -X POST localhost:3001/cap/logs.tail -H 'content-type: application/json' -d '{"source":"build"}'
 *   curl -X POST localhost:3001/cap/jobs.start -H 'content-type: application/json' -d '{"name":"nightly"}'
 *     → 409 confirmation_required
 *   curl -X POST localhost:3001/cap/jobs.start -H 'content-type: application/json' \
 *        -H 'x-facet-confirm: true' -d '{"name":"nightly"}'   # now it runs
 */

const port = Number(process.env.PORT ?? 3001);

const server = Bun.serve({ port, fetch: createLogsFetchHandler() });

console.log(`logs HTTP surface listening on http://${server.hostname}:${server.port}`);
console.log("  GET  /health");
console.log("  GET  /cap            — the http catalogue");
console.log("  GET  /cap/:id        — one capability's entry");
console.log(
  "  POST /cap/:id        — run a capability (x-facet-confirm / x-facet-idempotency-key)",
);
