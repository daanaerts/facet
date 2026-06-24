import type { Context } from "./context";
import { FacetError } from "./errors";

/**
 * Typed accessors for `Context.claims` — the host-set bag of "who, and in what tenant/role" (see
 * `Context.claims`). The engine attaches ZERO semantics to claims (exactly as it does nothing with `scopes`
 * beyond `requireScope`); these helpers are the sanctioned READ side so a handler — or a host's own policy —
 * pulls `ctx.claims.workspaceId` through one typed call instead of re-deriving a tenant from stringly-typed
 * `"scope:"`-prefixed strings in every app (the pattern all ten dogfood hosts hand-wrote).
 *
 * `Context` is deliberately NOT generic over its claims — that would ripple a type parameter through the
 * whole engine. The trade is intentional: the caller names the value type at the read site (`requireClaim<T>`
 * / `claimOf<T>`). The cast is unchecked by construction — the host owns the claim shape — exactly as a host
 * owns what its scopes mean.
 */

/**
 * Read a REQUIRED claim. Throws a clear `FacetError` (`unauthorized`, the same code a missing principal maps
 * to) when the key is absent or its value is `undefined`, so a handler that depends on `ctx.claims.workspaceId`
 * fails loudly at the read rather than silently threading an `undefined` tenant downstream. The caller names
 * the value type: `const workspaceId = requireClaim<string>(ctx, "workspaceId")`.
 */
export function requireClaim<T = unknown>(ctx: Context, key: string): T {
  const claims = ctx.claims;
  if (claims === undefined || claims[key] === undefined) {
    throw new FacetError("unauthorized", `missing required claim: ${key}`, 401, { claim: key });
  }
  return claims[key] as T;
}

/**
 * Read an OPTIONAL claim — `undefined` when `ctx.claims` is unset or the key is absent. The non-throwing
 * sibling of {@link requireClaim}, for a claim a handler can proceed without. The caller names the value type:
 * `const role = claimOf<string>(ctx, "role")`.
 */
export function claimOf<T = unknown>(ctx: Context, key: string): T | undefined {
  return ctx.claims?.[key] as T | undefined;
}
