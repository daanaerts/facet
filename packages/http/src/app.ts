import type { Registry } from "@facet/core";
import { Elysia } from "elysia";
import { type CreateFetchHandlerOpts, createFetchHandler } from "./fetch-handler";

/**
 * The OPTIONAL Elysia mount — a thin wrapper that exists for one reason: a host that already lives inside
 * Elysia (for its middleware, plugins, or an Eden Treaty client) can drop the Facet surface in as an Elysia
 * app. It owns NO surface logic of its own: it `.mount()`s the portable {@link createFetchHandler} — the
 * framework-agnostic primary — so every route, every branded header (`x-facet-confirm` /
 * `x-facet-idempotency-key`), the FacetError→status mapping and the SSE streaming contract are defined exactly
 * ONCE, in the fetch handler, and Elysia just carries the bytes. Mounting a WinterCG `fetch` handler is a
 * first-class Elysia capability, and it round-trips `Request`→`Response` verbatim (status, JSON, and SSE
 * `ReadableStream` bodies all pass through untouched), so `app.handle(new Request(...))` behaves identically to
 * calling the handler directly.
 *
 * USE THE FETCH HANDLER DIRECTLY unless you specifically want Elysia: `createFetchHandler(registry, …)` mounts
 * natively in `Bun.serve({ fetch })` / `Deno.serve(…)` and on Node via a tiny WinterCG adapter, with no Elysia
 * dependency at all. This wrapper is the on-ramp for the Elysia ecosystem, not the recommended path.
 *
 * TYPED-CLIENT NOTE: because the surface is now a single mounted handler rather than per-route Elysia
 * declarations, an Eden Treaty client over this app sees the mount, not typed `/cap/:id` routes — full
 * per-route Treaty inference is the deliberate tradeoff for making the PORTABLE handler the single source of
 * truth. The Elysia app + `@elysiajs/eden` remain available for hosts that build their typing another way (or
 * mount Facet alongside their own typed routes).
 */

/** Options for {@link createHttpApp}: the registry to project, and the host's authenticator. */
export type CreateHttpAppOpts = CreateFetchHandlerOpts;

/**
 * Build an Elysia app over a registry by mounting the portable fetch handler. Every capability that projects
 * onto the `http` surface is served by the SAME generic `POST /cap/:id`, with the introspection catalogue at
 * `GET /cap` / `GET /cap/:id` and a `GET /health` — exactly the routes the fetch handler implements, since this
 * app IS the fetch handler with Elysia wrapped around it.
 */
export function createHttpApp(registry: Registry, opts: CreateHttpAppOpts) {
  return new Elysia().mount(createFetchHandler(registry, opts));
}

/** The app type — a host imports this when it threads the Elysia app through its own typing. */
export type HttpApp = ReturnType<typeof createHttpApp>;

/** Re-export the surface's seam type + header names from their home in the fetch handler. (The host-seam
 *  return type is the shared `AuthParts` from `@facet/surface-kit`.) */
export {
  type Authenticate,
  type CreateFetchHandlerOpts,
  createFetchHandler,
  HEADER,
  type HeaderRecord,
} from "./fetch-handler";
