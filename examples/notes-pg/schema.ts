import { pgTable, serial, text } from "drizzle-orm/pg-core";

/**
 * A multi-tenant notes domain on Postgres — the world the `notes.*` capabilities act on. Every row carries its
 * owning `workspace`; the RLS policy set up in `db.ts` scopes reads/writes to the caller's workspace, so a
 * handler NEVER writes a tenant `WHERE` clause (forgetting it is structurally impossible). The framework knows
 * nothing of this table — the capabilities import the store exactly as the `todo` demo imports its SQLite one.
 */
export const notes = pgTable("notes", {
  id: serial("id").primaryKey(),
  workspace: text("workspace").notNull(),
  body: text("body").notNull(),
});

/**
 * The idempotency ledger table re-exported from the adapter, so this example's schema is the SINGLE place a
 * drizzle-kit pipeline would look — the recommended "fold `facetIdempotency` into your own schema" pattern.
 */
export { facetIdempotency } from "@facet/postgres/schema";
