import { createHttpApp } from "@facet/http";
import { devAuthenticate } from "./host";
import { todoRegistry } from "./registry";

/**
 * The todo app projected onto HTTP, served on a real port for human play
 * (`bun run examples/todo/serve.ts`). Listens on `PORT` (default 3002). This is the only todo file that binds
 * a socket — the registry + host seam are what the surface needs, and `createHttpApp` does the rest. Tests
 * build their own app with `createHttpApp(todoRegistry(), …)` and drive it headlessly via `app.handle(...)`,
 * so no port and no real fetch are needed there.
 *
 * Try it once running (see README for the full set):
 *   curl localhost:3002/cap                                  # the http catalogue (five capabilities)
 *   curl -X POST localhost:3002/cap/todos.list -H 'content-type: application/json' -d '{}'
 *   curl -X POST localhost:3002/cap/todos.add  -H 'content-type: application/json' \
 *        -H 'x-facet-confirm: true' -d '{"title":"ship it"}'
 */

const port = Number(process.env.PORT ?? 3002);

createHttpApp(todoRegistry(), { authenticate: devAuthenticate() }).listen(
  port,
  ({ hostname, port }) => {
    console.log(`todo HTTP surface listening on http://${hostname}:${port}`);
    console.log("  GET  /health");
    console.log("  GET  /cap            — the http catalogue");
    console.log("  GET  /cap/:id        — one capability's entry");
    console.log(
      "  POST /cap/:id        — run a capability (x-facet-confirm / x-facet-idempotency-key)",
    );
  },
);
