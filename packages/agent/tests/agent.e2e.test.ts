import { beforeEach, describe, expect, test } from "bun:test";
import type { ContextParts } from "@facet/agent";
import { agentToolset, dispatchToolCall, simulateAgentRun } from "@facet/agent";
import { Registry } from "@facet/core";
import jobsCancel from "../../../examples/logs/capabilities/jobs.cancel.cap";
import jobsList from "../../../examples/logs/capabilities/jobs.list.cap";
import jobsStart from "../../../examples/logs/capabilities/jobs.start.cap";
import logsTail from "../../../examples/logs/capabilities/logs.tail.cap";
import { MemoryLedger } from "../../../examples/logs/host";
import { store } from "../../../examples/logs/store";

/**
 * THE AGENT PROOF.
 *
 * The `logs` registry projected onto the AGENT surface, driven with NO LLM — every "tool call" is the exact
 * `{ name, arguments }` a model would emit, handed straight to `dispatchToolCall`. The whole thesis is here:
 * the propose→confirm handshake FALLS OUT of the schema + `execute()` chokepoint, with no surface code to
 * orchestrate it. A read auto-runs; a write called without `confirm` comes back `confirmation_required`; the
 * same write with `confirm: true` runs. That is precisely what an in-app copilot does — dispatch, read the
 * refusal, show the human the proposed action, re-dispatch confirmed — and it needs nothing but this surface.
 */

/** The four logs/jobs capabilities in one registry — the agent's entire reach. */
function registry(): Registry {
  const r = new Registry();
  for (const def of [logsTail, jobsList, jobsStart, jobsCancel]) r.register(def);
  return r;
}

/**
 * The host's per-call Context seam. Every call acts as the same demo agent, granted the logs/jobs scopes,
 * with one shared in-memory ledger so a retried write actually dedupes. A real host would vary this by
 * verified identity; the surface does not change. (No tenant/install/db — this is the spine-free seam.)
 */
function contextFor(ledger = new MemoryLedger()): (id: string) => ContextParts {
  return (_id: string): ContextParts => ({
    actor: { kind: "agent", agentId: "copilot" },
    scopes: ["logs:read", "jobs:read", "jobs:write"],
    ledger,
  });
}

beforeEach(() => store.reset());

