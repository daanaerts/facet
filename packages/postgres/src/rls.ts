import type { Context } from "@facet/core";
import { sql } from "drizzle-orm";
import type { FacetPgDatabase } from "./types";

/**
 * How `withClaims` should adopt the caller before running the work — the one place the RLS *convention* is
 * named, so the package carries the MECHANISM (push claims into the transaction) while the HOST owns the
 * MEANING (which role, which claim maps to which GUC). Nothing here is hardcoded: no `workspaceId`, no
 * `facet.*` setting name, no role. That keeps `ctx.claims` opaque to Facet — this helper just plumbs it.
 */
export interface RlsConfig {
  /**
   * `SET LOCAL ROLE <role>` before the work. Adopt a NON-OWNER role here: a table's owner (and a superuser)
   * BYPASSES row-level security, so connecting/working as the owner silently defeats every policy. Omit to
   * skip the role switch entirely.
   */
  role?: string;
  /**
   * Map of `ctx.claims` key → Postgres GUC name. For each entry whose claim is present, emit
   * `SELECT set_config('<guc>', '<value>', true)` so an RLS policy can read it via `current_setting('<guc>')`.
   * Example: `{ workspaceId: "facet.workspace_id" }` lets a policy do
   * `USING (workspace_id = current_setting('facet.workspace_id')::uuid)`.
   */
  settings?: Record<string, string>;
}

/**
 * Run `work` inside a transaction that has ADOPTED the caller's claims, so Postgres RLS policies fire against
 * the right identity — the claims→DDL bridge. This is defense-in-depth UNDER Facet's chokepoint, never a
 * replacement for it: `execute()` still authorizes the *verb* (the capability's `scopes`); RLS only adds
 * *row* visibility in the database.
 *
 * Everything is transaction-scoped on purpose — `SET LOCAL ROLE` and `set_config(_, _, true)` are released at
 * COMMIT/ROLLBACK — so the adopted role and GUCs CANNOT leak to the next checkout under a transaction pooler
 * (PgBouncer). That pooler-safety is the whole reason the role switch lives inside `transaction()` and not as
 * a bare session `SET`.
 *
 * The `tx` handed to `work` is the same `FacetPgDatabase` shape, so a store method runs its Drizzle queries on
 * it normally — with no tenant `WHERE` clause, because the policy supplies it:
 *
 *   withClaims(db, ctx, { role: "facet_app", settings: { workspaceId: "facet.workspace_id" } },
 *     (tx) => tx.execute(sql`SELECT * FROM todos`))   // RLS scopes the rows to the caller's workspace
 */
export function withClaims<T>(
  db: FacetPgDatabase,
  ctx: Context,
  config: RlsConfig,
  work: (tx: FacetPgDatabase) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    if (config.role !== undefined) {
      await tx.execute(sql`SET LOCAL ROLE ${sql.identifier(config.role)}`);
    }
    for (const [claimKey, guc] of Object.entries(config.settings ?? {})) {
      const value = ctx.claims?.[claimKey];
      if (value !== undefined) {
        await tx.execute(sql`SELECT set_config(${guc}, ${String(value)}, true)`);
      }
    }
    return work(tx);
  });
}
