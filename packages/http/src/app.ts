import {
  type Actor,
  buildContext,
  execute,
  executeStream,
  FacetError,
  type Ledger,
  NotFoundError,
  type Registry,
} from "@facet/core";
import { Elysia, sse } from "elysia";
import { type CapabilityCatalogEntry, catalogEntry, httpCatalog } from "./catalog";

/**
 * The HTTP surface — Elysia, projected from the registry. It is written ONCE, generically: a single
 * `POST /cap/:id` handler runs over every capability id, so a capability with `surfaces.includes("http")`
 * lights up on HTTP the moment its `*.cap.ts` file lands — no hand-written route per capability, no
 * per-surface authz/validation.
 *
 * The surface's ONLY job is to establish a Context and translate errors. Every invariant — input
 * validation, scope authz, confirmation, idempotency, audit, kill-switch — already lives in `@facet/core`
 * `execute()`; this route re-implements none of them. It reads who is calling and what they confirmed off
 * the request, builds the Context, calls `execute`, and maps a `FacetError` to its `.status` with a
 * `{ code, message, data }` body. That is the "the GUI has zero privileged powers" thesis made structural:
 * the browser uses the exact same projection the CLI and MCP do.
 *
 * CARVE NOTE: Moral Fabric's HTTP surface called the spine's `createContext({ db, principal, … })`, which
 * read tenancy / scopes / installs out of a database and gated on them. Facet has no spine: the host
 * supplies a single `authenticate(headers)` function — the seam where a real app plugs in auth — that
 * returns the `{ actor, scopes, ledger? }` this surface needs, or `null` for an unauthenticated request.
 * A multi-tenant host folds its tenant into the `scopes` (and the idempotency key) inside `authenticate`,
 * exactly as the carve requires; this surface never learns what a tenant is.
 */

/** Header names the surface reads. Lowercased — Elysia normalizes header keys to lowercase. */
const HEADER = {
  confirm: "x-facet-confirm",
  idempotencyKey: "x-facet-idempotency-key",
  actor: "x-facet-actor",
  /** Standard content negotiation: `Accept: text/event-stream` opts a streaming capability into SSE. */
  accept: "accept",
} as const;

/** The media type a client sends in `Accept` to receive a streaming capability as Server-Sent Events. */
const SSE_MEDIA_TYPE = "text/event-stream";

/** The request headers handed to `authenticate`. Elysia lowercases the keys. */
export type Headers = Record<string, string | undefined>;

/**
 * What a host's `authenticate` returns: the irreducible "who is calling + what may they do", plus an
 * optional idempotency ledger. This is the host's whole contribution to the surface — the seam where a
 * real app verifies a session / API key and decides scopes. Returning `null` means the request is
 * unauthenticated and the route answers 401; the function may be sync or async.
 *
 * NOTE: there is deliberately no tenant, db, install or appId here. A multi-tenant host folds the tenant
 * into `scopes` and the idempotency key BEFORE returning — the framework never sees a tenant.
 */
export interface AuthResult {
  actor: Actor;
  scopes: string[];
  ledger?: Ledger;
}

/** The host-supplied authenticator: turns request headers into an `AuthResult`, or `null` for 401. */
export type Authenticate = (headers: Headers) => AuthResult | null | Promise<AuthResult | null>;

/** Options for {@link createHttpApp}: the registry to project, and the host's authenticator. */
export interface CreateHttpAppOpts {
  authenticate: Authenticate;
}

/** The error body every failure returns: the `FacetError` triplet, surface-agnostic. */
interface ErrorBody {
  code: string;
  message: string;
  data?: unknown;
}

/** Whether a capability id is served on the http surface: it exists, is enabled, and declares `http`. */
function servesHttp(registry: Registry, id: string): boolean {
  const def = registry.get(id);
  return def?.enabled === true && def.surfaces.includes("http");
}

/** Map any thrown value to an HTTP status + `{ code, message, data }` body. */
function toErrorResponse(err: unknown): { status: number; body: ErrorBody } {
  if (err instanceof FacetError) {
    return { status: err.status, body: { code: err.code, message: err.message, data: err.data } };
  }
  return {
    status: 500,
    body: { code: "internal", message: err instanceof Error ? err.message : "internal error" },
  };
}

/**
 * Render a streaming capability as Server-Sent Events. This is the HTTP projection of the core's
 * `executeStream()` agent-primary contract: each validated chunk becomes a `data: <json>\n\n` SSE frame as
 * it is produced, and the validated final value becomes a terminal `event: result\ndata: <json>\n\n` frame.
 *
 * It is an async generator, which is how Elysia streams a response: a yielded value carrying `.toSSE()` (what
 * `sse()` attaches) flips the response to `Content-Type: text/event-stream` and is enqueued verbatim, so the
 * surface controls the exact frames (and the `event: result` line on the terminal frame) without Elysia
 * double-wrapping them. The first pull runs the core's read gates (resolve → validate → authz → audit); we
 * deliberately prime that first pull OUTSIDE this generator (see the route) so a pre-stream `FacetError`
 * (unknown id, missing scope, bad input) is mapped to a normal JSON status response rather than surfacing
 * mid-stream — once the first chunk is out, the status line is already 200 and committed.
 */