describe("the logs registry over the agent surface — propose→confirm with no LLM", () => {
  test("agentToolset projects one tool per agent capability, dotted ids kept", () => {
    const tools = agentToolset(registry());
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["jobs.cancel", "jobs.list", "jobs.start", "logs.tail"]);

    // A read carries NO confirm field; a write/destructive carries a REQUIRED confirm field merged in.
    const tail = tools.find((t) => t.name === "logs.tail");
    expect(tail?.risk).toBe("read");
    expect((tail?.inputSchema.properties as Record<string, unknown>).confirm).toBeUndefined();
    expect(tail?.inputSchema.required ?? []).not.toContain("confirm");

    const start = tools.find((t) => t.name === "jobs.start");
    expect(start?.risk).toBe("write");
    expect((start?.inputSchema.properties as Record<string, unknown>).confirm).toMatchObject({
      type: "boolean",
    });
    expect(start?.inputSchema.required).toContain("confirm");
    // idempotencyKey is merged (optional) on the write, absent on the read.
    expect((start?.inputSchema.properties as Record<string, unknown>).idempotencyKey).toMatchObject(
      { type: "string" },
    );
    expect(
      (tail?.inputSchema.properties as Record<string, unknown>).idempotencyKey,
    ).toBeUndefined();

    const cancel = tools.find((t) => t.name === "jobs.cancel");
    expect(cancel?.risk).toBe("destructive");
    expect(cancel?.inputSchema.required).toContain("confirm");
  });

  test("a read (logs.tail) dispatches straight to output — no confirmation", async () => {
    const res = await dispatchToolCall(
      registry(),
      { name: "logs.tail", arguments: { source: "build" } },
      { contextFor: contextFor() },
    );
    expect(res.errorCode).toBeUndefined();
    expect(res.output).toEqual({
      source: "build",
      lines: ["build started", "compiling", "build ok"],
    });
  });

  test("THE HANDSHAKE: a write without confirm → confirmation_required, re-dispatched with confirm → output", async () => {
    const reg = registry();
    const opts = { contextFor: contextFor() };

    // 1. propose — the model calls jobs.start with NO confirm. The schema-modelled gate refuses.
    const proposed = await dispatchToolCall(
      reg,
      { name: "jobs.start", arguments: { name: "nightly" } },
      opts,
    );
    expect(proposed.output).toBeUndefined();
    expect(proposed.errorCode).toBe("confirmation_required");
    expect(store.listJobs()).toHaveLength(0); // the handler never ran on a proposal

    // 2. confirm — the driver showed the human, who said yes; re-dispatch the SAME call with confirm: true.
    const confirmed = await dispatchToolCall(
      reg,
      { name: "jobs.start", arguments: { name: "nightly", confirm: true } },
      opts,
    );
    expect(confirmed.errorCode).toBeUndefined();
    expect(confirmed.output).toMatchObject({ name: "nightly", status: "running" });
    expect((confirmed.output as { id: string }).id).toMatch(/^job_/);
    expect(store.listJobs()).toHaveLength(1); // and now it ran, exactly once
  });

  test("a destructive write (jobs.cancel) is gated the same way, then runs and 404s a missing target", async () => {
    const reg = registry();
    const opts = { contextFor: contextFor() };

    const started = await dispatchToolCall(
      reg,
      { name: "jobs.start", arguments: { name: "nightly", confirm: true } },
      opts,
    );
    const id = (started.output as { id: string }).id;

    // unconfirmed cancel → confirmation_required
    const proposed = await dispatchToolCall(reg, { name: "jobs.cancel", arguments: { id } }, opts);
    expect(proposed.errorCode).toBe("confirmation_required");

    // confirmed cancel → output
    const cancelled = await dispatchToolCall(
      reg,
      { name: "jobs.cancel", arguments: { id, confirm: true } },
      opts,
    );
    expect(cancelled.output).toEqual({ id, status: "cancelled" });

    // confirmed cancel of a missing target → not_found, surfaced as an errorCode (never thrown)
    const missing = await dispatchToolCall(
      reg,
      { name: "jobs.cancel", arguments: { id: "job_999", confirm: true } },
      opts,
    );
    expect(missing.errorCode).toBe("not_found");
  });

  test("bad input is refused by the capability's own schema → validation (the surface validates nothing)", async () => {
    const res = await dispatchToolCall(
      registry(),
      { name: "logs.tail", arguments: { source: "" } },
      { contextFor: contextFor() },
    );
    expect(res.errorCode).toBe("validation");
  });

  test("a missing scope is refused centrally → forbidden", async () => {
    const res = await dispatchToolCall(
      registry(),
      { name: "jobs.list", arguments: {} },
      { contextFor: () => ({ actor: { kind: "agent", agentId: "copilot" }, scopes: [] }) },
    );
    expect(res.errorCode).toBe("forbidden");
  });

  test("an unknown tool name → not_found", async () => {
    const res = await dispatchToolCall(
      registry(),
      { name: "logs.nope", arguments: {} },
      { contextFor: contextFor() },
    );
    expect(res.errorCode).toBe("not_found");
  });

  test("idempotency: a retried jobs.start with the same key replays the first job", async () => {
    const reg = registry();
    const opts = { contextFor: contextFor() }; // one shared ledger across both calls
    const call = {
      name: "jobs.start",
      arguments: { name: "nightly", confirm: true, idempotencyKey: "k1" },
    };

    const first = await dispatchToolCall(reg, call, opts);
    const second = await dispatchToolCall(reg, call, opts);

    expect(second.output).toEqual(first.output); // same job replayed
    expect(store.listJobs()).toHaveLength(1); // the handler ran exactly once
  });

  test("simulateAgentRun models the full propose→confirm loop as a scripted run", async () => {
    const steps = await simulateAgentRun(
      registry(),
      [
        { name: "logs.tail", arguments: { source: "build" } },
        { name: "jobs.start", arguments: { name: "nightly" } }, // proposal → refused
        { name: "jobs.start", arguments: { name: "nightly", confirm: true } }, // confirmed → runs
      ],
      { contextFor: contextFor() },
    );

    expect(steps).toHaveLength(3);
    expect(steps[0]?.result.output).toMatchObject({ source: "build" });
    expect(steps[1]?.result.errorCode).toBe("confirmation_required");
    expect(steps[2]?.result.output).toMatchObject({ name: "nightly", status: "running" });
    expect(store.listJobs()).toHaveLength(1); // only the confirmed call ran the handler
  });
});
