import { createLogsHttpApp } from "./http";

/**
 * Serve the `logs` HTTP app on a real port for human play (`bun run examples/logs/serve.ts`). Listens on
 * `PORT` (default 3001). This is the only file that binds a socket — `http.ts` exports the app itself so
 * tests drive it headlessly with `app.handle(new Request(...))`, no port and no real fetch.
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

createLogsHttpApp().listen(port, ({ hostname, port }) => {
  console.log(`logs HTTP surface listening on http://${hostname}:${port}`);
  console.log("  GET  /health");
  console.log("  GET  /cap            — the http catalogue");
  console.log("  GET  /cap/:id        — one capability's entry");
  console.log(
    "  POST /cap/:id        — run a capability (x-facet-confirm / x-facet-idempotency-key)",
  );
});
