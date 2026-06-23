import { type Actor, Registry } from "@facet/core";
import { type AuthResult, createHttpApp, type Headers } from "@facet/http";
import jobsCancel from "./capabilities/jobs.cancel.cap";
import jobsList from "./capabilities/jobs.list.cap";
import jobsStart from "./capabilities/jobs.start.cap";
import logsTail from "./capabilities/logs.tail.cap";
import { MemoryLedger } from "./host";

/**
 * The `logs` domain projected onto HTTP — the example host's whole HTTP contribution. It builds the
 * registry from the four capability files and supplies a DEV `authenticate`: this is the seam where a real
 * app would verify a session/API key and decide scopes, but for the demo every request is a single trusted
 * dev user with a fixed scope grant. Nothing framework-specific leaks in — the host decides what auth and
 * scopes mean, and folds nothing tenant-shaped into the surface because this domain has no tenants.
 */

/** The four logs/jobs capabilities, registered into one registry. */
export function logsRegistry(): Registry {
  const registry = new Registry();
  for (const def of [logsTail, jobsList, jobsStart, jobsCancel]) registry.register(def);
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
export function devAuthenticate(): (headers: Headers) => AuthResult {
  const ledger = new MemoryLedger();
  return (_headers: Headers): AuthResult => ({
    actor: DEV_ACTOR,
    scopes: DEV_SCOPES,
    ledger,
  });
}

/** The built `logs` HTTP app: the registry projected onto HTTP behind the dev authenticator. */
export function createLogsHttpApp() {
  return createHttpApp(logsRegistry(), { authenticate: devAuthenticate() });
}

/** A ready-to-serve app instance (used by `serve.ts` and importable for `app.handle(...)` in tests). */
export const app = createLogsHttpApp();
