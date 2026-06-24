import { defineCapability } from "@facet/core";
import { z } from "zod";
import { store } from "../store";

/**
 * `jobs.start` — a write. Confirmation-gated by the chokepoint (the surface's "[Yes]" / `--yes` / MCP
 * `confirm: true`), scoped `jobs:write`. `idempotent: true` ⇒ a retry carrying the same idempotency key
 * replays the first result instead of starting a second job.
 */
export default defineCapability({
  id: "jobs.start",
  summary: "Start a background job.",
  description:
    "Starts a named background job and returns its id and initial status. A write: the chokepoint gates it\n" +
    "behind confirmation (`--yes` on the CLI, `confirm: true` on the agent/MCP surfaces). Idempotent — a\n" +
    "retry carrying the same `--key` replays the first job instead of starting a second.",
  examples: [
    {
      input: { name: "nightly" },
      note: "Start the nightly job (the CLI needs --yes to actually run it).",
    },
  ],
  input: z.object({
    name: z.string().min(1).describe("A human name for the job."),
  }),
  output: z.object({
    id: z.string(),
    name: z.string(),
    status: z.enum(["running", "done", "cancelled"]),
  }),
  scopes: ["jobs:write"],
  risk: "write",
  idempotent: true,
  handler: async (input, ctx) => {
    const job = store.startJob(input.name);
    ctx.audit("jobs.started", { id: job.id, name: job.name });
    return job;
  },
});
