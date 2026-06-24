import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";

/**
 * The Postgres connection for the notes demo — LAZY on purpose. Nothing connects at import time, so importing a
 * capability file (which pulls in the store, which pulls in this) is side-effect-free without a database; the
 * connection opens only when a handler actually runs. The URL comes from `NOTES_PG_URL`, else `DATABASE_URL`,
 * else the test var `FACET_TEST_DATABASE_URL` (so `bun run test:pg` lights this up too).
 *
 * It uses Bun's built-in SQL via `drizzle-orm/bun-sql` — no driver dependency, the same Bun-first spirit as the
 * `todo` demo's `bun:sqlite`. A Node host would swap `drizzle-orm/node-postgres` behind this same module with
 * no change to a capability or the store.
 */
const URL =
  process.env.NOTES_PG_URL ?? process.env.DATABASE_URL ?? process.env.FACET_TEST_DATABASE_URL ?? "";

let handle: ReturnType<typeof drizzle> | undefined;

/** The shared Drizzle db, opened on first use. Throws a clear message if no connection string is configured. */
export function db(): ReturnType<typeof drizzle> {
  if (!URL) {
    throw new Error(
      "notes-pg: set NOTES_PG_URL (or DATABASE_URL) to a Postgres connection string — e.g. " +
        "`docker compose up -d` then NOTES_PG_URL=postgres://facet:facet@localhost:5433/facet`",
    );
  }
  if (!handle) handle = drizzle(URL);
  return handle;
}

/** Close the pool — call once when a one-shot script (or a test run) is done. */
export async function close(): Promise<void> {
  if (handle) await handle.$client.close();
}

/**
 * Create the tables, the non-owner app role, and the tenant RLS policy — the host's persistence setup, run once
 * at startup. It is idempotent (`IF NOT EXISTS` / `DROP POLICY IF EXISTS`), exactly like the `todo` demo's
 * `CREATE TABLE`. The policy reads `current_setting('notes.workspace')`, which `withClaims` (see `store.ts`)
 * sets per call; `WITH CHECK` constrains INSERTs to the caller's workspace too, so RLS guards writes as well as
 * reads.
 */
export async function setup(): Promise<void> {
  const d = db();
  await d.execute(
    sql`CREATE TABLE IF NOT EXISTS notes (id serial PRIMARY KEY, workspace text NOT NULL, body text NOT NULL)`,
  );
  await d.execute(sql`
    CREATE TABLE IF NOT EXISTS facet_idempotency (
      key text NOT NULL, capability_id text NOT NULL, result text,
      committed boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (key, capability_id)
    )`);
  await d.execute(sql`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'notes_app') THEN CREATE ROLE notes_app NOLOGIN; END IF;
    END $$`);
  await d.execute(sql`GRANT SELECT, INSERT ON notes TO notes_app`);
  await d.execute(sql`GRANT USAGE, SELECT ON SEQUENCE notes_id_seq TO notes_app`);
  await d.execute(sql`ALTER TABLE notes ENABLE ROW LEVEL SECURITY`);
  await d.execute(sql`DROP POLICY IF EXISTS tenant_isolation ON notes`);
  await d.execute(sql`
    CREATE POLICY tenant_isolation ON notes
      USING (workspace = current_setting('notes.workspace', true))
      WITH CHECK (workspace = current_setting('notes.workspace', true))`);
}

/** Reset to an empty world (tests call this). Truncating both tables also clears the idempotency ledger. */
export async function reset(): Promise<void> {
  await db().execute(sql`TRUNCATE notes, facet_idempotency RESTART IDENTITY`);
}
