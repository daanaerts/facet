-- @facet/postgres — the idempotency ledger table backing PgLedger.
-- Apply this if you do NOT use drizzle-kit; otherwise fold `facetIdempotency` from
-- `@facet/postgres/schema` into your Drizzle schema and let your normal migration pipeline create it.
-- The shape here is byte-for-byte aligned with `src/schema.ts` and the raw SQL in `src/ledger.ts`.

CREATE TABLE IF NOT EXISTS facet_idempotency (
  key           text        NOT NULL,
  capability_id text        NOT NULL,
  result        text,        -- JSON text: an opaque replay blob, never queried into (see ledger.ts)
  committed     boolean     NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (key, capability_id)
);
