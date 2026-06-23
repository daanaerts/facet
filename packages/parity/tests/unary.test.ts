import { beforeEach, describe, expect, test } from "bun:test";
import {
  assertParity,
  type CallOpts,
  type ParityHosts,
  type SurfaceResult,
  viaAgent,
  viaCli,
  viaExecute,
  viaHttp,
  viaMcp,
} from "@facet/parity";
import { store } from "../../../examples/todo/store";
import { todoHosts } from "./hosts";

/**
 * UNARY cross-surface parity — the money test, promoted into `@facet/parity` and extended to FIVE legs and the
 * full error matrix. One typed capability is driven through the raw `execute()` BASELINE and all four surfaces,
 * and every leg must AGREE: the surfaces are projections of the chokepoint, so a capability output, a
 * confirmation gate, and every refusal code must be byte-identical no matter the entry point. The baseline leg
 * (`execute`, no surface) is the ground truth — the previous harness lacked it, so agent-surface drift was
 * invisible; here the agent is just one more leg measured against `execute()`.
 *
 * Each leg runs against an identically-reset world (a fixed clock so a created todo is reproducible), so the
 * only thing that could differ is the surface — and nothing does, because each leg only establishes a Context
 * and calls the SAME `@facet/core` `execute()`.
 */

const FIXED = "2026-06-23T12:00:00.000Z";

/** Reset the todo store to a known, fixed-clock world (two seeds) so outputs are reproducible per leg. */
function freshWorld(): void {
  store.reset(() => FIXED);
}

beforeEach(freshWorld);

/** The five unary legs, keyed by label — `execute` is the baseline `assertParity` uses as the reference. */
const LEGS: Record<
  string,
  (
    hosts: ParityHosts,
    id: string,
    input: Record<string, unknown>,
    opts?: CallOpts,
  ) => Promise<SurfaceResult>
> = {
  execute: viaExecute,
  agent: viaAgent,
  cli: viaCli,
  http: viaHttp,
  mcp: viaMcp,
};

/**
 * Run one call across all five legs, each against a FRESHLY-reset world (so a leg's output never depends on
 * call order), and return the results keyed by leg label. Building each leg on its own reset world is what
 * lets the assertion compare WHOLE outputs (a created `todo_3`, the seeded list) rather than mere shapes.
 */
async function onAllLegs(
  hosts: ParityHosts,
  id: string,
  input: Record<string, unknown>,
  opts?: CallOpts,
): Promise<Record<string, SurfaceResult>> {
  const results: Record<string, SurfaceResult> = {};
  for (const [label, via] of Object.entries(LEGS)) {
    freshWorld();
    results[label] = await via(hosts, id, input, opts);
  }
  return results;
}

describe("unary parity — one capability, the baseline + four surfaces, one chokepoint", () => {
  test("READ output parity: todos.list returns the SAME output on execute · agent · cli · http · mcp", async () => {
    const results = await onAllLegs(todoHosts(), "todos.list", {});
    assertParity(results);
    // And it is the exact seeded world, on every leg — a read auto-runs everywhere with no confirmation.
    const expected = {
      todos: [
        { id: "todo_1", title: "buy milk", done: false, createdAt: FIXED },
        { id: "todo_2", title: "write the README", done: false, createdAt: FIXED },
      ],
    };
    for (const result of Object.values(results)) expect(result.output).toEqual(expected);
  });

  test("WRITE output parity: todos.add (confirmed) returns the SAME created todo on all five legs", async () => {
    const results = await onAllLegs(
      todoHosts(),
      "todos.add",
      { title: "ship it" },
      { confirm: true },
    );
    assertParity(results);
    // Fixed clock + deterministic id ⇒ the created todo is byte-identical on every leg (two seeds → todo_3).
    const expected = { id: "todo_3", title: "ship it", done: false, createdAt: FIXED };
    for (const result of Object.values(results)) expect(result.output).toEqual(expected);
  });

  describe("error-code matrix — every leg renders the SAME FacetError code", () => {
    test("confirmation_required: a write with NO confirmation is refused everywhere", async () => {
      const results = await onAllLegs(todoHosts(), "todos.add", { title: "ship it" });
      assertParity(results);
      for (const result of Object.values(results)) {
        expect(result.errorCode).toBe("confirmation_required");
        expect(result.output).toBeUndefined();
      }
    });

    test("validation: a write with BAD input (empty title) is refused validation everywhere", async () => {
      // Confirmed, so this is unambiguously the VALIDATION gate (step 2), not the confirmation gate (step 4):
      // execute() validates before it confirms, so a bad input is `validation` whether or not confirm is set.
      const results = await onAllLegs(todoHosts(), "todos.add", { title: "" }, { confirm: true });
      assertParity(results);
      for (const result of Object.values(results)) expect(result.errorCode).toBe("validation");
    });

    test("forbidden: a read the principal lacks the scope for is refused forbidden everywhere", async () => {
      // The SAME todos.list read, but the hosts grant NO scopes — so execute()'s one authz step refuses it on
      // every leg with `forbidden`, the refusal coming from the chokepoint, not from any surface.
      const results = await onAllLegs(todoHosts([]), "todos.list", {});
      assertParity(results);
      for (const result of Object.values(results)) expect(result.errorCode).toBe("forbidden");
    });

    test("not_found: a write against an unknown id is refused not_found everywhere", async () => {
      // todos.complete reaches its handler (authorized + confirmed), which throws NotFoundError for a missing
      // todo — so every leg, CLI included, renders `not_found` from the SAME thrown error. (An UNKNOWN
      // capability id is deliberately NOT used here: the CLI treats that as a usage error, exit 2, which is a
      // legitimate CLI-boundary divergence, not a capability-level not_found.)
      const results = await onAllLegs(
        todoHosts(),
        "todos.complete",
        { id: "nope" },
        { confirm: true },
      );
      assertParity(results);
      for (const result of Object.values(results)) expect(result.errorCode).toBe("not_found");
    });
  });
});
