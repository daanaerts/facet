/**
 * A SQLite-backed to-do domain — the world the todo capabilities act on, now PERSISTENT and SHARED across
 * processes. The framework still knows NOTHING about this: the capabilities import this module exactly as
 * before (`store.add` / `store.list` / `store.complete` / `store.remove` / `store.get`), and NOT ONE
 * capability changed when the store moved from an in-memory `Map` to SQLite. That is the spine-free point made
 * concrete — persistence is the host's concern, swapped behind an unchanged store API.
 *
 * Because every entrypoint (`serve.ts` / `cli.ts` / `mcp.ts`) opens the SAME database file, a todo added on
 * the CLI shows up in the browser and to an MCP agent, and vice versa: one world, four surfaces. It uses
 * Bun's built-in `bun:sqlite` — no dependency, no build (Bun-first; a Node host would put `node:sqlite` /
 * `better-sqlite3` behind this same API).
 *
 * DB location: the `TODO_DB` env var, else a file under `examples/todo/.data/` (git-ignored). The test run
 * sets `TODO_DB=:memory:` (see the repo `bunfig.toml` preload) so tests never touch — or depend on — the
 * persisted demo file.
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface Todo {
  id: string;
  title: string;
  done: boolean;
  /** ISO timestamp the todo was added, so a list is stably orderable oldest-first. */
  createdAt: string;
}

/** A raw row as SQLite returns it: `done` is 0/1, `n` is the autoincrement id behind `todo_<n>`. */
interface Row {
  n: number;
  title: string;
  done: number;
  createdAt: string;
}

const DB_PATH = process.env.TODO_DB ?? `${import.meta.dir}/.data/todos.db`;
if (DB_PATH !== ":memory:") mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.exec("PRAGMA journal_mode = WAL"); // let a long-running server and a one-shot CLI touch the file at once

function createTable(): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS todos (
       n         INTEGER PRIMARY KEY AUTOINCREMENT,
       title     TEXT    NOT NULL,
       done      INTEGER NOT NULL DEFAULT 0,
       createdAt TEXT    NOT NULL
     )`,
  );
}
createTable();

/**
 * A fixed clock for the seed and for deterministic tests. `store.add` stamps `createdAt` from `clock()`, which
 * tests override via `reset` so a created todo's timestamp is reproducible (cross-surface parity compares
 * whole outputs).
 */
let clock: () => string = () => new Date().toISOString();

const rowToTodo = (r: Row): Todo => ({
  id: `todo_${r.n}`,
  title: r.title,
  done: r.done !== 0,
  createdAt: r.createdAt,
});

/** `todo_<n>` → `<n>`, or `null` for a malformed id (which then reads as a clean not-found). */
function idToN(id: string): number | null {
  const m = /^todo_(\d+)$/.exec(id);
  return m ? Number(m[1]) : null;
}

/** The internal insert used by both the seed and the capability — stamps the clock, returns the new row. */
function insert(title: string): Todo {
  const createdAt = clock();
  const { n } = db
    .query("INSERT INTO todos (title, done, createdAt) VALUES (?, 0, ?) RETURNING n")
    .get(title, createdAt) as { n: number };
  return { id: `todo_${n}`, title, done: false, createdAt };
}

function seedTwo(): void {
  insert("buy milk");
  insert("write the README");
}

export const store = {
  /** Add a todo and return it. The `todos.add` capability calls this once per (deduped) request. */
  add(title: string): Todo {
    return insert(title);
  },
  /** Every todo, oldest-first by creation order — what `todos.list` and `todos.watch` walk over. */
  list(filter?: { done?: boolean }): Todo[] {
    const rows =
      filter?.done === undefined
        ? (db.query("SELECT * FROM todos ORDER BY n").all() as Row[])
        : (db
            .query("SELECT * FROM todos WHERE done = ? ORDER BY n")
            .all(filter.done ? 1 : 0) as Row[]);
    return rows.map(rowToTodo);
  },
  /** One todo by id, or `undefined` — `todos.complete` / `todos.remove` 404 on `undefined`. */
  get(id: string): Todo | undefined {
    const n = idToN(id);
    if (n === null) return undefined;
    const r = db.query("SELECT * FROM todos WHERE n = ?").get(n) as Row | null;
    return r ? rowToTodo(r) : undefined;
  },
  /** Mark a todo done and return the updated row, or `undefined` if it is absent. */
  complete(id: string): Todo | undefined {
    const n = idToN(id);
    if (n === null) return undefined;
    const r = db.query("UPDATE todos SET done = 1 WHERE n = ? RETURNING *").get(n) as Row | null;
    return r ? rowToTodo(r) : undefined;
  },
  /** Remove a todo; returns whether a row was actually deleted (so the caller can 404 a miss). */
  remove(id: string): boolean {
    const n = idToN(id);
    if (n === null) return false;
    const r = db.query("DELETE FROM todos WHERE n = ? RETURNING n").get(n) as { n: number } | null;
    return r !== null;
  },
  /** Test helper — reset to seed state, optionally pinning the clock so `createdAt` is reproducible. */
  reset(c?: () => string): void {
    clock = c ?? (() => new Date().toISOString());
    // DROP + recreate resets the AUTOINCREMENT cleanly, so the seeds are todo_1/todo_2 and the next add is
    // todo_3 again — what the parity tests pin. Only ever called by tests (on the :memory: db).
    db.exec("DROP TABLE IF EXISTS todos");
    createTable();
    seedTwo();
  },
};

// Seed ONLY when the store is empty — a fresh file (or :memory:) starts with two todos to poke at, but a
// second process opening an EXISTING file must NOT wipe it (sharing one world is the whole point).
if ((db.query("SELECT COUNT(*) AS c FROM todos").get() as { c: number }).c === 0) seedTwo();
