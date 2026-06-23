import { defineStreamingCapability, FacetError } from "@facet/core";
import { z } from "zod";

/**
 * `logs.boom` — a STREAMING read that deliberately FAILS MID-STREAM, the fixture for the mid-stream-error
 * contract (see `docs/STREAMING-CONTRACT.md`). It always yields two VALID chunks first — so every surface has
 * really committed to a success framing (HTTP 200 SSE, MCP progress, CLI lines) before anything goes wrong —
 * and then fails in one of the two ways the contract distinguishes, chosen by `mode`:
 *
 *   - `mode: "throw"`     — the handler THROWS a `FacetError` while producing chunk 3. This is the
 *                           handler-throws-mid-iteration trigger; the typed error keeps its own code (here a
 *                           `connector_unavailable`, picked so the assertions prove the ORIGINAL code is what
 *                           each surface renders — not a generic `internal`).
 *   - `mode: "raw-throw"` — the handler throws a PLAIN `Error` while producing chunk 3. Proves the core
 *                           normalizes a non-`FacetError` mid-stream throw to `internal`, so no surface ever
 *                           sees an untyped error escape `executeStream()`.
 *   - `mode: "bad-chunk"` — the handler YIELDS a third value that violates the `chunk` schema (`n` is a
 *                           string). The handler itself does not throw; `executeStream()`'s per-chunk
 *                           validation is what throws `FacetError("internal", …)` after the two good chunks.
 *
 * It is a `read` (every streaming capability is), so it auto-runs on every surface with no confirmation and no
 * ledger — exactly like `logs.follow`. Nothing about the failure is surface-specific: the throw originates in
 * the core, and each surface only renders it. The capability touches no store; the two good chunks are
 * synthetic so the fixture is hermetic and order-deterministic.
 */
export default defineStreamingCapability({
  id: "logs.boom",
  summary:
    "A streaming read that yields two chunks then fails mid-stream (test fixture for the error contract).",
  input: z.object({
    mode: z
      .enum(["throw", "raw-throw", "bad-chunk"])
      .default("throw")
      .describe("How the stream fails after its two valid chunks."),
  }),
  chunk: z.object({
    line: z.string().describe("One log line."),
    n: z.number().int().min(1).describe("Its 1-based position in the stream."),
  }),
  output: z.object({
    source: z.string(),
    lineCount: z.number().int().min(0),
  }),
  scopes: ["logs:read"],
  async *handler(input) {
    // Two genuinely valid chunks first — every surface commits to "streaming, all good" here.
    yield { line: "boom started", n: 1 };
    yield { line: "still fine", n: 2 };

    // Then fail, in whichever way the contract case under test needs.
    if (input.mode === "throw") {
      // A typed FacetError thrown mid-iteration — passes through `executeStream` UNCHANGED (keeps its code).
      throw new FacetError("connector_unavailable", "log source went away mid-stream", 501, {
        source: "boom",
      });
    }
    if (input.mode === "raw-throw") {
      // A plain Error thrown mid-iteration — the core normalizes it to a FacetError("internal", …).
      throw new Error("unexpected boom");
    }
    // "bad-chunk": a third chunk that violates the `chunk` schema (`n` must be an int ≥ 1, not a string).
    // The handler does NOT throw; `executeStream`'s per-chunk validation rejects this and throws.
    yield { line: "this chunk is malformed", n: "three" } as unknown as { line: string; n: number };

    // Unreachable: `throw`/`raw-throw` have thrown, and on `bad-chunk` the core rejects the malformed yield
    // before resuming the generator — so a final is never actually produced. It exists only to give the
    // generator the `output`-typed return the schema declares (this fixture's whole point is to fail first).
    return { source: "boom", lineCount: 2 };
  },
});
