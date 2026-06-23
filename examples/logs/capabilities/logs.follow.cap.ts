import { defineStreamingCapability } from "@facet/core";
import { z } from "zod";
import { store } from "../store";

/**
 * `logs.follow` — a STREAMING read, the companion to `logs.tail`. Where `tail` returns a bounded batch,
 * `follow` is an async generator: it yields each existing log line of a source as a structured chunk
 * `{ line, n }` and returns a final `{ source, lineCount }`. This is the agent-primary streaming model from
 * the README "Next": the core hands an agent the chunks as they are produced, and the human surfaces render
 * them downstream (HTTP as SSE, CLI as printed lines, MCP as progress). Being a read, it auto-runs on every
 * surface with no confirmation and no ledger — exactly like `tail`.
 *
 * A real follow would also tail NEW lines as they arrive; this demo deliberately walks only the lines present
 * at call time so the example domain stays an honest, finite extraction proof for the streaming chokepoint.
 */
export default defineStreamingCapability({
  id: "logs.follow",
  summary: "Stream each existing log line of a source as it is read, then a final line count.",
  input: z.object({
    source: z.string().min(1).describe('The log source, e.g. "build", "deploy", or a job id.'),
  }),
  chunk: z.object({
    line: z.string().describe("One log line."),
    n: z.number().int().min(1).describe("Its 1-based position in the stream."),
  }),
  output: z.object({
    source: z.string(),
    lineCount: z.number().int().min(0).describe("How many lines were streamed."),
  }),
  scopes: ["logs:read"],
  async *handler(input) {
    const lines = store.lines(input.source);
    let n = 0;
    for (const line of lines) {
      n += 1;
      yield { line, n };
    }
    return { source: input.source, lineCount: n };
  },
});
