import { beforeEach, describe, expect, test } from "bun:test";
import { EXIT, runCli, type WriterSink } from "@facet/cli";
import type { Actor } from "@facet/core";
import type { AuthParts } from "@facet/surface-kit";
import { devContextFor } from "../../../examples/logs/cli";
import { logsRegistry } from "../../../examples/logs/http";
import { store } from "../../../examples/logs/store";

/**
 * THE CLI PROOF.
 *
 * The `logs` registry projected onto the CLI, driven entirely IN-PROCESS — every run is `runCli(registry,
 * argv, { contextFor }, sink)` with capturing sinks, NO subprocess and NO real stdout. If the carved surface
 * had reached back for an MF spine concept (a tenant flag, a db, an install gate, `--remote`) these would
 * not pass with the bare dev `contextFor` the example supplies. They do: the same generic dispatcher serves
 * a read, a confirmation-gated write, an idempotent replay, an unknown id and a usage error, and `ls` lists
 * exactly the registry.
 */

/** A capturing sink + the buffers it fills, so a test asserts on stdout/stderr lines without spawning. */
function makeSink(): { sink: WriterSink; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { sink: { out: (l) => out.push(l), err: (l) => err.push(l) }, out, err };
}

/** Run the logs CLI in-process with a fresh dev `contextFor`; returns the exit code + captured output. */
async function run(argv: string[]): Promise<{ code: number; out: string[]; err: string[] }> {
  const { sink, out, err } = makeSink();
  const code = await runCli(logsRegistry(), argv, { contextFor: devContextFor() }, sink);
  return { code, out, err };
}

beforeEach(() => store.reset());

