import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { execute } from "@facet/core";
import { close, reset, setup } from "../db";
import { contextFor } from "../host";
import { notesRegistry } from "../registry";

/**
 * THE HEADLESS PROOF for the notes-pg domain — RLS isolation + idempotency through the real `execute()`
 * chokepoint on a live Postgres. GATED on `FACET_TEST_DATABASE_URL` (so `bun test` skips it with no DB and
 * never touches an ambient `DATABASE_URL`): `docker compose up -d && bun run test:pg`.
 */

const URL = process.env.FACET_TEST_DATABASE_URL ?? "";

describe.skipIf(!URL)("notes-pg — RLS isolation + idempotency on a live Postgres", () => {
  const reg = notesRegistry();

  beforeAll(async () => setup());
  beforeEach(async () => reset());
  afterAll(async () => close());

  test("RLS scopes a list to the caller's workspace — one unchanged capability, two result sets", async () => {
    await execute(reg, "notes.add", { body: "a1" }, contextFor("ws_a", { confirm: true }));
    await execute(reg, "notes.add", { body: "a2" }, contextFor("ws_a", { confirm: true }));
    await execute(reg, "notes.add", { body: "b1" }, contextFor("ws_b", { confirm: true }));

    const a = (await execute(reg, "notes.list", {}, contextFor("ws_a"))) as {
      notes: { body: string }[];
    };
    const b = (await execute(reg, "notes.list", {}, contextFor("ws_b"))) as {
      notes: { body: string }[];
    };

    expect(a.notes.map((n) => n.body).sort()).toEqual(["a1", "a2"]);
    expect(b.notes.map((n) => n.body)).toEqual(["b1"]);
  });

  test("idempotency replays the first note instead of inserting a second", async () => {
    const key = "k-dedup";
    const make = () => contextFor("ws_a", { confirm: true, idempotencyKey: key });
    const first = await execute(reg, "notes.add", { body: "once" }, make());
    const second = await execute(reg, "notes.add", { body: "once" }, make());

    expect(second).toEqual(first);
    const list = (await execute(reg, "notes.list", {}, contextFor("ws_a"))) as {
      notes: { body: string }[];
    };
    expect(list.notes.filter((n) => n.body === "once")).toHaveLength(1);
  });

  test("the same idempotency key in a DIFFERENT workspace does NOT cross-replay", async () => {
    const key = "shared-key";
    const a = await execute(
      reg,
      "notes.add",
      { body: "from-a" },
      contextFor("ws_a", { confirm: true, idempotencyKey: key }),
    );
    const b = await execute(
      reg,
      "notes.add",
      { body: "from-b" },
      contextFor("ws_b", { confirm: true, idempotencyKey: key }),
    );
    // Distinct rows in distinct workspaces — the host's per-workspace ledger namespacing kept them apart.
    expect((a as { body: string }).body).toBe("from-a");
    expect((b as { body: string }).body).toBe("from-b");
  });
});
