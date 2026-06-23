import { execute, executeStream, FacetError, NotFoundError, type Registry } from "@facet/core";
import { type AuthParts, contextFromParts } from "@facet/surface-kit";
import { type CapabilityCatalogEntry, catalogEntry, httpCatalog } from "./catalog";

/**
 * The HTTP surface as a PORTABLE Web fetch handler — `(req: Request) => Promise<Response>`, built on nothing
 * but the platform's own `Request`/`Response`/`ReadableStream`. This is the artifact Facet's positioning calls
 * "the portable one": it has no framework underneath, so it mounts natively in `Bun.serve({ fetch })`,
 * `Deno.serve(handler)`, Node via a tiny WinterCG adapter (`@hono/node-server` / `srvx`), or INSIDE Elysia /
 * Hono for their middleware (see {@link createHttpApp}, which just `.mount()`s this). The framework is the
 * host's choice; this handler is the same on all of them.
 *
 * It is the SAME surface the Elysia app used to be, generically: a single `POST /cap/:id` runs over every
 * capability id, so a capability with `surfaces.includes("http")` lights up the moment its `*.cap.ts` lands —
 * no hand-written route per capability, no per-surface authz/validation. The surface's ONLY job is to
 * establish a Context and translate errors: input validation, scope authz, confirmation, idempotency, audit
 * and the kill-switch all already live in `@facet/core` `execute()` / `executeStream()`, and this handler
 * re-implements NONE of them — it reads who is calling + what they confirmed off the request, builds the
 * Context, calls the chokepoint, and maps a `FacetError` to its `.status` with a `{ code, message, data }`
 * body. That is "the GUI has zero privileged powers" made structural: the browser drives the exact same
 * projection the CLI and MCP do, over the exact same engine.
 *
 * CARVE NOTE: Moral Fabric's HTTP surface called the spine's `createContext({ db, principal, … })`, which read
 * tenancy / scopes / installs out of a database and gated on them. Facet has no spine: the host supplies a
 * single `authenticate(headers)` — the seam where a real app plugs in auth — that returns the
 * `{ actor, scopes, ledger? }` this surface needs, or `null` for an unauthenticated request. A multi-tenant
 * host folds its tenant into the `scopes` (and the idempotency key) inside `authenticate`, exactly as the carve
 * requires; this surface never learns what a tenant is.
 */

/** Header names the surface reads. Lowercased — the Web `Headers` API lowercases keys on `.get`. */
const HEADER = {
  confirm: "x-facet-confirm",
  idempotencyKey: "x-facet-idempotency-key",
  actor: "x-facet-actor",
  /** Standard content negotiation: `Accept: text/event-stream` opts a streaming capability into SSE. */
  accept: "accept",
} as const;

/** The media type a client sends in `Accept` to receive a streaming capability as Server-Sent Events. */
const SSE_MEDIA_TYPE = "text/event-stream";

/**
 * The request headers handed to `authenticate`. A plain record keyed by lowercased header name so a host's
 * authenticator is identical whether the surface is mounted as this fetch handler or behind Elysia — both
 * present headers the same lowercased way.
 */
export type Headers = Record<string, string | undefined>;

/**
 * The host-supplied authenticator: turns request headers into the shared {@link AuthParts} ("who is calling +
 * what may they do" — `actor`, `scopes`, an optional idempotency `ledger`), or `null` for an unauthenticated
 * request the route answers 401. This is the host's whole contribution to the surface — the seam where a real
 * app verifies a session / API key and decides scopes; it may be sync or async. There is deliberately no
 * tenant/db/install/appId here: a multi-tenant host folds its tenant into `scopes` (and the idempotency key)
 * BEFORE returning, so the framework never sees a tenant.
 */
export type Authenticate = (headers: Headers) => AuthParts | null | Promise<AuthParts | null>;

