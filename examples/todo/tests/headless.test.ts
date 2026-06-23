import { beforeEach, describe, expect, test } from "bun:test";
import {
  ConfirmationRequiredError,
  execute,
  executeStream,
  Registry,
  ScopeError,
} from "@facet/core";
import { MemoryLedger } from "../host";
import { todoRegistry } from "../registry";
import { store } from "../store";

/**
 * THE HEADLESS PROOF for the todo domain — mirror of `tests/headless.test.ts`. Every test runs a todo
 * capability through the chokepoint with a BARE context — no tenant, no installs, no db, no spine — built by
 * hand right here. If the carved core were still secretly Moral-Fabric-shaped, these would not compile or
 * would demand a tenant. They don't: the engine stands alone over a second, unrelated domain (todos).
 */

/** A bare Context built inline (the same shape `buildContext` produces) — proof the engine needs no host. */
function ctx(opts: {
  scopes: string[];
  confirm?: boolean;
  idempotencyKey?: string;
  ledger?: MemoryLedger;
}) {
  const scopes = opts.scopes;
  return {
    actor: { kind: "agent" as const, agentId: "test" },
    surface: "agent" as const,
    scopes,
    confirm: opts.confirm ?? false,
    idempotencyKey: opts.idempotencyKey,
    ledger: opts.ledger,
    requireScope(scope: string): void {
      if (!scopes.includes(scope) && !scopes.includes("*")) throw new ScopeError(scope);
    },
    audit(): void {},
  };
}

/** A fixed clock so a created todo's `createdAt` is reproducible across a test run. */
const FIXED = "2026-06-23T00:00:00.000Z";
beforeEach(() => store.reset(() => FIXED));

describe("the carved core stands alone over the todo domain — no tenant, no installs, no db", () => {
  test("a read runs through execute() with a bare agent context", async () => {
    const out = await execute(todoRegistry(), "todos.list", {}, ctx({ scopes: ["todos:read"] }));
    // Two todos are seeded, oldest-first.
    expect(out).toEqual({
      todos: [
        { id: "todo_1", title: "buy milk", done: false, createdAt: FIXED },
        { id: "todo_2", title: "write the README", done: false, createdAt: FIXED },
      ],
    });
  });

  test("the done filter is applied by the capability, not the surface", async () => {
    await execute(
      todoRegistry(),
      "todos.complete",
      { id: "todo_1" },
      ctx({ scopes: ["todos:write"], confirm: true }),
    );
    const open = await execute(
      todoRegistry(),
      "todos.list",
      { done: false },
      ctx({ scopes: ["todos:read"] }),
    );
    expect(open).toEqual({
      todos: [{ id: "todo_2", title: "write the README", done: false, createdAt: FIXED }],
    });
  });

  test("input is validated by the capability's own schema, not the surface", async () => {
    const run = execute(
      todoRegistry(),
      "todos.add",
      { title: "" },
      ctx({ scopes: ["todos:write"], confirm: true }),
    );
    await expect(run).rejects.toMatchObject({ code: "validation" });
  });

  test("a missing scope is refused centrally, before the handler", async () => {
    const run = execute(todoRegistry(), "todos.list", {}, ctx({ scopes: [] }));
    await expect(run).rejects.toBeInstanceOf(ScopeError);
  });

  test("a write is confirmation-gated by the chokepoint", async () => {
    const reg = todoRegistry();
    const unconfirmed = execute(
      reg,
      "todos.add",
      { title: "ship it" },
      ctx({ scopes: ["todos:write"] }),
    );
    await expect(unconfirmed).rejects.toBeInstanceOf(ConfirmationRequiredError);

    const todo = await execute(
      reg,
      "todos.add",
      { title: "ship it" },
      ctx({ scopes: ["todos:write"], confirm: true }),
    );
    expect(todo).toMatchObject({ title: "ship it", done: false });
  });

  test("idempotency replays the stored result without re-running the handler", async () => {
    const reg = todoRegistry();
    const ledger = new MemoryLedger();
    const make = () =>
      ctx({ scopes: ["todos:write"], confirm: true, idempotencyKey: "k1", ledger });

    const before = store.list().length;
    const first = await execute(reg, "todos.add", { title: "once" }, make());
    const second = await execute(reg, "todos.add", { title: "once" }, make());

    expect(second).toEqual(first); // same todo replayed
    expect(store.list().length).toBe(before + 1); // handler inserted exactly one
  });

  test("a destructive op runs only when confirmed, and 404s a missing target", async () => {
    const reg = todoRegistry();
    const removed = await execute(
      reg,
      "todos.remove",
      { id: "todo_1" },
      ctx({ scopes: ["todos:write"], confirm: true }),
    );
    expect(removed).toEqual({ id: "todo_1", removed: true });

    const missing = execute(
      reg,
      "todos.remove",
      { id: "todo_999" },
      ctx({ scopes: ["todos:write"], confirm: true }),
    );
    await expect(missing).rejects.toMatchObject({ code: "not_found" });
  });

  test("completing a missing todo 404s with the shared not_found taxonomy", async () => {
    const missing = execute(
      todoRegistry(),
      "todos.complete",
      { id: "todo_999" },
      ctx({ scopes: ["todos:write"], confirm: true }),
    );
    await expect(missing).rejects.toMatchObject({ code: "not_found" });
  });

  test("a kill-switched capability is refused before anything else", async () => {
    const reg = new Registry();
    const list = todoRegistry().get("todos.list");
    if (!list) throw new Error("todos.list missing from registry");
    reg.register({ ...list, enabled: false });
    const run = execute(reg, "todos.list", {}, ctx({ scopes: ["todos:read"] }));
    await expect(run).rejects.toMatchObject({ code: "kill_switch" });
  });

  test("todos.watch streams one chunk per todo through executeStream, then a final count", async () => {
    const chunks: unknown[] = [];
    const gen = executeStream(todoRegistry(), "todos.watch", {}, ctx({ scopes: ["todos:read"] }));
    let step = await gen.next();
    while (!step.done) {
      chunks.push(step.value);
      step = await gen.next();
    }
    expect(chunks).toEqual([
      { todo: { id: "todo_1", title: "buy milk", done: false, createdAt: FIXED }, n: 1 },
      { todo: { id: "todo_2", title: "write the README", done: false, createdAt: FIXED }, n: 2 },
    ]);
    expect(step.value).toEqual({ count: 2 });
  });

  test("execute() on todos.watch drains the stream to the final { count }", async () => {
    const out = await execute(todoRegistry(), "todos.watch", {}, ctx({ scopes: ["todos:read"] }));
    expect(out).toEqual({ count: 2 });
  });
});
