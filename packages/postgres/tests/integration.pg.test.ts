import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { buildContext } from "@facet/core";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";
import { PgLedger } from "../src/ledger";
import { withClaims } from "../src/rls";
import type { FacetPgDatabase } from "../src/types";

/**
 * THE LIVE PROOF — `@facet/postgres` against a REAL Postgres. Unlike the fake-backed unit tests, this exercises
 * the two things only a real database can prove: the `PRIMARY KEY` makes `claim` atomic under genuine
 * concurrency, and Row-Level Security actually filters rows for a non-owner role.
 *
 * It is GATED on `FACET_TEST_DATABASE_URL` and SKIPS when unset, so `bun test` stays green with no services —
 * and it can never clobber an ambient `DATABASE_URL` by accident. Point it at a THROWAWAY database (it
 * DROP/CREATEs `facet_idempotency`, `rls_demo`, and a `facet_test_app` role):
 *
 *   docker compose up -d && bun run test:pg
 *
 * Uses Bun's built-in SQL via `drizzle-orm/bun-sql` — no driver dependency, consistent with the Bun-first
 * `todo` example's `bun:sqlite`. `drizzle(url)` returns a `BunSQLDatabase`, which satisfies `FacetPgDatabase`
 * structurally (the assignment below is the compile-time proof of that claim).
 */

const URL = process.env.FACET_TEST_DATABASE_URL ?? "";

describe.skipIf(!URL)("@facet/postgres against a live Postgres", () => {
  let db: ReturnType<typeof drizzle>;
  let pg: FacetPgDatabase;

  beforeAll(async () => {
    db = drizzle(URL);
    pg = db; // BunSQLDatabase ⊆ FacetPgDatabase — Drizzle-native, no cast

    // The idempotency ledger table PgLedger reads/writes (its name is fixed).
    await db.execute(sql`DROP TABLE IF EXISTS facet_idempotency`);
    await db.execute(sql`
      CREATE TABLE facet_idempotency (
        key           text        NOT NULL,
        capability_id text        NOT NULL,
        result        text,
        committed     boolean     NOT NULL DEFAULT false,
        created_at    timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (key, capability_id)
      )`);

    // An RLS demo table + a NON-OWNER role + a tenant policy. The connection user owns the table (so it
    // bypasses RLS for seeding); `withClaims` switches to `facet_test_app`, for whom the policy applies.
    await db.execute(sql`DROP TABLE IF EXISTS rls_demo`);
    await db.execute(sql`DROP ROLE IF EXISTS facet_test_app`);
    await db.execute(sql`CREATE ROLE facet_test_app NOLOGIN`);
    await db.execute(
      sql`CREATE TABLE rls_demo (id serial PRIMARY KEY, workspace text NOT NULL, body text NOT NULL)`,
    );
    await db.execute(sql`GRANT SELECT, INSERT ON rls_demo TO facet_test_app`);
    await db.execute(sql`GRANT USAGE, SELECT ON SEQUENCE rls_demo_id_seq TO facet_test_app`);
    await db.execute(sql`ALTER TABLE rls_demo ENABLE ROW LEVEL SECURITY`);
    await db.execute(
      sql`CREATE POLICY tenant_isolation ON rls_demo
            USING (workspace = current_setting('facet.test_workspace', true))`,
    );
    // Seed as the owner (RLS bypassed): two rows for ws_a, one for ws_b.
    await db.execute(
      sql`INSERT INTO rls_demo (workspace, body) VALUES ('ws_a','a1'), ('ws_a','a2'), ('ws_b','b1')`,
    );
  });

  afterAll(async () => {
    await db.execute(sql`DROP TABLE IF EXISTS rls_demo`);
    await db.execute(sql`DROP TABLE IF EXISTS facet_idempotency`);
    await db.execute(sql`DROP ROLE IF EXISTS facet_test_app`);
    await db.$client.close();
  });

  test("claim is atomic insert-once: 8 concurrent claims, exactly one wins", async () => {
    const led = new PgLedger(pg);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => led.claim("race-key", "jobs.start")),
    );
    expect(results.filter((r) => r === "won")).toHaveLength(1);
    expect(results.filter((r) => r === "lost")).toHaveLength(7);
  });

  test("commit→read replays the committed result; an in-flight or unknown key reads undefined", async () => {
    const led = new PgLedger(pg);
    expect(await led.claim("k1", "jobs.start")).toBe("won");
    expect(await led.read("k1", "jobs.start")).toBeUndefined(); // claimed, not yet committed
    await led.commit("k1", "jobs.start", { id: "job_1" });
    expect(await led.read("k1", "jobs.start")).toEqual({ id: "job_1" });
    expect(await led.claim("k1", "jobs.start")).toBe("lost"); // a later twin loses the claim
    expect(await led.read("never-claimed", "jobs.start")).toBeUndefined();
  });

  test("withClaims enforces RLS: each workspace sees ONLY its own rows", async () => {
    const ctxFor = (ws: string) =>
      buildContext({
        actor: { kind: "service" },
        scopes: ["*"],
        surface: "agent",
        claims: { workspaceId: ws },
      });
    const cfg = { role: "facet_test_app", settings: { workspaceId: "facet.test_workspace" } };
    const read = (ws: string) =>
      withClaims(pg, ctxFor(ws), cfg, (tx) =>
        tx.execute(sql`SELECT workspace FROM rls_demo`).then(rowsOf),
      );

    const a = await read("ws_a");
    const b = await read("ws_b");
    expect(a).toHaveLength(2);
    expect(new Set(a.map((r) => r.workspace))).toEqual(new Set(["ws_a"]));
    expect(b).toHaveLength(1);
    expect(new Set(b.map((r) => r.workspace))).toEqual(new Set(["ws_b"]));
  });

  test("the owner connection (no withClaims) sees all rows — proving the bridge is what scopes them", async () => {
    const all = rowsOf(await pg.execute(sql`SELECT workspace FROM rls_demo`));
    expect(all).toHaveLength(3);
  });
});

/** Normalize Bun-SQL / node-postgres result shapes into a plain row array. */
function rowsOf(res: unknown): Record<string, unknown>[] {
  if (Array.isArray(res)) return res as Record<string, unknown>[];
  if (res && typeof res === "object" && "rows" in res) {
    return ((res as { rows?: Record<string, unknown>[] }).rows ?? []) as Record<string, unknown>[];
  }
  return [];
}