describe("the logs registry over the CLI — one generic dispatcher", () => {
  test("a read (logs.tail) prints exit 0 + the correct JSON to stdout", async () => {
    const { code, out } = await run(["logs.tail", "--json", '{"source":"build"}']);
    expect(code).toBe(EXIT.ok);
    expect(JSON.parse(out.join("\n"))).toEqual({
      source: "build",
      lines: ["build started", "compiling", "build ok"],
    });
  });

  test("`ls` lists exactly the registry capabilities, each with id/risk/surfaces", async () => {
    const { code, out } = await run(["ls"]);
    expect(code).toBe(EXIT.ok);
    const text = out.join("\n");
    for (const id of ["logs.tail", "jobs.list", "jobs.start", "jobs.cancel"]) {
      expect(text).toContain(id);
    }
    // risk + surfaces are rendered on the line for each capability.
    expect(text).toContain("read");
    expect(text).toContain("destructive");
    expect(text).toContain("[agent,http,mcp,cli]");
  });

  test("`ls --surface http` keeps only capabilities that project onto http", async () => {
    const { code, out } = await run(["ls", "--surface", "http"]);
    expect(code).toBe(EXIT.ok);
    // every logs capability declares http (the jobs trio, unary logs.tail, and the streaming logs.follow +
    // logs.boom), so all six still appear — but the filter ran.
    expect(out.length).toBe(6);
    for (const line of out) expect(line).toContain("[agent,http,mcp,cli]");
  });

  test("a write (jobs.start) WITHOUT --yes → exit 1 + confirmation_required on stderr", async () => {
    const { code, out, err } = await run(["jobs.start", "--json", '{"name":"nightly"}']);
    expect(code).toBe(EXIT.error);
    expect(out).toHaveLength(0); // nothing printed to stdout
    expect(err.join("\n")).toContain("✗ confirmation_required");
    expect(store.listJobs()).toHaveLength(0); // the handler never ran
  });

  test("a write (jobs.start) WITH --yes → exit 0 and the job runs", async () => {
    const { code, out } = await run(["jobs.start", "--json", '{"name":"nightly"}', "--yes"]);
    expect(code).toBe(EXIT.ok);
    const job = JSON.parse(out.join("\n"));
    expect(job).toMatchObject({ name: "nightly", status: "running" });
    expect(job.id).toMatch(/^job_/);
    expect(store.listJobs()).toHaveLength(1);
  });

  test("an unknown capability id → exit 2 (a usage error, before the chokepoint)", async () => {
    const { code, err } = await run(["logs.nope"]);
    expect(code).toBe(EXIT.usage);
    expect(err.join("\n")).toContain("unknown capability: logs.nope");
  });

  test("invalid --json → exit 2 (a usage error, before any Context is formed)", async () => {
    const { code, err } = await run(["logs.tail", "--json", "{not json}"]);
    expect(code).toBe(EXIT.usage);
    expect(err.join("\n")).toContain("invalid --json");
  });

  test("bad input → exit 1 + validation (the capability's own schema, not the surface)", async () => {
    const { code, err } = await run(["logs.tail", "--json", '{"source":""}']);
    expect(code).toBe(EXIT.error);
    expect(err.join("\n")).toContain("✗ validation");
  });

  test("a destructive write (jobs.cancel) is confirmation-gated, then runs, then 404s a missing target", async () => {
    const started = await run(["jobs.start", "--json", '{"name":"nightly"}', "--yes"]);
    const id = JSON.parse(started.out.join("\n")).id as string;

    // unconfirmed cancel → exit 1
    const unconfirmed = await run(["jobs.cancel", "--json", JSON.stringify({ id })]);
    expect(unconfirmed.code).toBe(EXIT.error);
    expect(unconfirmed.err.join("\n")).toContain("✗ confirmation_required");

    // confirmed cancel → exit 0 (fresh store: re-seed + re-create so the id exists in THIS run)
    store.reset();
    const reStarted = await run(["jobs.start", "--json", '{"name":"nightly"}', "--yes"]);
    const id2 = JSON.parse(reStarted.out.join("\n")).id as string;
    const cancelled = await run(["jobs.cancel", "--json", JSON.stringify({ id: id2 }), "--yes"]);
    expect(cancelled.code).toBe(EXIT.ok);
    expect(JSON.parse(cancelled.out.join("\n"))).toEqual({ id: id2, status: "cancelled" });

    // confirmed cancel of a missing target → exit 1 + not_found
    const missing = await run(["jobs.cancel", "--json", '{"id":"job_999"}', "--yes"]);
    expect(missing.code).toBe(EXIT.error);
    expect(missing.err.join("\n")).toContain("✗ not_found");
  });

  test("idempotency: a retried jobs.start with the same --key replays the first job", async () => {
    // One shared contextFor → one closed-over ledger across both runs (mirrors a real single-process CLI
    // session). A fresh sink per call, but the SAME registry + contextFor so the replay store persists.
    const { sink: s1, out: o1 } = makeSink();
    const ctx = devContextFor();
    const reg = logsRegistry();
    const argv = ["jobs.start", "--json", '{"name":"nightly"}', "--yes", "--key", "k1"];

    const c1 = await runCli(reg, argv, { contextFor: ctx }, s1);
    const { sink: s2, out: o2 } = makeSink();
    const c2 = await runCli(reg, argv, { contextFor: ctx }, s2);

    expect(c1).toBe(EXIT.ok);
    expect(c2).toBe(EXIT.ok);
    expect(JSON.parse(o2.join("\n"))).toEqual(JSON.parse(o1.join("\n"))); // same job replayed
    expect(store.listJobs()).toHaveLength(1); // the handler ran exactly once
  });

  test("a missing scope is refused centrally → exit 1 + forbidden", async () => {
    // Drive a contextFor that grants NOTHING to prove the surface forwards a ScopeError unchanged. Built
    // inline so the example `devContextFor` stays a happy-path grant while error mapping is still proven.
    const denyAll = (actor: Actor): AuthParts => ({ actor, scopes: [] });
    const { sink, err } = makeSink();
    const code = await runCli(logsRegistry(), ["jobs.list"], { contextFor: denyAll }, sink);
    expect(code).toBe(EXIT.error);
    expect(err.join("\n")).toContain("✗ forbidden");
  });

  test("help / no args print usage to stdout with exit 0", async () => {
    const noArgs = await run([]);
    expect(noArgs.code).toBe(EXIT.ok);
    expect(noArgs.out.join("\n")).toContain("facet — capability CLI");

    const help = await run(["help"]);
    expect(help.code).toBe(EXIT.ok);
    expect(help.out.join("\n")).toContain("Usage");
    // the global help advertises the per-capability `--help`
    expect(help.out.join("\n")).toContain("<capability.id> --help");
  });

  test("`<id> --help` renders a read's man page from its schema (summary, fields, defaults, examples)", async () => {
    const { code, out } = await run(["logs.tail", "--help"]);
    expect(code).toBe(EXIT.ok);
    const text = out.join("\n");
    // title + summary, and the meta line carries the threat model + scopes (not a global usage dump)
    expect(text).toContain("logs.tail — Return the most recent log lines for a source.");
    expect(text).toContain("read · surfaces: agent, http, mcp, cli · scopes: logs:read");
    // the long-form description body
    expect(text).toContain("Reads the trailing window of a log source");
    // input fields with their `.describe()` text and the default pulled from the schema
    expect(text).toContain("Input");
    expect(text).toContain("source");
    expect(text).toContain("The log source");
    expect(text).toContain("default: 50");
    // authored examples are rendered as runnable commands + notes
    expect(text).toContain(`facet logs.tail --json '{"source":"build"}'`);
    expect(text).toContain("A wider window for a deploy postmortem.");
  });

  test("`<id> --help` for a write surfaces the confirmation gate and puts --yes in the example", async () => {
    const { code, out } = await run(["jobs.start", "--help"]);
    expect(code).toBe(EXIT.ok);
    const text = out.join("\n");
    expect(text).toContain("write · surfaces:");
    expect(text).toContain("Requires --yes");
    // the runnable example for a write carries --yes so a copy-paste actually runs
    expect(text).toContain(`facet jobs.start --json '{"name":"nightly"}' --yes`);
    // an enum output field renders its allowed values, not just "string"
    expect(text).toContain(`"running"|"done"|"cancelled"`);
    // help authorizes nothing and runs nothing — no job was started
    expect(store.listJobs()).toHaveLength(0);
  });

  test("`<unknown> --help` is the same usage error (exit 2) a real call would hit", async () => {
    const { code, err } = await run(["logs.nope", "--help"]);
    expect(code).toBe(EXIT.usage);
    expect(err.join("\n")).toContain("unknown capability: logs.nope");
  });

  test("--actor sets the calling identity the host seam authorizes", async () => {
    // The dev contextFor grants the same scopes regardless of actor, but the actor must reach the seam.
    // Assert by capturing the actor the seam receives.
    let seenActor: { email?: string } | undefined;
    const captureCtx = (actor: Actor): AuthParts => {
      seenActor = actor;
      return { actor, scopes: ["logs:read"] };
    };
    const { sink } = makeSink();
    await runCli(
      logsRegistry(),
      ["logs.tail", "--json", '{"source":"build"}', "--actor", "ruben@sma.org"],
      { contextFor: captureCtx },
      sink,
    );
    expect(seenActor).toMatchObject({ kind: "user", email: "ruben@sma.org" });
  });
});
