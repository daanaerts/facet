import { type Actor, Registry } from "@facet/core";
import { createFetchHandler, createHttpApp, type Headers } from "@facet/http";
import type { AuthParts } from "@facet/surface-kit";
import jobsCancel from "./capabilities/jobs.cancel.cap";
import jobsList from "./capabilities/jobs.list.cap";
import jobsStart from "./capabilities/jobs.start.cap";
import logsBoom from "./capabilities/logs.boom.cap";
import logsFollow from "./capabilities/logs.follow.cap";
import logsTail from "./capabilities/logs.tail.cap";
import { MemoryLedger } from "./host";

/**
 * The `logs` domain projected onto HTTP — the example host's whole HTTP contribution. It builds the
 * registry from the four capability files and supplies a DEV `authenticate`: this is the seam where a real
 * app would verify a session/API key and decide scopes, but for the demo every request is a single trusted
 * dev user with a fixed scope grant. Nothing framework-specific leaks in — the host decides what auth and
 * scopes mean, and folds nothing tenant-shaped into the surface because this domain has no tenants.
 */

/**
 * The logs/jobs capabilities, registered into one registry: the unary `logs.tail` + the jobs trio, plus the
 * STREAMING `logs.follow` and the streaming mid-stream-failure fixture `logs.boom` (the latter exercises the
 * mid-stream-error contract end-to-end on every surface — see `docs/STREAMING-CONTRACT.md`).
 */
export function logsRegistry(): Registry {
  const registry = new Registry();
  for (const def of [logsTail, logsFollow, logsBoom, jobsList, jobsStart, jobsCancel]) {
    registry.register(def);
  }
  return registry;
}

/** The dev user every request authenticates as. A real host would derive this from a verified session. */
const DEV_ACTOR: Actor = { kind: "user", id: "dev@example.com", email: "dev@example.com" };

/** The scopes the dev user is granted — enough to read logs and read/write jobs. */
const DEV_SCOPES = ["logs:read", "jobs:read", "jobs:write"];

/**
 * A dev authenticator: every request is the same trusted dev user, granted the logs/jobs scopes, with an
 * in-memory idempotency ledger so a retried `jobs.start` carrying `x-facet-idempotency-key` dedupes. A real
 * host swaps this for session/API-key verification; the surface does not change. (Honouring an optional
 * `x-facet-actor` override is left out on purpose — a dev seam should not let a header assert identity.)
 *
 * The ledger is created ONCE here (closed over), not per request, so replays actually hit a shared store.
 */
export function devAuthenticate(): (headers: Headers) => AuthParts {
  const ledger = new MemoryLedger();
  return (_headers: Headers): AuthParts => ({
    actor: DEV_ACTOR,
    scopes: DEV_SCOPES,
    ledger,
  });
}

/**
 * The portable `logs` HTTP handler: the registry projected onto a Web `(req) => Promise<Response>` behind the
 * dev authenticator. This is what `serve.ts` mounts in `Bun.serve({ fetch })` — the runtime-pure artifact that
 * would mount identically under `Deno.serve` or on Node via a WinterCG adapter.
 */
export function createLogsFetchHandler() {
  return createFetchHandler(logsRegistry(), { authenticate: devAuthenticate() });
}

/**
 * The built `logs` Elysia app: the same registry behind the same dev authenticator, wrapped in Elysia. Kept so
 * the e2e tests can drive it headlessly with `app.handle(new Request(...))`; `serve.ts` uses the portable fetch
 * handler instead.
 */
export function createLogsHttpApp() {
  return createHttpApp(logsRegistry(), { authenticate: devAuthenticate() });
}

/** A ready-to-serve app instance (used by importing tests for `app.handle(...)`). */
export const app = createLogsHttpApp();
