import { describe, expect, test } from "bun:test";
import { buildContext } from "@facet/core";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { withClaims } from "../src/rls";
import type { FacetPgDatabase } from "../src/types";

const dialect = new PgDialect();
type Rendered = { sql: string; params: unknown[] };

/** Records statements and whether each ran inside a transaction (so we can prove SET LOCAL is txn-scoped). */
class TxRecordingDb implements FacetPgDatabase {
  calls: Rendered[] = [];
  inTransaction = false;
  async execute(query: SQL): Promise<unknown> {
    const q = dialect.sqlToQuery(query);
    this.calls.push({ sql: q.sql, params: q.params });
    return { rows: [] };
  }
  async transaction<T>(fn: (tx: FacetPgDatabase) => Promise<T>): Promise<T> {
    this.inTransaction = true;
    try {
      return await fn(this);
    } finally {
      this.inTransaction = false;
    }
  }
}

function ctxWithClaims(claims: Record<string, unknown>) {
  return buildContext({ actor: { kind: "service" }, scopes: ["*"], surface: "agent", claims });
}

describe("withClaims — claims→RLS bridge", () => {
  test("adopts the role then sets a GUC from claims, inside one transaction, before the work", async () => {
    const db = new TxRecordingDb();
    let workRanInTxn = false;

    const result = await withClaims(
      db,
      ctxWithClaims({ workspaceId: "ws_123" }),
      { role: "facet_app", settings: { workspaceId: "facet.workspace_id" } },
      async () => {
        workRanInTxn = db.inTransaction;
        return "ok";
      },
    );

    expect(result).toBe("ok");
    expect(workRanInTxn).toBe(true); // the work ran inside the transaction the bridge opened

    // statement 1: the (txn-scoped) role switch
    expect(db.calls[0]?.sql).toContain("SET LOCAL ROLE");
    expect(db.calls[0]?.sql).toContain('"facet_app"');
    // statement 2: the GUC, both name and value bound as parameters
    expect(db.calls[1]?.sql).toContain("set_config");
    expect(db.calls[1]?.params).toEqual(["facet.workspace_id", "ws_123"]);
  });

  test("skips a setting whose claim is absent, and skips the role switch when no role is given", async () => {
    const db = new TxRecordingDb();
    await withClaims(
      db,
      ctxWithClaims({ workspaceId: "ws_123" }), // no `role` claim present
      { settings: { workspaceId: "facet.workspace_id", role: "facet.role" } },
      async () => undefined,
    );
    // only the present claim produced a set_config; no SET LOCAL ROLE at all
    expect(db.calls.map((c) => c.sql).some((s) => s.includes("SET LOCAL ROLE"))).toBe(false);
    expect(db.calls).toHaveLength(1);
    expect(db.calls[0]?.params).toEqual(["facet.workspace_id", "ws_123"]);
  });
});
