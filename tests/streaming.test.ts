import { beforeEach, describe, expect, test } from "bun:test";
import { execute, executeStream, FacetError, Registry, ScopeError } from "@facet/core";
import logsBoom from "../examples/logs/capabilities/logs.boom.cap";
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
  for (const def of [logsFollow, logsTail, logsBoom]) r.register(def);
  return r;
}

/**
 * Drive a stream that is EXPECTED to fail mid-iteration: collect the chunks it yields, and capture the error
 * it eventually throws (failing the test if it does not throw). This is the canonical mid-stream-error shape
 * — K chunks, then a throw — that every surface renders, asserted directly against the core here.
 */
async function collectUntilThrow<C>(
  gen: AsyncGenerator<C, unknown, void>,
): Promise<{ chunks: C[]; error: unknown }> {
  const chunks: C[] = [];
  try {
    let step = await gen.next();
    while (!step.done) {
      chunks.push(step.value);
      step = await gen.next();
    }
  } catch (error) {
    return { chunks, error };
  }
  throw new Error("expected the stream to throw mid-iteration, but it completed");
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

/**
 * THE MID-STREAM-ERROR CONTRACT — the canonical reference behavior (see `docs/STREAMING-CONTRACT.md`).
 *
 * Once chunk 1 is out, the read gates have all passed, so a later failure is a TRUE mid-stream error. The core
 * guarantees: yield the K good chunks, THEN throw a `FacetError` — never a silent truncation, never a clean
 * early return. The three failure modes of the `logs.boom` fixture cover the two triggers (a handler throw and
 * a bad chunk) plus the normalization of a non-`FacetError` handler throw to `internal`. This is the shape the
 * agent surface exposes verbatim and the other three surfaces each render natively.
 */
describe("mid-stream failure: K chunks THEN a thrown FacetError (the canonical contract)", () => {
  const TWO_GOOD = [
    { line: "boom started", n: 1 },
    { line: "still fine", n: 2 },
  ];

  test("a handler that THROWS a FacetError mid-iteration: two chunks, then that exact typed error", async () => {
    const { chunks, error } = await collectUntilThrow(
      executeStream(
        registry(),
        "logs.boom",
        { mode: "throw" },
        makeContext({ scopes: ["logs:read"] }),
      ),
    );
    // The two valid chunks were delivered in order BEFORE the failure …
    expect(chunks).toEqual(TWO_GOOD);
    // … and the handler's own typed FacetError surfaced UNCHANGED — its code is preserved, not flattened.
    expect(error).toBeInstanceOf(FacetError);
    expect(error).toMatchObject({ code: "connector_unavailable" });
  });

  test("a handler that throws a PLAIN Error mid-iteration is normalized to a FacetError(internal)", async () => {
    const { chunks, error } = await collectUntilThrow(
      executeStream(
        registry(),
        "logs.boom",
        { mode: "raw-throw" },
        makeContext({ scopes: ["logs:read"] }),
      ),
    );
    expect(chunks).toEqual(TWO_GOOD);
    // No untyped error escapes executeStream — a non-FacetError becomes `internal`, the surfaces' shared code.
    expect(error).toBeInstanceOf(FacetError);
    expect(error).toMatchObject({ code: "internal" });
  });

  test("a chunk that fails its schema: two chunks, then a FacetError(internal) from per-chunk validation", async () => {
    const { chunks, error } = await collectUntilThrow(
      executeStream(
        registry(),
        "logs.boom",
        { mode: "bad-chunk" },
        makeContext({ scopes: ["logs:read"] }),
      ),
    );
    // The two valid chunks still escaped first; only the malformed third is rejected …
    expect(chunks).toEqual(TWO_GOOD);
    // … by the core's own per-chunk validation, as `internal` (the engine produced an invalid chunk).
    expect(error).toBeInstanceOf(FacetError);
    expect(error).toMatchObject({ code: "internal" });
  });

  test("draining a mid-stream-failing stream via execute() surfaces the same thrown FacetError", async () => {
    // The unary bridge inherits the contract: a non-streaming caller sees the mid-stream throw as any other
    // failed execute() would — no partial value, no swallowed truncation.
    await expect(
      execute(registry(), "logs.boom", { mode: "throw" }, makeContext({ scopes: ["logs:read"] })),
    ).rejects.toMatchObject({ code: "connector_unavailable" });
  });
});
