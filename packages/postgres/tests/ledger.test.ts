import { describe, expect, test } from "bun:test";
import { buildContext, defineCapability, execute, Registry } from "@facet/core";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { z } from "zod";
import { PgLedger } from "../src/ledger";
import type { FacetPgDatabase } from "../src/types";

/**
 * These tests prove the adapter two ways:
 *  1. UNIT — a recording fake renders each statement to `{ sql, params }` (via Drizzle's own `PgDialect`) so
 *     we assert the exact parameterized SQL and the won/lost/replay mapping, including BOTH driver result
 *     shapes (`{ rows }` and a bare array).
 *  2. END-TO-END — a stateful fake that emulates the table's unique-constraint semantics drives the REAL
 *     `execute()` chokepoint twice with one idempotency key, proving PgLedger makes a write replay rather
 *     than re-run. No live Postgres needed; the unique-insert behavior is what we emulate.
 */

const dialect = new PgDialect();
type Rendered = { sql: string; params: unknown[] };

/** A fake db that records every statement (rendered to SQL+params) and returns whatever the responder gives. */
class RecordingDb implements FacetPgDatabase {
  calls: Rendered[] = [];
  constructor(private readonly responder: (q: Rendered, i: number) => unknown) {}
  async execute(query: SQL): Promise<unknown> {
    const q = dialect.sqlToQuery(query);
    const rendered: Rendered = { sql: q.sql, params: q.params };
    this.calls.push(rendered);
    return this.responder(rendered, this.calls.length - 1);
  }
  async transaction<T>(fn: (tx: FacetPgDatabase) => Promise<T>): Promise<T> {
    return fn(this);
  }
}

describe("PgLedger — statement shape & result mapping", () => {
  test("claim emits an atomic insert-once and returns 'won' when a row comes back", async () => {
    const db = new RecordingDb(() => ({ rows: [{ key: "k1" }] }));
    expect(await new PgLedger(db).claim("k1", "jobs.start")).toBe("won");
    expect(db.calls[0]?.sql).toContain("INSERT INTO facet_idempotency");
    expect(db.calls[0]?.sql).toContain("ON CONFLICT (key, capability_id) DO NOTHING");
    expect(db.calls[0]?.sql).toContain("RETURNING key");
    expect(db.calls[0]?.params).toEqual(["k1", "jobs.start"]);
  });

  test("claim returns 'lost' when the conflict suppressed the insert (no row)", async () => {
    const db = new RecordingDb(() => ({ rows: [] }));
    expect(await new PgLedger(db).claim("k1", "jobs.start")).toBe("lost");
  });

  test("claim accepts the postgres.js array result shape too", async () => {
    const db = new RecordingDb(() => [{ key: "k1" }]);
    expect(await new PgLedger(db).claim("k1", "jobs.start")).toBe("won");
  });

  test("commit writes the result as bound JSON text and flips committed", async () => {
    const db = new RecordingDb(() => ({ rows: [] }));
    await new PgLedger(db).commit("k1", "jobs.start", { id: "job_1" });
    expect(db.calls[0]?.sql).toContain("UPDATE facet_idempotency");
    expect(db.calls[0]?.sql).toContain("committed = true");
    expect(db.calls[0]?.params).toEqual([JSON.stringify({ id: "job_1" }), "k1", "jobs.start"]);
  });

  test("read JSON.parses the stored text, so the value is identical across drivers", async () => {
    // `result` is a TEXT column holding JSON text; read parses it back to the original value.
    const committed = new RecordingDb(() => ({
      rows: [{ result: JSON.stringify({ id: "job_1" }) }],
    }));
    expect(await new PgLedger(committed).read("k1", "jobs.start")).toEqual({ id: "job_1" });
    expect(committed.calls[0]?.sql).toContain("committed = true");

    const inflight = new RecordingDb(() => ({ rows: [] }));
    expect(await new PgLedger(inflight).read("k1", "jobs.start")).toBeUndefined();
  });
});

/** A stateful fake that emulates `facet_idempotency`'s unique-insert/commit/read semantics by verb-sniffing. */
function makeLedgerDb(): FacetPgDatabase {
  const store = new Map<string, string>(); // pk → committed result as JSON TEXT, exactly as the text column holds it
  const claimed = new Set<string>();
  const pk = (key: string, cap: string) => `${cap}::${key}`;
  const db: FacetPgDatabase = {
    async execute(query: SQL): Promise<unknown> {
      const { sql: text, params } = dialect.sqlToQuery(query);
      if (text.includes("INSERT INTO facet_idempotency")) {
        const [key, cap] = params as [string, string];
        const k = pk(key, cap);
        if (claimed.has(k)) return { rows: [] }; // unique violation → no row → lost
        claimed.add(k);
        return { rows: [{ key }] }; // inserted → won
      }
      if (text.includes("UPDATE facet_idempotency")) {
        const [json, key, cap] = params as [string, string, string];
        store.set(pk(key, cap), json); // store the JSON text verbatim, like the text column
        return { rows: [] };
      }
      if (text.includes("SELECT result FROM facet_idempotency")) {
        const [key, cap] = params as [string, string];
        const k = pk(key, cap);
        return { rows: store.has(k) ? [{ result: store.get(k) }] : [] }; // returns JSON text, which read parses
      }
      throw new Error(`unexpected SQL: ${text}`);
    },
    async transaction<T>(fn: (tx: FacetPgDatabase) => Promise<T>): Promise<T> {
      return fn(db);
    },
  };
  return db;
}

describe("PgLedger — drives execute() idempotency end-to-end", () => {
  test("a write runs once for the winner and replays for the retry", async () => {
    const registry = new Registry();
    let runs = 0;
    registry.register(
      defineCapability({
        id: "jobs.start",
        summary: "Start a job.",
        input: z.object({ name: z.string() }),
        output: z.object({ id: z.string(), runs: z.number() }),
        scopes: [],
        risk: "write",
        idempotent: true,
        handler: async (input) => ({ id: `job_${input.name}`, runs: ++runs }),
      }),
    );

    const ledger = new PgLedger(makeLedgerDb());
    const ctx = () =>
      buildContext({
        actor: { kind: "service" },
        scopes: ["*"],
        surface: "agent",
        confirm: true,
        idempotencyKey: "k1",
        ledger,
      });

    const first = await execute(registry, "jobs.start", { name: "nightly" }, ctx());
    const second = await execute(registry, "jobs.start", { name: "nightly" }, ctx());

    expect(first).toEqual({ id: "job_nightly", runs: 1 });
    expect(second).toEqual({ id: "job_nightly", runs: 1 }); // replayed, NOT re-run
    expect(runs).toBe(1);
  });
});
