import { beforeEach, describe, expect, test } from "bun:test";
import { SURFACES, type SurfaceKind } from "@facet/core";
import { store } from "../store";
import { type SurfaceResult, viaAgent, viaCli, viaHttp, viaMcp } from "./surfaces";

/**
 * THE MONEY TEST for the todo app — the four-surface parity harness, carved spine-free. It proves the whole
 * thesis on a real, playable domain: one typed, headless capability (`todos.add`) lights up on HTTP, CLI, MCP
 * and the in-app agent with ZERO per-surface code, and all four AGREE because each only establishes a Context
 * and calls the SAME `@facet/core` `execute()` chokepoint. The single deliberate difference is the entry
 * point; the output is otherwise byte-identical, and the refusal code is identical.
 *
 * All four legs run headlessly and IN-PROCESS (no port, no subprocess, no db):
 *   - agent : dispatchToolCall(registry, { name, arguments }, { contextFor })          (direct, in-process)
 *   - cli   : runCli(registry, ["todos.add","--json",JSON, …], { contextFor }, sink)   (in-process, captured)
 *   - http  : createHttpApp(...).handle(new Request("http://local/cap/todos.add", …))
 *   - mcp   : createMcpServer(...) + InMemoryTransport + Client.callTool({ name })
 *
 * Each surface driver builds its OWN registry over the SAME in-memory `store` (module state). So before each
 * surface call we reset the store with a FIXED clock — then a freshly-added todo is byte-identical
 * (`todo_1` / `createdAt` pinned) no matter which surface added it, which is exactly what lets the parity
 * assertion compare whole outputs rather than just shapes. (apps-demo shared one Db across the in-process
 * surfaces; spine-free, the shared state is this in-memory store, reset to a known world per leg.)
 */

const FIXED = "2026-06-23T12:00:00.000Z";

/** Reset the store to a known, fixed-clock world so a freshly-added todo is reproducible. */
function freshWorld(): void {
  store.reset(() => FIXED);
}

beforeEach(freshWorld);

/** Run one surface driver against a freshly-reset world, so its output does not depend on call order. */
async function onFreshWorld(fn: () => Promise<SurfaceResult>): Promise<SurfaceResult> {
  freshWorld();
  return fn();
}

describe("four-surface parity — one capability, four entry points, one chokepoint", () => {
  const INPUT = { title: "ship it" };

  test("WRITE parity: todos.add returns the SAME output via agent · cli · http · mcp", async () => {
    // Each leg runs against an identically-reset world (fixed clock, two seeds → the new todo is `todo_3`),
    // so the only thing that could differ is the surface — and nothing does, because each just calls execute().
    const agent = await onFreshWorld(() => viaAgent("todos.add", INPUT, { confirm: true }));
    const cli = await onFreshWorld(() => viaCli("todos.add", INPUT, { confirm: true }));
    const http = await onFreshWorld(() => viaHttp("todos.add", INPUT, { confirm: true }));
    const mcp = await onFreshWorld(() => viaMcp("todos.add", INPUT, { confirm: true }));
    const calls: Record<SurfaceKind, SurfaceResult> = { agent, cli, http, mcp };

    // The created todo is fully deterministic (fixed clock, deterministic id), so all four outputs are
    // byte-identical — there is no surface label on a capability output, so there is nothing to normalize.
    const expected = { id: "todo_3", title: "ship it", done: false, createdAt: FIXED };
    for (const surface of SURFACES) {
      expect(calls[surface].output).toEqual(expected);
    }
  });

  test("WRITE confirmation parity: all four REFUSE todos.add with the SAME confirmation_required code", async () => {
    // No `confirm` on any leg — every surface must refuse with the SAME core code, because the confirmation
    // gate lives in `execute()` and each surface only TRANSLATES the one `ConfirmationRequiredError` it threw.
    const agent = await onFreshWorld(() => viaAgent("todos.add", INPUT));
    const cli = await onFreshWorld(() => viaCli("todos.add", INPUT));
    const http = await onFreshWorld(() => viaHttp("todos.add", INPUT));
    const mcp = await onFreshWorld(() => viaMcp("todos.add", INPUT));
    const codes: Record<SurfaceKind, string | undefined> = {
      agent: agent.errorCode,
      cli: cli.errorCode,
      http: http.errorCode,
      mcp: mcp.errorCode,
    };

    for (const surface of SURFACES) {
      expect(codes[surface]).toBe("confirmation_required");
    }
    // And none of them produced an output — a refusal is a refusal on every surface.
    for (const surface of SURFACES) {
      expect(codes[surface]).not.toBeUndefined();
    }
  });

  test("READ parity: todos.list returns the SAME output via agent · cli · http · mcp", async () => {
    // A read auto-runs everywhere with no confirmation; the seeded world is identical per leg, so all four
    // return the same two todos in the same order.
    const agent = await onFreshWorld(() => viaAgent("todos.list", {}));
    const cli = await onFreshWorld(() => viaCli("todos.list", {}));
    const http = await onFreshWorld(() => viaHttp("todos.list", {}));
    const mcp = await onFreshWorld(() => viaMcp("todos.list", {}));
    const calls: Record<SurfaceKind, SurfaceResult> = { agent, cli, http, mcp };

    const expected = {
      todos: [
        { id: "todo_1", title: "buy milk", done: false, createdAt: FIXED },
        { id: "todo_2", title: "write the README", done: false, createdAt: FIXED },
      ],
    };
    for (const surface of SURFACES) {
      expect(calls[surface].output).toEqual(expected);
    }
  });
});
