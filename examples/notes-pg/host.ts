import type { Actor, Context, Ledger } from "@facet/core";
import { buildContext } from "@facet/core";
import { PgLedger } from "@facet/postgres";
import { db } from "./db";

/**
 * The host seam — this demo's ENTIRE contribution to the framework. It answers "who is calling, in what
 * workspace, and what may they do", and supplies the idempotency ledger. The workspace lives in `claims`
 * (opaque to the engine, read by the store to drive RLS); it is NOT a framework concept.
 */

/**
 * A per-workspace VIEW of a base ledger: it prefixes every idempotency key with `"<workspace>::"` so two
 * tenants' identical keys land on distinct rows and never replay across the tenant boundary — the multi-tenant
 * dedup nuance, folded in at the host seam exactly as the carve requires (the engine never learns what a
 * workspace is). One shared {@link PgLedger} sits underneath, opened lazily.
 */
function scopedLedger(base: Ledger, workspace: string): Ledger {
  const scope = (key: string) => `${workspace}::${key}`;
  return {
    claim: (key, capabilityId) => base.claim(scope(key), capabilityId),
    commit: (key, capabilityId, result) => base.commit(scope(key), capabilityId, result),
    read: (key, capabilityId) => base.read(scope(key), capabilityId),
  };
}

let base: PgLedger | undefined;
function baseLedger(): PgLedger {
  if (!base) base = new PgLedger(db());
  return base;
}

/**
 * Build a Context for a caller in a given workspace. The SURFACE would normally do this from a verified
 * session; the demo hands the workspace in directly. Scopes grant read+write on notes; the ledger is namespaced
 * by workspace; the workspace is also placed in `claims` so the store can scope rows via RLS.
 */
export function contextFor(
  workspace: string,
  opts: { actor?: Actor; confirm?: boolean; idempotencyKey?: string } = {},
): Context {
  return buildContext({
    actor: opts.actor ?? { kind: "agent", agentId: `notes:${workspace}` },
    scopes: ["notes:read", "notes:write"],
    surface: "agent",
    confirm: opts.confirm ?? false,
    idempotencyKey: opts.idempotencyKey,
    ledger: scopedLedger(baseLedger(), workspace),
    claims: { workspaceId: workspace },
  });
}
