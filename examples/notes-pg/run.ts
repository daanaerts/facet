import { execute } from "@facet/core";
import { close, reset, setup } from "./db";
import { contextFor } from "./host";
import { notesRegistry } from "./registry";

/**
 * A runnable end-to-end demo of `@facet/postgres` — RLS tenant isolation + PgLedger idempotency over the real
 * chokepoint. Start a database and run it:
 *
 *   docker compose up -d
 *   NOTES_PG_URL=postgres://facet:facet@localhost:5433/facet bun run examples/notes-pg/run.ts
 */

const reg = notesRegistry();
await setup();
await reset();

// Two workspaces write notes through the SAME capability.
await execute(reg, "notes.add", { body: "a-first" }, contextFor("ws_a", { confirm: true }));
await execute(reg, "notes.add", { body: "a-second" }, contextFor("ws_a", { confirm: true }));
await execute(reg, "notes.add", { body: "b-only" }, contextFor("ws_b", { confirm: true }));

// …and each sees ONLY its own, from one unchanged query — RLS does the scoping.
console.log("ws_a sees:", await execute(reg, "notes.list", {}, contextFor("ws_a")));
console.log("ws_b sees:", await execute(reg, "notes.list", {}, contextFor("ws_b")));

// Idempotency: the same key twice replays the first note instead of inserting a second.
const key = "add-once";
const first = await execute(
  reg,
  "notes.add",
  { body: "dedup-me" },
  contextFor("ws_a", { confirm: true, idempotencyKey: key }),
);
const second = await execute(
  reg,
  "notes.add",
  { body: "dedup-me" },
  contextFor("ws_a", { confirm: true, idempotencyKey: key }),
);
console.log("idempotent add — same row replayed:", first, second);
console.log("ws_a final:", await execute(reg, "notes.list", {}, contextFor("ws_a")));

await close();
