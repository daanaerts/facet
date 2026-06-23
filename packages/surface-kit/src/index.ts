import {
  type Actor,
  buildContext,
  type CapabilityDef,
  type Context,
  type JsonSchema,
  type Ledger,
  type SurfaceKind,
  toJsonSchema,
} from "@facet/core";

/**
 * @facet/surface-kit — the mechanics every surface shares, factored out of the surfaces themselves.
 *
 * A surface stays a pure projection (it validates and authorizes nothing — see the surface-purity tripwire),
 * but the surface packages were each re-implementing the same two MECHANISMS, which are not per-transport at
 * all:
 *
 *   1. the host-seam shape — how a host's "who is calling + what may they do" is returned and turned into a
 *      Context (see {@link AuthParts} / {@link contextFromParts}); and
 *   2. the propose→confirm / idempotency fields — how `confirm` + `idempotencyKey` are merged into a tool's
 *      advertised input schema and peeled back off a call's arguments (see {@link mergeContextFields} /
 *      {@link splitContextFields}).
 *
 * Those live here, ONE layer below the surfaces: a surface depends on `@facet/core` AND this kit, and on
 * nothing else of another surface. Per-transport SPELLING — HTTP's `x-facet-*` headers, the CLI's
 * `--yes`/`--key` flags, the SSE/stdout/MCP-progress rendering — stays in each surface, where it belongs. The
 * rule is "surfaces share nothing but core and this kit."
 */

/** The field a schema-advertising surface (MCP, agent) injects so a caller supplies the Context's confirm. */
export const CONFIRM_FIELD = "confirm";
/** The field a schema-advertising surface injects so a caller supplies the Context's idempotency key. */
export const IDEMPOTENCY_FIELD = "idempotencyKey";

/**
 * THE host-seam contract, shared by every surface. A host's authenticator returns exactly "who is calling +
 * what they may do" — an `actor`, the granted `scopes`, and an optional idempotency `ledger` — and NOTHING
 * transport-shaped: not `confirm`, not an idempotency key, not the `surface` kind. Those are the surface's to
 * read off its own transport and inject. Every surface takes a host function returning this — the ARGUMENT
 * differs per transport (request headers, a capability id, the parsed flags) but the RETURN is uniform — and
 * builds the Context itself via {@link contextFromParts}.
 *
 * There is deliberately no tenant/db/install here: a multi-tenant host folds its tenant into `scopes` (and the
 * idempotency key) before returning, so the framework never learns what a tenant is.
 */
export interface AuthParts {
  actor: Actor;
  scopes: string[];
  ledger?: Ledger;
  /**
   * OPTIONAL typed claims about the caller — `{ workspaceId, role, … }` — distinct from the authz `scopes`.
   * Carried onto `ctx.claims` by {@link contextFromParts}; the engine never reads it (it stays tenant-agnostic
   * — this is NOT `ctx.tenant`). A typed home for "who, and in what tenant/role", so a handler reads
   * `ctx.claims.workspaceId` rather than scanning stringly-typed scope prefixes. This is the sanctioned way to
   * carry a tenant: declarative scopes still drive authz; `claims` carry the typed context.
   */
  claims?: Record<string, unknown>;
}

/**
 * Build a Context from the host's {@link AuthParts} plus the surface's own per-call fields. The single place a
 * surface turns "who + what they may do" + "which surface, did they confirm, what idempotency key" into a
 * Context — so no surface re-spells the `buildContext` call, and the `surface` kind can never be set by the
 * host (only by the surface that owns it).
 */
export function contextFromParts(
  parts: AuthParts,
  call: { surface: SurfaceKind; confirm: boolean; idempotencyKey?: string },
): Context {
  return buildContext({
    actor: parts.actor,
    scopes: parts.scopes,
    ledger: parts.ledger,
    claims: parts.claims,
    surface: call.surface,
    confirm: call.confirm,
    idempotencyKey: call.idempotencyKey,
  });
}

