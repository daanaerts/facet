import type { Ledger } from "./ledger";
import type { SurfaceKind } from "./surface";

/**
 * Who is making the call. A surface establishes this; the core trusts it. The `agent` kind is a
 * first-class principal, not a special case of `user` — Facet's whole point.
 */
export type Actor =
  | { kind: "user"; id: string; email: string }
  | { kind: "service" }
  | { kind: "agent"; agentId: string };

export function describeActor(actor: Actor): string {
  switch (actor.kind) {
    case "user":
      return actor.email;
    case "service":
      return "service";
    case "agent":
      return `agent:${actor.agentId}`;
  }
}

/**
 * Every capability runs inside a Context. The surface (or host) fills it in once — authenticate, grant
 * scopes, read confirmation/idempotency off the request — and the core and handler read from it.
 *
 * CARVE NOTE: this is the Moral Fabric `Context` with the host-specific fields removed — `tenant`,
 * `appInstall`, `installs`, and `db` are all gone. They were a specific product's spine leaking into the
 * supposedly-generic core. Multi-tenancy is now achieved by the HOST (fold the tenant into the scopes and
 * the idempotency key); the framework does not know what a tenant is. The only ports the core itself
 * consults are `ledger` (idempotency) and, optionally, `connector` — both optional.
 */
export interface Context {
  readonly actor: Actor;
  /** Which surface established this Context. Drives confirmation UX and audit; primary is `agent`. */
  readonly surface: SurfaceKind;
  /** Granted scopes for this call. `"*"` is dev god-mode. */
  readonly scopes: string[];
  /** Surface-supplied confirmation for write/destructive capabilities (the "[Yes]" gate). */
  readonly confirm: boolean;
  /** Present on writes the caller wants deduped; the core replays by it so a retry never doubles. */
  readonly idempotencyKey?: string;
  /**
   * Optional idempotency port. When present (and a non-read carries an `idempotencyKey`), `execute()`
   * replays a stored result instead of re-running the handler. Absent ⇒ dedup is simply skipped.
   */
  readonly ledger?: Ledger;

  /** Throws `ScopeError` if the scope is not granted. The host implements the policy. */
  requireScope(scope: string): void;
  /** Append an audit event. Every invocation is audited by the chokepoint. */
  audit(event: string, data?: unknown): void;
  /** Optional host-supplied port for reaching external systems (vault-backed clients, etc.). */
  connector?<T>(id: string): T;
}
