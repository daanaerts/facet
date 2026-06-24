import type { Actor, Context } from "./context";
import { ScopeError } from "./errors";
import type { Ledger } from "./ledger";
import type { SurfaceKind } from "./surface";

/**
 * The options a surface (or host) supplies to assemble a Context. The required trio — `actor`, `scopes`,
 * `surface` — is the irreducible "who is calling, what may they do, where from"; everything else is the
 * per-request shaping a surface reads off the wire (the confirmation flag, an idempotency key, the optional
 * idempotency ledger, an audit sink).
 */
export interface BuildContextOpts {
  actor: Actor;
  /** Granted scopes for this call. `"*"` is dev god-mode. */
  scopes: string[];
  /** Which surface established this Context. */
  surface: SurfaceKind;
  /** Surface-supplied confirmation for write/destructive capabilities. Defaults to `false`. */
  confirm?: boolean;
  /** Present on writes the caller wants deduped. */
  idempotencyKey?: string;
  /** Optional idempotency port; when present the chokepoint replays a stored result. */
  ledger?: Ledger;
  /**
   * Optional host-set typed claims about the caller (`{ workspaceId, role, … }`), distinct from `scopes`. The
   * engine never reads it; it is a typed home for tenancy/role so a handler need not scan `scopes` strings.
   */
  claims?: Record<string, unknown>;
  /**
   * Optional host-supplied port for reaching external systems (a vault-backed API client, an email / issue
   * connector, …), resolved by id. The symmetric sibling of `ledger`: the engine NEVER calls it — a handler
   * does, via `ctx.connector?.<T>("email")` — but, like `ledger`, the HOST supplies it, so it can be bound to
   * the caller (a per-actor / per-tenant client). A handler that needs a connector it wasn't given throws
   * `ConnectorUnavailableError`.
   */
  connector?: <T>(id: string) => T;
  /** Optional audit sink; defaults to a no-op so a surface need not supply one. */
  audit?: (event: string, data?: unknown) => void;
}

/**
 * Assemble a Context from the parts a surface already has. This removes the per-surface Context boilerplate:
 * each surface authenticates (producing an `actor` + `scopes`) and reads the request's confirmation /
 * idempotency fields, then hands them here rather than hand-rolling a Context object and a `requireScope`
 * closure of its own.
 *
 * The returned Context's `requireScope(scope)` throws `ScopeError` unless `scopes` includes that scope or
 * the wildcard `"*"`, and `audit` defaults to a no-op. This is the exact scope/audit policy the `logs`
 * example host hand-wrote, generalized into core so every surface shares one implementation.
 *
 * CARVE NOTE: this helper takes only spine-free parts. There is no tenant, no install, no db and no appId in
 * the options — a multi-tenant host folds its tenant into `scopes` and the `idempotencyKey` BEFORE calling
 * this, exactly as the carve requires. The framework never learns what a tenant is.
 */
export function buildContext(opts: BuildContextOpts): Context {
  const scopes = opts.scopes;
  return {
    actor: opts.actor,
    surface: opts.surface,
    scopes,
    confirm: opts.confirm ?? false,
    idempotencyKey: opts.idempotencyKey,
    ledger: opts.ledger,
    claims: opts.claims,
    connector: opts.connector,
    requireScope(scope: string): void {
      if (!scopes.includes(scope) && !scopes.includes("*")) throw new ScopeError(scope);
    },
    audit: opts.audit ?? (() => {}),
  };
}
