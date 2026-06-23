import { beforeEach, describe, expect, test } from "bun:test";
import {
  assertParity,
  type CallOpts,
  type ParityHosts,
  type StreamResult,
  viaAgentStream,
  viaCliStream,
  viaExecuteStream,
  viaHttpStream,
  viaMcpStream,
} from "@facet/parity";
import { store } from "../../../examples/logs/store";
import { logsHosts } from "./hosts";

/**
 * STREAMING cross-surface parity — the keystone corner. A stream cannot be compared as a single value: it is
 * an ORDERED CHUNK SEQUENCE plus a TERMINATION (a clean final, or a mid-stream error). So each leg is
 * normalized to `{ chunks, result?, errorCode? }`, and parity means the raw `executeStream()` baseline and all
 * four surface renderings emit the SAME chunks in the SAME order and END the same way.
 *
 * The two cases that matter:
 *   - a NORMAL stream (`logs.follow`) — the same chunks then the same final on every leg; and
 *   - a MID-STREAM ERROR (`logs.boom`) — the same K chunks then the SAME `FacetError` code on every leg, the
 *     contract the previous phase implemented: once the first chunk is out a surface can no longer answer with
 *     a status, so the ONLY thing defining "it failed" is the terminal frame (SSE `event: error`, MCP
 *     `isError` after the progress notifications, CLI `✗` + nonzero exit, the agent iterator throwing), and
 *     every surface must agree on it.
 *
 * The logs store is reset to its seed before each leg so a `follow` over `"build"` walks the SAME three lines.
 */

/** Reset the logs store to its seed so a streamed source walks an identical, reproducible line set per leg. */
function freshWorld(): void {
  store.reset();
}

beforeEach(freshWorld);

/** The five streaming legs, keyed by label — `executeStream` is the baseline `assertParity` references. */
const LEGS: Record<
  string,
  (
    hosts: ParityHosts,
    id: string,
    input: Record<string, unknown>,
    opts?: CallOpts,
  ) => Promise<StreamResult>
> = {
  executeStream: viaExecuteStream,
  agent: viaAgentStream,
  cli: viaCliStream,
  http: viaHttpStream,
  mcp: viaMcpStream,
};

/** Run one streaming call across all five legs (each on a freshly-reset world), keyed by leg label. */
async function onAllLegs(
  hosts: ParityHosts,
  id: string,
  input: Record<string, unknown>,
  opts?: CallOpts,
): Promise<Record<string, StreamResult>> {
  const results: Record<string, StreamResult> = {};
  for (const [label, via] of Object.entries(LEGS)) {
    freshWorld();
    results[label] = await via(hosts, id, input, opts);
  }
  return results;
}

describe("streaming parity — the same ordered chunks + the same termination on every leg", () => {
  test("NORMAL stream: logs.follow emits the SAME chunk sequence + final on baseline · agent · cli · http · mcp", async () => {
    const results = await onAllLegs(logsHosts(), "logs.follow", { source: "build" });
    assertParity(results);
    // The seeded "build" source has three lines; every leg streams them 1..3 in order, then the final count.
    const expectedChunks = [
      { line: "build started", n: 1 },
      { line: "compiling", n: 2 },
      { line: "build ok", n: 3 },
    ];
    const expectedResult = { source: "build", lineCount: 3 };
    for (const result of Object.values(results)) {
      expect(result.chunks).toEqual(expectedChunks);
      expect(result.result).toEqual(expectedResult);
      expect(result.errorCode).toBeUndefined();
    }
  });

  describe("MID-STREAM ERROR: the same K chunks then the same FacetError code on every leg", () => {
    // logs.boom always yields two VALID chunks first — so every leg has really committed to a success framing
    // (HTTP 200 SSE, MCP progress, CLI lines, the agent iterator) before anything goes wrong.
    const TWO_GOOD_CHUNKS = [
      { line: "boom started", n: 1 },
      { line: "still fine", n: 2 },
    ];

    test('mode "throw": a typed FacetError mid-stream keeps its code (connector_unavailable) on every leg', async () => {
      const results = await onAllLegs(logsHosts(), "logs.boom", { mode: "throw" });
      assertParity(results);
      for (const result of Object.values(results)) {
        // The two good chunks made it out on every leg, THEN the original typed code — not a generic internal.
        expect(result.chunks).toEqual(TWO_GOOD_CHUNKS);
        expect(result.errorCode).toBe("connector_unavailable");
        expect(result.result).toBeUndefined();
      }
    });

    test('mode "bad-chunk": a chunk that fails its schema terminates as internal on every leg', async () => {
      // The handler does not throw; executeStream()'s per-chunk validation rejects the malformed third chunk
      // AFTER the two good ones — so every leg shows the same two chunks then `internal`.
      const results = await onAllLegs(logsHosts(), "logs.boom", { mode: "bad-chunk" });
      assertParity(results);
      for (const result of Object.values(results)) {
        expect(result.chunks).toEqual(TWO_GOOD_CHUNKS);
        expect(result.errorCode).toBe("internal");
      }
    });

    test('mode "raw-throw": a plain Error mid-stream is normalized to internal on every leg', async () => {
      // A non-FacetError thrown mid-iteration is normalized by the core to `internal`, so no surface ever sees
      // an untyped error escape — every leg renders the same two chunks then `internal`.
      const results = await onAllLegs(logsHosts(), "logs.boom", { mode: "raw-throw" });
      assertParity(results);
      for (const result of Object.values(results)) {
        expect(result.chunks).toEqual(TWO_GOOD_CHUNKS);
        expect(result.errorCode).toBe("internal");
      }
    });
  });
});
