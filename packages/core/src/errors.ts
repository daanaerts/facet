/**
 * The surface-agnostic error vocabulary. One taxonomy, rendered natively by each surface (HTTP status,
 * MCP error, CLI exit code, an agent-readable message). `facet.md` lists this as an "open question" — it
 * is not; it already exists and ports from Moral Fabric essentially unchanged. The only edit in the carve
 * was dropping `idempotency_replay` (a replay is a SUCCESS, not an error path).
 */
export type FacetErrorCode =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "validation"
  | "confirmation_required"
  | "conflict"
  | "connector_unavailable"
  | "kill_switch"
  | "internal";

/** A typed error every surface can translate. `status` is the HTTP rendering; other surfaces map `code`. */
export class FacetError extends Error {
  readonly code: FacetErrorCode;
  readonly status: number;
  readonly data?: unknown;

  constructor(code: FacetErrorCode, message: string, status: number, data?: unknown) {
    super(message);
    this.name = "FacetError";
    this.code = code;
    this.status = status;
    this.data = data;
  }
}

export class ScopeError extends FacetError {
  constructor(scope: string) {
    super("forbidden", `missing required scope: ${scope}`, 403, { scope });
  }
}

export class NotFoundError extends FacetError {
  constructor(message: string, data?: unknown) {
    super("not_found", message, 404, data);
  }
}

export class ValidationError extends FacetError {
  constructor(capabilityId: string, issues: unknown) {
    super("validation", `invalid input for ${capabilityId}`, 422, { capabilityId, issues });
  }
}

/**
 * Thrown for write/destructive capabilities when the surface has not confirmed. `preview` carries the
 * proposed effect so an agent can surface it to the human before the re-call with `confirm: true` — the
 * propose→confirm handshake modelled in the contract, not in surface code.
 */
export class ConfirmationRequiredError extends FacetError {
  constructor(capabilityId: string, risk: string, preview?: unknown) {
    super("confirmation_required", `confirmation required for ${capabilityId} (${risk})`, 409, {
      capabilityId,
      risk,
      preview,
    });
  }
}

export class KillSwitchError extends FacetError {
  constructor(capabilityId: string) {
    super("kill_switch", `capability is disabled: ${capabilityId}`, 503, { capabilityId });
  }
}

export class ConnectorUnavailableError extends FacetError {
  constructor(connectorId: string, reason?: string) {
    super("connector_unavailable", `connector unavailable: ${connectorId}`, 501, {
      connectorId,
      reason,
    });
  }
}
