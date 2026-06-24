import { defineStreamingCapability } from "@facet/core";
import { z } from "zod";
import { outbox } from "../outbox";

/**
 * `outbox.tail` — a STREAMING read of the outbox log: one chunk per entry, then a final `{ count }`. A read by
 * construction (no confirmation, no ledger), and one definition projects to SSE / printed lines / MCP progress /
 * a drained final value. It is the read companion to the connector-backed writes — proof the streaming idiom is
 * orthogonal to which port a capability happens to use.
 */
export default defineStreamingCapability({
  id: "outbox.tail",
  summary: "Stream each outbox entry one at a time, then a final count.",
  input: z.object({}),
  chunk: z.object({
    entry: z.object({
      id: z.string(),
      kind: z.enum(["email", "issue"]),
      target: z.string(),
      summary: z.string(),
      provider: z.string(),
      createdAt: z.string(),
    }),
    n: z.number().int().min(1).describe("Its 1-based position in the stream."),
  }),
  output: z.object({ count: z.number().int().min(0) }),
  scopes: ["outbox:read"],
  async *handler() {
    let n = 0;
    for (const entry of outbox.list()) {
      n += 1;
      yield { entry, n };
    }
    return { count: n };
  },
});
