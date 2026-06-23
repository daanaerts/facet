import { createFetchHandler } from "@facet/http";
import { devAuthenticate } from "./host";
import { todoRegistry } from "./registry";

/**
 * The todo app projected onto HTTP, served on a real port for human play (`bun run examples/todo/serve.ts`).
 * Listens on `PORT` (default 3002). This is the PORTABLE path: `createFetchHandler` returns Facet's
 * framework-agnostic Web `(req) => Promise<Response>`, mounted directly in `Bun.serve({ fetch })` — the same
 * handler would mount under `Deno.serve(...)` or on Node via a WinterCG adapter, with no web framework between
 * the socket and Facet. Tests build their own handler with `createFetchHandler(todoRegistry(), …)` and drive it
 * headlessly via `handler(new Request(...))`, so no port and no real fetch are needed there.
 *
 * Try it once running (see README for the full set):
 *   curl localhost:3002/cap                                  # the http catalogue (five capabilities)
 *   curl -X POST localhost:3002/cap/todos.list -H 'content-type: application/json' -d '{}'
 *   curl -X POST localhost:3002/cap/todos.add  -H 'content-type: application/json' \
 *        -H 'x-facet-confirm: true' -d '{"title":"ship it"}'
 */

const port = Number(process.env.PORT ?? 3002);

// The portable Facet HTTP surface — the framework-agnostic Web handler that owns /health, /cap and /cap/:id.
const apiHandler = createFetchHandler(todoRegistry(), { authenticate: devAuthenticate() });

// A generic capability CONSOLE: a single static page that reads GET /cap and auto-renders one form per
// capability. It is itself just another PROJECTION of the registry — nothing in it is todo-specific, so the
// same file drops onto any Facet app. Served at `/`; everything else falls through to the API handler.
const consoleHtml = Bun.file(`${import.meta.dir}/public/console.html`);

const server = Bun.serve({
  port,
  fetch(req) {
    const { pathname } = new URL(req.url);
    if (req.method === "GET" && (pathname === "/" || pathname === "/console")) {
      return new Response(consoleHtml, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    return apiHandler(req);
  },
});

console.log(`todo console + HTTP surface on http://${server.hostname}:${server.port}`);
console.log("  GET  /              — the capability console (open in a browser)");
console.log("  GET  /cap           — the http catalogue");
console.log("  POST /cap/:id       — run a capability (x-facet-confirm / x-facet-idempotency-key)");