/** The capability input plus the Context-shaping fields a schema-advertising surface peeled off a call. */
export interface ContextFields {
  /** The capability input — the call arguments with `confirm` / `idempotencyKey` stripped off. */
  input: Record<string, unknown>;
  /** The surface-supplied confirmation for the core's write/destructive gate. */
  confirm: boolean;
  /** The optional idempotency key for a retried write. */
  idempotencyKey?: string;
}

/**
 * Merge the propose→confirm / idempotency fields into a capability's input JSON Schema — the schema a
 * schema-advertising surface (an MCP tool, an agent tool) presents to a model. On a write/destructive
 * capability `confirm` (boolean) is added and REQUIRED (the gate is not optional) and `idempotencyKey`
 * (string) is added and optional; a read's schema is untouched (a read neither confirms nor dedupes). The base
 * is the capability's own input via core `toJsonSchema`, so the advertised contract still derives from exactly
 * what `execute()` validates — only the two surface-supplied Context fields are added on top.
 */
export function mergeContextFields(def: CapabilityDef): JsonSchema {
  const inputSchema = toJsonSchema(def.input, "input");
  const properties: Record<string, unknown> = {
    ...((inputSchema.properties as Record<string, unknown> | undefined) ?? {}),
  };
  const required = new Set<string>(
    Array.isArray(inputSchema.required) ? (inputSchema.required as string[]) : [],
  );

  if (def.risk !== "read") {
    properties[CONFIRM_FIELD] = {
      type: "boolean",
      description: `Explicit confirmation for this ${def.risk} action (required). Pass ${CONFIRM_FIELD}: false to preview — you get confirmation_required — then ${CONFIRM_FIELD}: true to run.`,
    };
    required.add(CONFIRM_FIELD);
    properties[IDEMPOTENCY_FIELD] = {
      type: "string",
      description:
        "Optional idempotency key — re-sending the same key replays the first result instead of running again.",
    };
  }

  const merged: JsonSchema = { ...inputSchema, type: "object", properties };
  if (required.size > 0) merged.required = [...required];
  else delete merged.required;
  return merged;
}

/**
 * Split a call's raw arguments into the capability input plus the Context-shaping fields the surface merged
 * in: `confirm` and `idempotencyKey` are peeled off; whatever remains is the capability input, forwarded to
 * `execute()` verbatim, where the capability's own schema validates it — the surface never validates.
 */
export function splitContextFields(args: Record<string, unknown> | undefined): ContextFields {
  const { [CONFIRM_FIELD]: confirm, [IDEMPOTENCY_FIELD]: key, ...input } = args ?? {};
  return {
    input,
    confirm: confirm === true,
    idempotencyKey: typeof key === "string" ? key : undefined,
  };
}

/**
 * The wire-name mapping for a schema-advertising surface. Capability ids are dotted (`logs.tail`), but the
 * Anthropic Messages API rejects a tool `name` containing a period (it must match `^[a-zA-Z0-9_-]{1,64}$`).
 * So a real LLM driver — whether it goes over MCP (`@facet/mcp`) or drives the in-process agent surface
 * (`@facet/agent`) against the live API — needs the dotted id mapped to `__` for the wire and back on
 * dispatch. It lives HERE so neither schema-advertising surface re-derives it, and an agent-only host need not
 * import `@facet/mcp` just for a string helper. The separator is two underscores, unambiguous against
 * capability segments (single lowercase words, no underscores).
 */
const NAME_SEPARATOR = "__";

/** A capability id → its Anthropic-regex-safe wire name (dots → `__`). */
export function toolName(id: string): string {
  return id.replaceAll(".", NAME_SEPARATOR);
}

/** A wire name → its capability id (the inverse of {@link toolName}: `__` → `.`). */
export function capabilityId(name: string): string {
  return name.replaceAll(NAME_SEPARATOR, ".");
}
