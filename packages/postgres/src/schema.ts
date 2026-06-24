import { boolean, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

/**
 * The ONE infra table this package needs — the idempotency ledger {@link PgLedger} reads and writes. It is NOT
 * a domain table: per `(idempotency key, capability id)` it holds the winning caller's committed `result` so
 * every later retry REPLAYS instead of re-running. `committed` distinguishes a claimed-but-in-flight row (the
 * winner is still running its handler) from a finished one, so a loser that reads too early gets nothing and
 * the engine returns `conflict` (409) rather than a half-baked value.
 *
 * Exposed at the `@facet/postgres/schema` subpath as a Drizzle table object so a drizzle-kit shop can fold it
 * into its own schema and let its normal migration pipeline create it — one migration story alongside the
 * domain tables. A host that does not use drizzle-kit applies the identical `migrations/0001_facet_idempotency.sql`
 * instead. The column names here, the raw SQL in `ledger.ts`, and that `.sql` file are kept byte-for-byte
 * aligned on purpose.
 */
export const facetIdempotency = pgTable(
  "facet_idempotency",
  {
    key: text("key").notNull(),
    capabilityId: text("capability_id").notNull(),
    // JSON TEXT, not jsonb — an opaque replay blob the ledger never queries into; TEXT round-trips identically
    // across drivers (jsonb does not — see the note in `ledger.ts` commit()).
    result: text("result"),
    committed: boolean("committed").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.key, t.capabilityId] })],
);