async function* sseStream(
  gen: AsyncGenerator<unknown, unknown, void>,
  primed: IteratorResult<unknown, unknown>,
): AsyncGenerator<ReturnType<typeof sse>, void, void> {
  let step = primed;
  while (!step.done) {
    yield sse({ data: step.value });
    step = await gen.next();
  }
  // The terminal frame carries the validated final value under the `result` event, so a client can tell the
  // last message (the capability's output) apart from the incremental chunks that preceded it.
  yield sse({ event: "result", data: step.value });
}

/**
 * Build the Elysia app over a registry. Every capability that projects onto the `http` surface is served by
 * the SAME generic `POST /cap/:id`; the catalogue at `GET /cap` lets clients introspect each id, risk,
 * surfaces and input/output JSON Schema without importing the registry.
 *
 * The return type is intentionally inferred (not annotated `: Elysia`): the precise chained route type is
 * what Eden Treaty reads off the app to type `/cap/:id` calls, so erasing it to the base `Elysia` would
 * leave a client untyped.
 */
export function createHttpApp(registry: Registry, opts: CreateHttpAppOpts) {
  const { authenticate } = opts;

  return (
    new Elysia()
      .get("/health", () => ({ ok: true }))

      // The introspection catalogue: the registry projected to the http surface as wire records. A new
      // http capability appears here automatically — this is one projection, not a hand-kept list. It does
      // NOT authenticate: the catalogue advertises the contract, and the chokepoint (`execute`) is what
      // refuses an actual call. (A host that wants a per-caller catalogue filters in its own middleware.)
      .get("/cap", (): { capabilities: CapabilityCatalogEntry[] } => ({
        capabilities: httpCatalog(registry),
      }))

      // One capability's catalogue entry by id (404 if it does not project onto http).
      .get("/cap/:id", ({ params, set }): CapabilityCatalogEntry | ErrorBody => {
        const def = registry.get(params.id);
        if (!def || !servesHttp(registry, params.id)) {
          set.status = 404;
          return { code: "not_found", message: `capability not found: ${params.id}` };
        }
        return catalogEntry(def);
      })

      // THE generic capability route. One handler, every id. The body is the capability input verbatim; the
      // surface adds only Context (who + confirm + idempotency) and forwards the rest to `execute`. It
      // VALIDATES and AUTHORIZES NOTHING itself — `execute()` owns all of that.
      .post("/cap/:id", async ({ params, body, headers, set }): Promise<unknown> => {
        // 1. authenticate — the host's seam. `null` ⇒ an unauthenticated request → 401.
        const auth = await authenticate(headers);
        if (!auth) {
          set.status = 401;
          return {
            code: "unauthorized",
            message: "no credentials",
          } satisfies ErrorBody;
        }

        try {
          // Refuse a capability that does not project onto http BEFORE forming a Context, so an http-less
          // capability is a clean not-found rather than a confusing authz error from the wrong surface.
          if (!servesHttp(registry, params.id)) {
            throw new NotFoundError(`capability not found: ${params.id}`, { id: params.id });
          }

          // 2. read the surface-supplied Context fields off the request.
          const confirm = headers[HEADER.confirm] === "true";
          const idempotencyKey = headers[HEADER.idempotencyKey];

          // 3. build the Context from the host's auth result + the request's confirm/idempotency.
          const ctx = buildContext({
            actor: auth.actor,
            scopes: auth.scopes,
            surface: "http",
            confirm,
            idempotencyKey,
            ledger: auth.ledger,
          });

          // 4. The body defaults to `{}` so a no-input read can be POSTed with an empty body.
          const input = body ?? {};

          // 4a. STREAMING (additive): a streaming capability negotiates SSE via the standard `Accept`
          //     header. With `Accept: text/event-stream` it is rendered as Server-Sent Events; WITHOUT it
          //     the same capability is drained by `execute()` to its final JSON (back-compat — a plain
          //     client still gets the terminal value, exactly as a non-streaming read would). The choice is
          //     content negotiation only; `executeStream()` and `execute()` share every core invariant.
          const def = registry.get(params.id);
          const wantsSse = (headers[HEADER.accept] ?? "").includes(SSE_MEDIA_TYPE);
          if (def?.stream && wantsSse) {
            // Prime the first pull HERE, inside the try: it runs the read gates (resolve → validate →
            // authz → audit), so a pre-stream FacetError still maps to a normal JSON status below rather
            // than committing a 200 SSE response and failing mid-stream. The primed step is then re-emitted
            // by `sseStream`, which streams the rest.
            const gen = executeStream(registry, params.id, input, ctx);
            const primed = await gen.next();
            return sseStream(gen, primed);
          }

          // 5. Non-streaming (or a streaming cap without the SSE Accept): validation, authz, confirmation
          //    and idempotency all happen inside `execute` — never here. A streaming cap drains to its final.
          return await execute(registry, params.id, input, ctx);
        } catch (err) {
          // 5. map a thrown FacetError → its status + `{ code, message, data }`; anything else → 500.
          const { status, body: errBody } = toErrorResponse(err);
          set.status = status;
          return errBody;
        }
      })
  );
}

/** The app type — a host imports this for a fully typed Eden Treaty client over `/cap/:id`. */
export type HttpApp = ReturnType<typeof createHttpApp>;

/** The header names the surface reads, exported so a host/client can address them by name. */
export { HEADER };
