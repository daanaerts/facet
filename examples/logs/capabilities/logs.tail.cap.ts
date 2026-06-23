import { defineCapability } from "@facet/core";
import { z } from "zod";
import { store } from "../store";

/**
 * `logs.tail` — a read. Auto-runs on every surface, no confirmation.
 *
 * STREAMING (the next spike): a real `tail` streams. Today it returns a bounded batch so the core slice
 * stays clean. The agent-primary design — `execute()` yields structured chunks, HTTP renders them as SSE,
 * CLI prints them, MCP emits progress — is deliberately NOT in this first carve. See README "Next".
 */
export default defineCapability({
  id: "logs.tail",
  summary: "Return the most recent log lines for a source.",
  input: z.object({
    source: z.string().min(1).describe('The log source, e.g. "build", "deploy", or a job id.'),
    limit: z.number().int().min(1).max(1000).default(50).describe("How many trailing lines."),
  }),
  output: z.object({
    source: z.string(),
    lines: z.array(z.string()),
  }),
  scopes: ["logs:read"],
  handler: async (input) => ({
    source: input.source,
    lines: store.tail(input.source, input.limit),
  }),
});
