/**
 * @facet/http — the HTTP surface. Generic over a Registry: it projects every capability onto HTTP, establishes
 * a Context via a host-supplied authenticator, and translates the FacetError family to HTTP status. Branded
 * headers: `x-facet-confirm`, `x-facet-idempotency-key`, `x-facet-actor`.
 *
 * The PRIMARY, framework-agnostic export is {@link createFetchHandler} — a Web `(req: Request) => Promise<Response>`
 * built on nothing but `Request`/`Response`/`ReadableStream`, so it mounts in `Bun.serve({ fetch })` /
 * `Deno.serve(…)` natively, on Node via a tiny WinterCG adapter, or inside Elysia/Hono for their middleware.
 * {@link createHttpApp} is an OPTIONAL thin Elysia wrapper that just `.mount()`s the fetch handler, for hosts
 * that want the Elysia ecosystem. It lives at the `@facet/http/elysia` subpath (not this barrel) so the default
 * `@facet/http` import pulls in NO web framework — `elysia` is an optional peer reached only via that subpath.
 *
 * The whole surface is `POST /cap/:id` over every capability id, plus an introspection catalogue at `GET /cap`
 * / `GET /cap/:id` and a `GET /health`. A capability with `surfaces.includes("http")` lights up automatically —
 * no per-capability route. The surface validates nothing and authorizes nothing; that all lives in
 * `@facet/core` `execute()` / `executeStream()`.
 */

export {
  type CapabilityCatalogEntry,
  httpCatalog,
} from "./catalog";
export {
  type Authenticate,
  type CreateFetchHandlerOpts,
  createFetchHandler,
  HEADER,
  type HeaderRecord,
} from "./fetch-handler";
