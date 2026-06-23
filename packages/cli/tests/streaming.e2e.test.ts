import { beforeEach, describe, expect, test } from "bun:test";
import { EXIT, runCli, type WriterSink } from "@facet/cli";
import { buildContext, type Context, Registry } from "@facet/core";
import logsFollow from "../../../examples/logs/capabilities/logs.follow.cap";
import logsTail from "../../../examples/logs/capabilities/logs.tail.cap";
import { store } from "../../../examples/logs/store";

/**
 * THE CLI STREAMING PROOF.
 *
 * `logs.follow` — a streaming capability — projected onto the CLI, driven IN-PROCESS with capturing sinks
 * (no subprocess, no real stdout). The CLI's streaming idiom is one JSON line per chunk AS IT ARRIVES,
 * followed by the final value as the last line — so a `follow` scrolls live in a terminal. The dispatcher
 * drives the core's `executeStream()` (the same chokepoint, the same read gates, the same per-chunk
 * validation); the surface only chooses the rendering.
 */

/** A registry with the streaming `logs.follow` plus its unary sibling `logs.tail`. */
function registry(): Registry {
  const r = new Registry();
  for (const def of [logsFollow, logsTail]) r.register(def);
  return r;
}

/** A capturing sink + the buffers it fills, so a test asserts on stdout/stderr lines without spawning. */
function makeSink(): { sink: WriterSink; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { sink: { out: (l) => out.push(l), err: (l) => err.push(l) }, out, err };
}

/** A dev `contextFor` granting logs:read — all a streaming read needs; no ledger (a read never dedupes). */
function contextFor(scopes = ["logs:read"]): () => Context {
  return (): Context =>
    buildContext({ actor: { kind: "agent", agentId: "cli" }, scopes, surface: "cli" });
}

/** Run the streaming CLI in-process; returns the exit code + captured stdout/stderr lines. */
async function run(
  argv: string[],
  scopes?: string[],
): Promise<{ code: number; out: string[]; err: string[] }> {
  const { sink, out, err } = makeSink();
  const code = await runCli(registry(), argv, { contextFor: contextFor(scopes) }, sink);
  return { code, out, err };
}

beforeEach(() => store.reset());

describe("the CLI streams a capability — one JSON line per chunk, then the final line", () => {
  test("a streaming read prints N chunk lines as they arrive, then the final line, exit 0", async () => {
    const { code, out } = await run(["logs.follow", "--json", '{"source":"build"}']);
    expect(code).toBe(EXIT.ok);

    // "build" has three lines → three chunk lines + one final line = four lines total.
    expect(out).toHaveLength(4);
    const parsed = out.map((l) => JSON.parse(l));
    expect(parsed.slice(0, 3)).toEqual([
      { line: "build started", n: 1 },
      { line: "compiling", n: 2 },
      { line: "build ok", n: 3 },
    ]);
    // The LAST line is the validated final value, not a chunk.
    expect(parsed[3]).toEqual({ source: "build", lineCount: 3 });
  });

  test("a streaming read over an unknown source prints just the final line (zero chunks)", async () => {
    const { code, out } = await run(["logs.follow", "--json", '{"source":"nope"}']);
    expect(code).toBe(EXIT.ok);
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0] ?? "")).toEqual({ source: "nope", lineCount: 0 });
  });

  test("a missing scope is refused centrally → exit 1 + forbidden, nothing on stdout", async () => {
    const { code, out, err } = await run(["logs.follow", "--json", '{"source":"build"}'], []);
    expect(code).toBe(EXIT.error);
    expect(out).toHaveLength(0); // no chunk leaked before the gate refused
    expect(err.join("\n")).toContain("✗ forbidden");
  });

  test("bad input → exit 1 + validation, nothing streamed", async () => {
    const { code, out, err } = await run(["logs.follow", "--json", '{"source":""}']);
    expect(code).toBe(EXIT.error);
    expect(out).toHaveLength(0);
    expect(err.join("\n")).toContain("✗ validation");
  });

  test("a non-streaming capability is unchanged — one pretty-printed final, no per-line chunks", async () => {
    const { code, out } = await run(["logs.tail", "--json", '{"source":"build"}']);
    expect(code).toBe(EXIT.ok);
    // logs.tail prints a single pretty JSON blob (multi-line), parsed as one object — not chunk lines.
    expect(JSON.parse(out.join("\n"))).toEqual({
      source: "build",
      lines: ["build started", "compiling", "build ok"],
    });
  });
});
