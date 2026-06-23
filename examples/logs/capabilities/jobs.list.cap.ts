import { defineCapability } from "@facet/core";
import { z } from "zod";
import { store } from "../store";

/** `jobs.list` — a read over current jobs. */
export default defineCapability({
  id: "jobs.list",
  summary: "List jobs and their status.",
  input: z.object({}),
  output: z.object({
    jobs: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        status: z.enum(["running", "done", "cancelled"]),
      }),
    ),
  }),
  scopes: ["jobs:read"],
  handler: async () => ({ jobs: store.listJobs() }),
});
