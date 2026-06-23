import { beforeEach, describe, expect, test } from "bun:test";
import { execute, executeStream, Registry, ScopeError } from "@facet/core";
import logsFollow from "../examples/logs/capabilities/logs.follow.cap";
import logsTail from "../examples/logs/capabilities/logs.tail.cap";
import { makeContext } from "../examples/logs/host";
import { store } from "../examples/logs/store";

/**
 * THE STREAMING PROOF — additive sibling of the headless proof.
 *
 * A streaming capability runs through the SAME chokepoint as a unary one, only it is an async generator:
 * `executeStream()` validates each chunk and the final, runs the read gates (resolve → validate → authz →
 * audit) before a single chunk escapes, and `execute()` still serves the terminal value by draining. Every
 * test below uses a BARE agent context — no tenant, no installs, no db, no ledger — so the streaming path is
 * proven to be the same spine-free engine, not a second one.
 */
function registry(): Registry {
  const r = new Registry();
  for (const def of [logsFollow, logsTail]) r.register(def);
  return r;
}

/** Drive a stream to completion, collecting its chunks and capturing the returned final. */
async function collect<C, F>(gen: AsyncGenerator<C, F, void>): Promise<{ chunks: C[]; final: F }> {
  const chunks: C[] = [];
  let step = await gen.next();
  while (!step.done) {
    chunks.push(step.value);
    step = await gen.next();
  }
  return { chunks, final: step.value };
}

beforeEach(() => store.reset());

describe("streaming runs the same chokepoint — chunks then a validated final", () => {
  test("executeStream(logs.follow) yields the chunks in order then the final", async () => {
    const { chunks, final } = await collect(
      executeStream(
        registry(),
        "logs.follow",
        { source: "build" },
        makeContext({ scopes: ["logs:read"] }),
      ),
    );
    // "build" is seeded with three lines; each is a chunk with its 1-based position, in order.
    expect(chunks).toEqual([
      { line: "build started", n: 1 },
      { line: "compiling", n: 2 },
      { line: "build ok", n: 3 },
    ]);
    expect(final).toEqual({ source: "build", lineCount: 3 });
  });

  test("a missing scope is refused BEFORE any chunk is produced", async () => {
    const gen = executeStream(
      registry(),
      "logs.follow",
      { source: "build" },
      makeContext({ scopes: [] }),
    );
    // The very first pull runs the gates; authz fails before the generator yields anything.
    await expect(gen.next()).rejects.toBeInstanceOf(ScopeError);
  });

  test("invalid input is refused BEFORE any chunk is produced", async () => {
    const gen = executeStream(
      registry(),
      "logs.follow",
      { source: "" },
      makeContext({ scopes: ["logs:read"] }),
    );
    await expect(gen.next()).rejects.toMatchObject({ code: "validation" });
  });

  test("execute() on a streaming capability drains to the final { source, lineCount }", async () => {
    const out = await execute(
      registry(),
      "logs.follow",
      { source: "deploy" },
      makeContext({ scopes: ["logs:read"] }),
    );
    // "deploy" is seeded with three lines — a non-streaming caller still gets the terminal value.
    expect(out).toEqual({ source: "deploy", lineCount: 3 });
  });

  test("a stream over an unknown source yields nothing and returns a zero count", async () => {
    const { chunks, final } = await collect(
      executeStream(
        registry(),
        "logs.follow",
        { source: "nope" },
        makeContext({ scopes: ["logs:read"] }),
      ),
    );
    expect(chunks).toEqual([]);
    expect(final).toEqual({ source: "nope", lineCount: 0 });
  });

  test("a kill-switched streaming capability is refused before any chunk", async () => {
    const r = new Registry();
    r.register({ ...logsFollow, enabled: false });
    const gen = executeStream(
      r,
      "logs.follow",
      { source: "build" },
      makeContext({ scopes: ["logs:read"] }),
    );
    await expect(gen.next()).rejects.toMatchObject({ code: "kill_switch" });
  });

  test("executeStream refuses a NON-streaming capability up front", async () => {
    const gen = executeStream(
      registry(),
      "logs.tail",
      { source: "build" },
      makeContext({ scopes: ["logs:read"] }),
    );
    await expect(gen.next()).rejects.toMatchObject({ code: "validation" });
  });
});