/** Options for {@link createFetchHandler}: the host's authenticator. (The registry is the first argument.) */
export interface CreateFetchHandlerOpts {
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

/** A JSON `Response` with the right content-type — the single shape every non-streaming answer takes. */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Lower-case header record from a Web `Request`, so `authenticate` reads the same keys on every runtime. */
function headerRecord(req: Request): Headers {
  const out: Headers = {};
  req.headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

/** SSE frame encoder. One UTF-8 `data:`/`event:` frame per call, terminated by the blank line SSE requires. */
const encoder = new TextEncoder();
function sseFrame(event: string | undefined, data: unknown): Uint8Array {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  return encoder.encode(event === undefined ? payload : `event: ${event}\n${payload}`);
}

/**
 * Render a primed streaming generator as an SSE `Response` whose body is a Web `ReadableStream`. This is the
 * portable twin of the Elysia SSE path: each validated chunk becomes a bare `data: <json>\n\n` frame as it is
 * produced, and the validated final value becomes a terminal `event: result\ndata: <json>\n\n` frame — the
 * exact frames the cross-surface streaming contract pins (see `docs/STREAMING-CONTRACT.md`).
 *
 * The first pull is primed by the CALLER (see the route), OUTSIDE this stream, so a pre-stream `FacetError`
 * (unknown id, missing scope, bad input) is mapped to a normal JSON status response rather than committing a
 * 200 SSE response and then failing mid-stream — once the status line is `200 text/event-stream` it cannot be
 * un-sent. We re-emit that primed step here, then drive the rest.
 *
 * MID-STREAM FAILURE: because the 200 + `text/event-stream` status is already committed once the first frame is
 * out, a failure AFTER chunk K cannot be an HTTP status. So if `executeStream()` throws part-way (a chunk fails
 * its schema, or the handler throws), we catch it HERE — the K good `data:` frames have already gone out — and
 * emit a single terminal `event: error` frame carrying the `FacetError` `{ code, message }`, then close. It is
 * deliberately an `error` event, NOT a `result` event: a client tells "ended in failure" from "completed with a
 * final value" purely by the terminal event name, and a stream emits exactly one of the two. The core
 * guarantees the thrown thing is a `FacetError`, so a non-`FacetError` surfaces as `internal` here exactly as it
 * would on the unary JSON path. (`data` is dropped from the wire frame to keep the terminal frame a tight
 * `{ code, message }`, matching the Elysia surface byte-for-byte.)
 */
function sseResponse(
  gen: AsyncGenerator<unknown, unknown, void>,
  primed: IteratorResult<unknown, unknown>,
): Response {
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let step = primed;
      try {
        while (!step.done) {
          controller.enqueue(sseFrame(undefined, step.value));
          step = await gen.next();
        }
      } catch (err) {
        const { body } = toErrorResponse(err);
        controller.enqueue(sseFrame("error", { code: body.code, message: body.message }));
        controller.close();
        return;
      }
      // The terminal frame carries the validated final value under the `result` event, so a client can tell the
      // last message (the capability's output) apart from the incremental chunks that preceded it.
      controller.enqueue(sseFrame("result", step.value));
      controller.close();
    },
  });
  return new Response(stream, { headers: { "content-type": SSE_MEDIA_TYPE } });
}

/**
 * Build the PRIMARY, framework-agnostic HTTP surface: a Web fetch handler over a registry. Every capability
 * that projects onto the `http` surface is served by the SAME generic `POST /cap/:id`; the catalogue at
 * `GET /cap` lets clients introspect each id, risk, surfaces and input/output JSON Schema without importing the
 * registry. The four routes are exactly what the Elysia app used to declare — `GET /health`, `GET /cap`,
 * `GET /cap/:id`, `POST /cap/:id` — only now they are dispatched off the URL with pure Web APIs.
 *
 * Mount the returned handler wherever you serve HTTP:
 *   Bun.serve({ fetch: createFetchHandler(registry, { authenticate }) })
 *   Deno.serve(createFetchHandler(registry, { authenticate }))
 *   // Node: wrap with @hono/node-server or srvx; Elysia/Hono: mount for their middleware.
 */
