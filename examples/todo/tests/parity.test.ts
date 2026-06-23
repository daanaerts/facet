import { beforeEach, describe, expect, test } from "bun:test";
import { buildContext, type Context } from "@facet/core";
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
import {
  DEV_ACTOR,
  DEV_SCOPES,
  devAgentContextFor,
  devAuthenticate,
  devCliContextFor,
  devMcpContextFor,
} from "../host";
import { todoRegistry } from "../registry";
import { store } from "../store";

/**
 * THE MONEY TEST for the todo app — the cross-surface parity harness, now driven by the shared `@facet/parity`
 * package instead of a hand-rolled copy. It proves the whole thesis on a real, playable domain: one typed,
 * headless capability (`todos.add` / `todos.list`) lights up on the raw `execute()` BASELINE and on HTTP, CLI,
 * MCP and the in-app agent with ZERO per-surface code, and every leg AGREES because each only establishes a
 * Context and calls the SAME `@facet/core` `execute()` chokepoint. The single deliberate difference is the
 * entry point; the output is otherwise byte-identical, and the refusal code is identical.
 *
 * What changed from the earlier version: the four surface DRIVERS no longer live here (they moved into
 * `@facet/parity`, generic over a `ParityHosts` bundle), and a FIFTH leg — the raw `execute()` baseline — is
 * now in the comparison as the ground truth. The todo host's existing seams (`devAuthenticate`,
 * `devCliContextFor`, …) are bundled into a `ParityHosts` below, so this file wires the harness to the domain
 * and asserts the outcomes; it carries no surface logic of its own.
 *
 * All legs run headlessly and IN-PROCESS (no port, no subprocess, no db), each against an identically-reset
 * in-memory store (fixed clock), so a freshly-added todo is `todo_3` with a pinned `createdAt` no matter which
 * leg added it — which is exactly what lets the parity assertion compare whole outputs rather than just shapes.
 */

const FIXED = "2026-06-23T12:00:00.000Z";

/** Reset the store to a known, fixed-clock world so a freshly-added todo is reproducible. */
function freshWorld(): void {
  store.reset(() => FIXED);
}

beforeEach(freshWorld);

/**
 * Bundle the todo host's per-surface seams into a `ParityHosts` for `@facet/parity`. The four surface seams
 * are the app's real ones (`devAuthenticate` etc.); the baseline `executeContextFor` grants the SAME
 * `DEV_SCOPES` as those seams so the raw `execute()` leg authenticates as the same dev principal — parity is
 * only meaningful when every leg has identical authority. (Each seam closes over its own in-memory ledger;
 * these cases assert output + refusal codes, which the ledger does not affect.)
 */
const hosts: ParityHosts = {
  registry: todoRegistry,
  executeContextFor: ({ confirm, idempotencyKey }: CallOpts): Context =>
    buildContext({
      actor: DEV_ACTOR,
      scopes: DEV_SCOPES,
      surface: "agent",
      confirm,
      idempotencyKey,
    }),
  authenticate: devAuthenticate(),
  cliContextFor: devCliContextFor(),
  mcpContextFor: devMcpContextFor(),
  agentContextFor: devAgentContextFor(),
};

/** The five legs, keyed by label — `execute` is the baseline `assertParity` references as ground truth. */
const LEGS: Record<
  string,
  (
    h: ParityHosts,
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

/** Run one call across all five legs, each on a freshly-reset world (so output never depends on call order). */
async function onAllLegs(
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

describe("four-surface parity — one capability, the baseline + four entry points, one chokepoint", () => {
  const INPUT = { title: "ship it" };

  test("WRITE parity: todos.add returns the SAME output via execute · agent · cli · http · mcp", async () => {
    const results = await onAllLegs("todos.add", INPUT, { confirm: true });
    assertParity(results);
    // The created todo is fully deterministic (fixed clock, deterministic id → todo_3), so every leg is
    // byte-identical — there is no surface label on a capability output, so there is nothing to normalize.
    const expected = { id: "todo_3", title: "ship it", done: false, createdAt: FIXED };
    for (const result of Object.values(results)) expect(result.output).toEqual(expected);
  });

  test("WRITE confirmation parity: every leg REFUSES todos.add with the SAME confirmation_required code", async () => {
    // No `confirm` on any leg — each must refuse with the SAME core code, because the confirmation gate lives
    // in `execute()` and each surface only TRANSLATES the one `ConfirmationRequiredError` it threw.
    const results = await onAllLegs("todos.add", INPUT);
    assertParity(results);
    for (const result of Object.values(results)) {
      expect(result.errorCode).toBe("confirmation_required");
      expect(result.output).toBeUndefined();
    }
  });

  test("READ parity: todos.list returns the SAME output via execute · agent · cli · http · mcp", async () => {
    const results = await onAllLegs("todos.list", {});
    assertParity(results);
    const expected = {
      todos: [
        { id: "todo_1", title: "buy milk", done: false, createdAt: FIXED },
        { id: "todo_2", title: "write the README", done: false, createdAt: FIXED },
      ],
    };
    for (const result of Object.values(results)) expect(result.output).toEqual(expected);
  });
});
