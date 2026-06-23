import { type Actor, buildContext, type Context, type Registry } from "@facet/core";
import type { ParityHosts } from "@facet/parity";
import type { AuthParts } from "@facet/surface-kit";
import { logsRegistry } from "../../../examples/logs/http";
import { todoRegistry } from "../../../examples/todo/registry";

/**
 * Test hosts for the parity suite — the "you bring the spine" seam, wired once over the example domains so the
 * generic `@facet/parity` drivers have something to run. The harness is parameterized over a {@link ParityHosts}
 * bundle; these factories produce one for the todo and logs registries, with the SCOPES granted identically on
 * every leg (the raw-`execute()` baseline included), because parity is only meaningful when each leg
 * authenticates as the same principal with the same authority — the only thing that may differ between legs is
 * the surface, never the policy.
 *
 * The scope grant is a PARAMETER so a single domain can be driven both authorized (the full grant) and
 * UNDER-authorized (an empty grant) — that is how the suite proves `forbidden` parity: the same `todos.list`
 * read refused by every leg because the principal lacks `todos:read`, the refusal coming from `execute()`'s
 * one authz step, not from any surface.
 *
 * CARVE NOTE: nothing tenant-shaped leaks in. Each seam returns only `{ actor, scopes, ledger? }` (or a
 * Context built from them); a multi-tenant host would fold its tenant into `scopes` inside these functions,
 * exactly as the carve requires — the harness never learns what a tenant is.
 */

/** The trusted dev principal every leg authenticates as. A real host derives this from a verified session. */
const ACTOR: Actor = { kind: "user", id: "dev@example.com", email: "dev@example.com" };

/**
 * Build a {@link ParityHosts} over a registry factory, granting exactly `scopes` on every leg. The five seams
 * are the precise authenticators the five legs need, each closing over the SAME actor + scopes so a divergence
 * can only be the surface. Reads/writes do not exercise the ledger in these cases, so none is supplied (the
 * suite's assertions are over output + error taxonomy + stream order, not idempotency replay).
 */
function makeHosts(registry: () => Registry, scopes: string[]): ParityHosts {
  return {
    registry,
    // The raw baseline's Context: actor + scopes + the per-call confirm/idempotency, built directly.
    executeContextFor: ({ confirm, idempotencyKey }): Context =>
      buildContext({ actor: ACTOR, scopes, surface: "agent", confirm, idempotencyKey }),
    // Every surface seam returns the SAME shared `{ actor, scopes }` (`AuthParts`); the surface builds the
    // Context. Only the argument each transport hands differs (headers / the parsed actor / a capability id).
    authenticate: () => ({ actor: ACTOR, scopes }),
    cliContextFor: (actor): AuthParts => ({ actor, scopes }),
    mcpContextFor: (): AuthParts => ({ actor: ACTOR, scopes }),
    agentContextFor: () => ({ actor: ACTOR, scopes }),
  };
}

/** Parity hosts over the todo registry, granting `scopes` (default: full read+write) on every leg. */
export function todoHosts(scopes: string[] = ["todos:read", "todos:write"]): ParityHosts {
  return makeHosts(todoRegistry, scopes);
}

/** Parity hosts over the logs registry, granting `scopes` (default: the logs/jobs grant) on every leg. */
export function logsHosts(
  scopes: string[] = ["logs:read", "jobs:read", "jobs:write"],
): ParityHosts {
  return makeHosts(logsRegistry, scopes);
}