export function createFetchHandler(
  registry: Registry,
  opts: CreateFetchHandlerOpts,
): (req: Request) => Promise<Response> {
  const { authenticate } = opts;

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname;

    // GET /health — a liveness probe, unauthenticated by design.
    if (req.method === "GET" && path === "/health") {
      return json({ ok: true });
    }

    // GET /cap — the introspection catalogue: the registry projected to the http surface as wire records. A
    // new http capability appears here automatically — this is one projection, not a hand-kept list. It does
    // NOT authenticate: the catalogue advertises the contract, and the chokepoint (`execute`) is what refuses an
    // actual call. (A host that wants a per-caller catalogue filters in its own middleware.)
    if (req.method === "GET" && path === "/cap") {
      return json({ capabilities: httpCatalog(registry) } satisfies {
        capabilities: CapabilityCatalogEntry[];
      });
    }

    // GET /cap/:id — one capability's catalogue entry by id (404 if it does not project onto http).
    if (req.method === "GET" && path.startsWith("/cap/")) {
      const id = decodeURIComponent(path.slice("/cap/".length));
      const def = registry.get(id);
      if (!def || !servesHttp(registry, id)) {
        return json(
          { code: "not_found", message: `capability not found: ${id}` } satisfies ErrorBody,
          404,
        );
      }
      return json(catalogEntry(def));
    }

    // POST /cap/:id — THE generic capability route. One handler, every id. The body is the capability input
    // verbatim; the surface adds only Context (who + confirm + idempotency) and forwards the rest to the
    // chokepoint. It VALIDATES and AUTHORIZES NOTHING itself — `execute()` owns all of that.
    if (req.method === "POST" && path.startsWith("/cap/")) {
      const id = decodeURIComponent(path.slice("/cap/".length));
      const headers = headerRecord(req);

      // 1. authenticate — the host's seam. `null` ⇒ an unauthenticated request → 401.
      const auth = await authenticate(headers);
      if (!auth) {
        return json({ code: "unauthorized", message: "no credentials" } satisfies ErrorBody, 401);
      }

      try {
        // Refuse a capability that does not project onto http BEFORE forming a Context, so an http-less
        // capability is a clean not-found rather than a confusing authz error from the wrong surface.
        if (!servesHttp(registry, id)) {
          throw new NotFoundError(`capability not found: ${id}`, { id });
        }

        // 2. read the surface-supplied Context fields off the request.
        const confirm = headers[HEADER.confirm] === "true";
        const idempotencyKey = headers[HEADER.idempotencyKey];

        // 3. build the Context from the host's auth parts + the request's confirm/idempotency.
        const ctx = contextFromParts(auth, { surface: "http", confirm, idempotencyKey });

        // 4. The body defaults to `{}` so a no-input read can be POSTed with an empty body. `req.json()`
        //    rejects an empty body, so read text first and parse only when there is something to parse.
        const input = await readJsonBody(req);

        // 4a. STREAMING (additive): a streaming capability negotiates SSE via the standard `Accept` header.
        //     With `Accept: text/event-stream` it is rendered as Server-Sent Events; WITHOUT it the same
        //     capability is drained by `execute()` to its final JSON (back-compat — a plain client still gets
        //     the terminal value, exactly as a non-streaming read would). The choice is content negotiation
        //     only; `executeStream()` and `execute()` share every core invariant.
        const def = registry.get(id);
        const wantsSse = (headers[HEADER.accept] ?? "").includes(SSE_MEDIA_TYPE);
        if (def?.stream && wantsSse) {
          // Prime the first pull HERE, inside the try: it runs the read gates (resolve → validate → authz →
          // audit), so a pre-stream FacetError still maps to a normal JSON status below rather than committing
          // a 200 SSE response and failing mid-stream. The primed step is then re-emitted by `sseResponse`.
          const gen = executeStream(registry, id, input, ctx);
          const primed = await gen.next();
          return sseResponse(gen, primed);
        }

        // 5. Non-streaming (or a streaming cap without the SSE Accept): validation, authz, confirmation and
        //    idempotency all happen inside `execute` — never here. A streaming cap drains to its final.
        return json(await execute(registry, id, input, ctx));
      } catch (err) {
        // 5. map a thrown FacetError → its status + `{ code, message, data }`; anything else → 500.
        const { status, body } = toErrorResponse(err);
        return json(body, status);
      }
    }

    // Anything else is not a Facet route — a generic 404 in the same error vocabulary the rest of the surface
    // speaks, so a misaddressed client gets a `{ code, message }` body rather than an opaque framework 404.
    return json(
      { code: "not_found", message: `no route: ${req.method} ${path}` } satisfies ErrorBody,
      404,
    );
  };
}

/**
 * Read a POST body as JSON, defaulting an EMPTY body to `{}`. A no-input capability (`input: z.object({})`) is
 * legitimately POSTed with no body at all, and the Web `Request.json()` throws on empty input, so we read the
 * raw text first and only parse when there is something there. A non-empty but malformed body surfaces as a
 * `validation` error — the SAME `FacetError` the schema would raise — keeping the error vocabulary uniform.
 */
async function readJsonBody(req: Request): Promise<unknown> {
  const text = await req.text();
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new FacetError("validation", "request body is not valid JSON", 422);
  }
}

/** The header names the surface reads, exported so a host/client can address them by name. */
export { HEADER };
