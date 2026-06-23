import { beforeEach, describe, expect, test } from "bun:test";
import { streamToolCall } from "@facet/agent";
import { FacetError, Registry } from "@facet/core";
import type { AuthParts } from "@facet/surface-kit";
import logsBoom from "../../../examples/logs/capabilities/logs.boom.cap";
import logsFollow from "../../../examples/logs/capabilities/logs.follow.cap";
import logsTail from "../../../examples/logs/capabilities/logs.tail.cap";
import { store } from "../../../examples/logs/store";

/**
 * THE AGENT STREAMING PROOF.
 *
 * `logs.follow` — a streaming capability — projected onto the agent surface via `streamToolCall`, driven with
 * NO LLM. An in-app copilot consumes the returned `AsyncGenerator<Chunk, Final>` directly: it renders each
 * validated chunk as it is produced and shows the final when the generator returns. The whole surface is the
 * core's `executeStream()` re-exposed as that generator — the same chokepoint, the same read gates, the same
 * per-chunk/final validation — with nothing re-implemented here.
 */

/** A registry with the streaming `logs.follow`, its unary sibling `logs.tail`, and the mid-stream fixture. */
function registry(): Registry {
  const r = new Registry();
  for (const def of [logsFollow, logsTail, logsBoom]) r.register(def);
  return r;
}

/** The host's per-call Context seam — the demo agent, granted logs:read (all a stream is a read needs). */
function contextFor(scopes = ["logs:read"]): (id: string) => AuthParts {
  return (_id: string): AuthParts => ({ actor: { kind: "agent", agentId: "copilot" }, scopes });
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

describe("the agent surface streams a capability — chunks then the final, no LLM", () => {
  test("streamToolCall yields each chunk as produced, then returns the validated final", async () => {
    const { chunks, final } = await collect(
      streamToolCall(
        registry(),
        { name: "logs.follow", arguments: { source: "build" } },
        { contextFor: contextFor() },
      ),
    );
    // "build" is seeded with three lines; each arrives as a chunk with its 1-based position, in order …
    expect(chunks).toEqual([
      { line: "build started", n: 1 },
      { line: "compiling", n: 2 },
      { line: "build ok", n: 3 },
    ]);
    // … and the generator RETURNS the final value (a copilot shows it once the stream completes).
    expect(final).toEqual({ source: "build", lineCount: 3 });
  });

  test("an unknown source streams nothing and returns a zero count", async () => {
    const { chunks, final } = await collect(
      streamToolCall(
        registry(),
        { name: "logs.follow", arguments: { source: "nope" } },
        { contextFor: contextFor() },
      ),
    );
    expect(chunks).toEqual([]);
    expect(final).toEqual({ source: "nope", lineCount: 0 });
  });

  test("a missing scope is refused BEFORE any chunk — the first pull throws (authz is the core's)", async () => {
    const gen = streamToolCall(
      registry(),
      { name: "logs.follow", arguments: { source: "build" } },
      { contextFor: contextFor([]) },
    );
    await expect(gen.next()).rejects.toMatchObject({ code: "forbidden" });
  });

  test("invalid input is refused BEFORE any chunk — the first pull throws validation", async () => {
    const gen = streamToolCall(
      registry(),
      { name: "logs.follow", arguments: { source: "" } },
      { contextFor: contextFor() },
    );
    await expect(gen.next()).rejects.toMatchObject({ code: "validation" });
  });

  test("streaming a NON-streaming capability is refused up front", async () => {
    const gen = streamToolCall(
      registry(),
      { name: "logs.tail", arguments: { source: "build" } },
      { contextFor: contextFor() },
    );
    await expect(gen.next()).rejects.toMatchObject({ code: "validation" });
  });
});

/**
 * MID-STREAM FAILURE on the agent surface — the REFERENCE rendering the other three surfaces must match (see
 * `docs/STREAMING-CONTRACT.md`). The driver consumes the generator with a `for await`; it sees the K validated
 * chunks, then the loop THROWS the FacetError. Nothing is translated to an `{ errorCode }` here — a streaming
 * failure surfaces as the thrown typed error, exactly as the core raises it.
 */
describe("mid-stream failure on the agent surface: chunks delivered, THEN the generator throws", () => {
  const TWO_CHUNKS = [
    { line: "boom started", n: 1 },
    { line: "still fine", n: 2 },
  ];

  /** Consume a stream expected to fail: gather chunks, capture the throw (fail the test if it does not throw). */
  async function drive(
    gen: AsyncGenerator<unknown, unknown, void>,
  ): Promise<{ chunks: unknown[]; error: unknown }> {
    const chunks: unknown[] = [];
    try {
      for await (const chunk of gen) chunks.push(chunk);
    } catch (error) {
      return { chunks, error };
    }
    throw new Error("expected the agent stream to throw mid-iteration");
  }

  test("a handler throw: the two chunks arrive, then the generator throws the typed FacetError", async () => {
    const { chunks, error } = await drive(
      streamToolCall(
        registry(),
        { name: "logs.boom", arguments: { mode: "throw" } },
        { contextFor: contextFor() },
      ),
    );
    expect(chunks).toEqual(TWO_CHUNKS);
    expect(error).toBeInstanceOf(FacetError);
    expect(error).toMatchObject({ code: "connector_unavailable" });
  });

  test("a bad chunk: the two valid chunks arrive, then the generator throws internal", async () => {
    const { chunks, error } = await drive(
      streamToolCall(
        registry(),
        { name: "logs.boom", arguments: { mode: "bad-chunk" } },
        { contextFor: contextFor() },
      ),
    );
    expect(chunks).toEqual(TWO_CHUNKS);
    expect(error).toBeInstanceOf(FacetError);
    expect(error).toMatchObject({ code: "internal" });
  });
});
