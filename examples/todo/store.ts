/**
 * An in-memory to-do domain — the world the todo capabilities act on. The framework knows NOTHING about
 * this: capabilities import this module directly, exactly as a real app's capabilities import their own
 * models/db. There is no tenant, no app, no install and no db handle here — a todo is owned by nothing but
 * its `id`, which is the whole spine-free point. A real host would swap this for a database; the capability
 * code above it would not change.
 */
export interface Todo {
  id: string;
  title: string;
  done: boolean;
  /** ISO timestamp the todo was added, so a list is stably orderable oldest-first. */
  createdAt: string;
}

let todos = new Map<string, Todo>();
let seq = 0;

/**
 * A fixed clock for the seed and for deterministic tests. `store.add` stamps `createdAt` from `now()`, which
 * tests override so a created todo's timestamp is reproducible (cross-surface parity compares whole outputs).
 */
let now: () => string = () => new Date().toISOString();

function seed(): void {
  todos = new Map();
  seq = 0;
  // Two seeded todos so a fresh `todos.list` / `todos.watch` shows something to poke at immediately.
  add("buy milk");
  add("write the README");
}

/** The internal add used by both the seed and the capability — assigns the next id and stamps the clock. */
function add(title: string): Todo {
  const id = `todo_${++seq}`;
  const todo: Todo = { id, title, done: false, createdAt: now() };
  todos.set(id, todo);
  return todo;
}

export const store = {
  /** Add a todo and return it. The `todos.add` capability calls this once per (deduped) request. */
  add(title: string): Todo {
    return add(title);
  },
  /** Every todo, oldest-first by creation order — what `todos.list` and `todos.watch` walk over. */
  list(filter?: { done?: boolean }): Todo[] {
    const all = [...todos.values()].sort((a, b) =>
      a.id.localeCompare(b.id, undefined, { numeric: true }),
    );
    if (filter?.done === undefined) return all;
    return all.filter((t) => t.done === filter.done);
  },
  /** One todo by id, or `undefined` — `todos.complete` / `todos.remove` 404 on `undefined`. */
  get(id: string): Todo | undefined {
    return todos.get(id);
  },
  /** Mark a todo done and return the updated row, or `undefined` if it is absent. */
  complete(id: string): Todo | undefined {
    const todo = todos.get(id);
    if (!todo) return undefined;
    todo.done = true;
    return todo;
  },
  /** Remove a todo; returns whether a row was actually deleted (so the caller can 404 a miss). */
  remove(id: string): boolean {
    return todos.delete(id);
  },
  /** Test helper — reset to seed state, optionally pinning the clock so `createdAt` is reproducible. */
  reset(clock?: () => string): void {
    now = clock ?? (() => new Date().toISOString());
    seed();
  },
};

// Seed once at module load so importing the store (or running an entrypoint) starts with todos present.
seed();
