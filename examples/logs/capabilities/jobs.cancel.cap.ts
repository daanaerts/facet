import { defineCapability, NotFoundError } from "@facet/core";
import { z } from "zod";
import { store } from "../store";

/**
 * `jobs.cancel` — a destructive write. Same confirmation gate as a write, but `risk: "destructive"` drives
 * the stronger affordance on each surface (the MCP `destructiveHint`, an undo pairing if the host wants one).
 */
export default defineCapability({
  id: "jobs.cancel",
  summary: "Cancel a running job.",
  input: z.object({
    id: z.string().min(1).describe("The job id to cancel."),
  }),
  output: z.object({
    id: z.string(),
    status: z.enum(["running", "done", "cancelled"]),
  }),
  scopes: ["jobs:write"],
  risk: "destructive",
  handler: async (input) => {
    const job = store.cancelJob(input.id);
    if (!job) throw new NotFoundError(`job not found: ${input.id}`, { id: input.id });
    return { id: job.id, status: job.status };
  },
});
