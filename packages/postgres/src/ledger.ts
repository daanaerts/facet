import type { Ledger } from "@facet/core";
import { sql } from "drizzle-orm";
import type { FacetPgDatabase } from "./types";

/**
 * Normalize the two driver result shapes into a plain row array: node-postgres returns `{ rows: [...] }`,
 * postgres.js returns the array directly. Everything `PgLedger` reads goes through here, so the adapter is
 * agnostic to which Drizzle server flavor backs it.
 */
function rowsOf(res: unknown): Record<string, unknown>[] {
  if (Array.isArray(res)) return res as Record<string, unknown>[];
  if (res && typeof res === "object" && "rows" in res) {
    return ((res as { rows?: Record<string, unknown>[] }).rows ?? []) as Record<string, unknown>[];
  }
  return [];
}

/**
 * A Postgres-backed {@link Ledger} — the production adapter for Facet's idempotency dedup port. It is built on
 * the ONE primitive the port's contract calls for: an ATOMIC insert-once, which Postgres gives for free via
 * the table's `PRIMARY KEY (key, capability_id)`. So the engine never needs a lock of its own.
 *
 *   - `claim`  → `INSERT ... ON CONFLICT DO NOTHING RETURNING key`. A row came back ⇒ THIS caller inserted
 *                first ⇒ `"won"` (it runs the handler and `commit`s). No row ⇒ the key is already held ⇒
 *                `"lost"` (it must NOT run; it `read`s the winner's result instead).
 *   - `commit` → store the winner's validated result against the claimed row and flip `committed`.
 *   - `read`   → return ONLY a committed result. A winner that is mid-flight (claimed, not yet committed)
 *                reads as `undefined` — which is exactly what makes `execute()` surface `conflict` (409) to a
 *                loser rather than replay a half-finished value.
 *
 * Pass any Drizzle Postgres `db` (see {@link FacetPgDatabase}). The table is the one in `./schema`
 * (`facet_idempotency`); create it with that Drizzle table object via drizzle-kit, or with the shipped
 * `migrations/0001_facet_idempotency.sql`. This adapter knows nothing of your domain tables.
 */
export class PgLedger implements Ledger {
  constructor(private readonly db: FacetPgDatabase) {}

  async claim(key: string, capabilityId: string): Promise<"won" | "lost"> {
    const res = await this.db.execute(sql`
      INSERT INTO facet_idempotency (key, capability_id)
      VALUES (${key}, ${capabilityId})
      ON CONFLICT (key, capability_id) DO NOTHING
      RETURNING key
    `);
    return rowsOf(res).length === 1 ? "won" : "lost";
  }

  async commit(key: string, capabilityId: string, result: unknown): Promise<void> {
    // `result` is stored as JSON TEXT, not jsonb: the ledger never queries inside it (it's an opaque replay
    // blob), and a TEXT column round-trips identically on every driver. A jsonb column does NOT — drivers
    // disagree on whether a bound parameter is JSON-encoded (Bun's SQL double-encodes a `JSON.stringify`'d
    // string; node-postgres won't encode a bare string at all), so jsonb here is a portability hazard for zero
    // gain. We JSON.stringify on the way in and JSON.parse on the way out, and that's the whole contract.
    await this.db.execute(sql`
      UPDATE facet_idempotency
      SET result = ${JSON.stringify(result)}, committed = true
      WHERE key = ${key} AND capability_id = ${capabilityId}
    `);
  }

  async read(key: string, capabilityId: string): Promise<unknown> {
    const res = await this.db.execute(sql`
      SELECT result FROM facet_idempotency
      WHERE key = ${key} AND capability_id = ${capabilityId} AND committed = true
    `);
    const text = rowsOf(res)[0]?.result;
    return typeof text === "string" ? JSON.parse(text) : undefined;
  }
}
