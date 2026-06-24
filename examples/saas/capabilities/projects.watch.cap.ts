import { defineStreamingCapability, requireClaim } from "@facet/core";
import { z } from "zod";
import { store } from "../store";

/**
 * `projects.watch` — a STREAMING read, the workspace-scoped companion to `projects.list`. It yields one chunk
 * per project in the caller's workspace, then returns a final `{ count }`. Like every streaming capability it
 * is `read` by construction (no confirmation, no ledger), and like every capability here it reads the tenant
 * from the claim — so the stream, too, is isolated to the caller's workspace. One streaming definition projects
 * to SSE (HTTP), printed lines (CLI), progress notifications (MCP), and a drained final value (non-streaming).
 */
export default defineStreamingCapability({
  id: "projects.watch",
  summary: "Stream each project in your workspace one at a time, then a final count.",
  input: z.object({}),
  chunk: z.object({
    project: z.object({
      id: z.string(),
      name: z.string(),
      workspace: z.string(),
      createdAt: z.string(),
    }),
    n: z.number().int().min(1).describe("Its 1-based position in the stream."),
  }),
  output: z.object({
    count: z.number().int().min(0).describe("How many projects were streamed."),
  }),
  scopes: ["projects:read"],
  async *handler(_input, ctx) {
    const workspace = requireClaim<string>(ctx, "workspace");
    let n = 0;
    for (const project of store.list(workspace)) {
      n += 1;
      yield { project, n };
    }
    return { count: n };
  },
});
