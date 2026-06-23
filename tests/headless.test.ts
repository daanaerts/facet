import { beforeEach, describe, expect, test } from "bun:test";
import {
  ConfirmationRequiredError,
  defineCapability,
  execute,
  Registry,
  ScopeError,
} from "@facet/core";
import { z } from "zod";
import jobsCancel from "../examples/logs/capabilities/jobs.cancel.cap";
import jobsList from "../examples/logs/capabilities/jobs.list.cap";
import jobsStart from "../examples/logs/capabilities/jobs.start.cap";
import logsTail from "../examples/logs/capabilities/logs.tail.cap";
import { MemoryLedger, makeContext } from "../examples/logs/host";
import { store } from "../examples/logs/store";

/**
 * THE EXTRACTION PROOF.
 *
 * Every test below runs a capability through the chokepoint with a BARE context — no tenant, no installs,
 * no db, no spine. If the carved core were still secretly Moral-Fabric-shaped, these would not compile or
 * would demand a tenant. They don't: the engine stands alone over an unrelated domain.
 */
function registry(): Registry {
  const r = new Registry();
  for (const def of [logsTail, jobsList, jobsStart, jobsCancel]) r.register(def);
  return r;
}

beforeEach(() => store.reset());

describe("the carved core stands alone — no tenant, no installs, no db", () => {
  test("a read runs through execute() with a bare agent context", async () => {
    const out = await execute(
      registry(),
      "logs.tail",
      { source: "build" },
      makeContext({ scopes: ["logs:read"] }),
    );
    expect(out).toEqual({ source: "build", lines: ["build started", "compiling", "build ok"] });
  });

  test("input is validated by the capability's own schema, not the surface", async () => {
    const run = execute(
      registry(),
      "logs.tail",
      { source: "" },
      makeContext({ scopes: ["logs:read"] }),
    );
    await expect(run).rejects.toMatchObject({ code: "validation" });
  });

  test("a missing scope is refused centrally, before the handler", async () => {
    const run = execute(registry(), "jobs.list", {}, makeContext({ scopes: [] }));
    await expect(run).rejects.toBeInstanceOf(ScopeError);
  });

  test("a write is confirmation-gated by the chokepoint", async () => {
    const reg = registry();
    const unconfirmed = execute(
      reg,
      "jobs.start",
      { name: "nightly" },
      makeContext({ scopes: ["jobs:write"] }),
    );
    await expect(unconfirmed).rejects.toBeInstanceOf(ConfirmationRequiredError);

    const job = await execute(
      reg,
      "jobs.start",
      { name: "nightly" },
      makeContext({ scopes: ["jobs:write"], confirm: true }),
    );
    expect(job).toMatchObject({ name: "nightly", status: "running" });
  });

  test("idempotency replays the stored result without re-running the handler", async () => {
    const reg = registry();
    const ledger = new MemoryLedger();
    const ctx = () =>
      makeContext({ scopes: ["jobs:write"], confirm: true, idempotencyKey: "k1", ledger });

    const first = await execute(reg, "jobs.start", { name: "nightly" }, ctx());
    const second = await execute(reg, "jobs.start", { name: "nightly" }, ctx());

    expect(second).toEqual(first); // same id replayed
    expect(store.listJobs()).toHaveLength(1); // handler ran exactly once
  });

  test("a destructive op runs only when confirmed, and 404s a missing target", async () => {
    const reg = registry();
    const created = await execute(
      reg,
      "jobs.start",
      { name: "nightly" },
      makeContext({ scopes: ["jobs:write"], confirm: true }),
    );
    const id = (created as { id: string }).id;

    const cancelled = await execute(
      reg,
      "jobs.cancel",
      { id },
      makeContext({ scopes: ["jobs:write"], confirm: true }),
    );
    expect(cancelled).toEqual({ id, status: "cancelled" });

    const missing = execute(
      reg,
      "jobs.cancel",
      { id: "job_999" },
      makeContext({ scopes: ["jobs:write"], confirm: true }),
    );
    await expect(missing).rejects.toMatchObject({ code: "not_found" });
  });

  test("a kill-switched capability is refused before anything else", async () => {
    const reg = new Registry();
    reg.register({ ...jobsList, enabled: false });
    const run = execute(reg, "jobs.list", {}, makeContext({ scopes: ["jobs:read"] }));
    await expect(run).rejects.toMatchObject({ code: "kill_switch" });
  });
});

/**
 * THE ATOMIC-LEDGER PROOF — the open correctness note made into a test.
 *
 * The old ledger did `lookup → handler → record` non-atomically, so two same-key writes racing through
 * `execute()` could BOTH miss the lookup and BOTH run the handler. The reshaped port `claim`s the key
 * atomically FIRST, so exactly one caller wins and runs the handler; the loser never does. These tests fire
 * genuinely-concurrent same-key writes (the instrumented handler `await`s, so control yields between
 * `claim` and `commit` — the exact window the old shape leaked through) and assert the handler ran ONCE.
 */
describe("atomic idempotency ledger — concurrent same-key writes run the handler exactly once", () => {
  /** A write whose handler counts its own invocations and yields control, so a race is real, not theoretical. */
  function countingRegistry(): { reg: Registry; runs: () => number } {
    let count = 0;
    const cap = defineCapability({
      id: "side.effect",
      summary: "A write that records how many times its handler actually ran.",
      input: z.object({ tag: z.string() }),
      output: z.object({ tag: z.string(), runs: z.number() }),
      scopes: ["side:write"],
      risk: "write",
      idempotent: true,
      handler: async (input) => {
        // Yield BEFORE the side effect: under the old lookup→record shape both racers would be parked here
        // having each missed the lookup, then both resume and both increment. The atomic claim prevents it.
        await Promise.resolve();
        count += 1;
        return { tag: input.tag, runs: count };
      },
    });
    const reg = new Registry();
    reg.register(cap);
    return { reg, runs: () => count };
  }

  test("two concurrent same-key writes invoke the handler exactly once", async () => {
    const { reg, runs } = countingRegistry();
    const ledger = new MemoryLedger();
    const ctx = () =>
      makeContext({ scopes: ["side:write"], confirm: true, idempotencyKey: "dup", ledger });

    // Fire both writes before awaiting either — both reach the atomic `claim`; exactly one wins.
    const settled = await Promise.allSettled([
      execute(reg, "side.effect", { tag: "a" }, ctx()),
      execute(reg, "side.effect", { tag: "b" }, ctx()),
    ]);

    expect(runs()).toBe(1); // the whole point: the handler ran exactly once across both concurrent calls.

    // One call won and produced the result; the other lost the claim. Because the winner is still mid-flight
    // when the loser reads (nothing committed yet), the loser surfaces `conflict` rather than a stale value.
    const fulfilled = settled.filter((s) => s.status === "fulfilled");
    const rejected = settled.filter((s) => s.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: "conflict" });
  });

  test("after the winner commits, a later same-key retry replays the stored result (never re-runs)", async () => {
    const { reg, runs } = countingRegistry();
    const ledger = new MemoryLedger();
    const ctx = () =>
      makeContext({ scopes: ["side:write"], confirm: true, idempotencyKey: "dup", ledger });

    const first = await execute(reg, "side.effect", { tag: "a" }, ctx());
    const replay = await execute(reg, "side.effect", { tag: "b" }, ctx()); // same key, after commit

    expect(replay).toEqual(first); // the loser got the winner's committed result…
    expect(runs()).toBe(1); // …and the handler still ran exactly once.
  });
});
