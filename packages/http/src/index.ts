/**
 * @facet/http — the HTTP surface. Generic over a Registry: one Elysia app that mounts every capability,
 * establishes a Context via a host-supplied authenticator, and translates the FacetError family to HTTP
 * status. Branded headers: `x-facet-confirm`, `x-facet-idempotency-key`, `x-facet-actor`.
 *
 * The whole surface is `POST /cap/:id` over every capability id, plus an introspection catalogue at
 * `GET /cap` / `GET /cap/:id` and a `GET /health`. A capability with `surfaces.includes("http")` lights up
 * automatically — no per-capability route. The surface validates nothing and authorizes nothing; that all
 * lives in `@facet/core` `execute()`.
 */
export {
  type Authenticate,
  type AuthResult,
  type CreateHttpAppOpts,
  createHttpApp,
  HEADER,
  type Headers,
  type HttpApp,
} from "./app";
export {
  type CapabilityCatalogEntry,
  catalogEntry,
  httpCatalog,
} from "./catalog";
