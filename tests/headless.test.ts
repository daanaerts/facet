import { beforeEach, describe, expect, test } from "bun:test";
import { ConfirmationRequiredError, execute, Registry, ScopeError } from "@facet/core";
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
