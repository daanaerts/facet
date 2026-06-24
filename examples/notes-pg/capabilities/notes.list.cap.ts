import { defineCapability } from "@facet/core";
import { z } from "zod";
import { store } from "../store";

/**
 * `notes.list` — a read, scoped `notes:read`, auto-runs everywhere. It asks the store for "every note", with no
 * tenant filter of its own: the RLS policy the store runs under returns only the caller's workspace. Two
 * different workspaces calling this exact capability get two different result sets, from one unchanged query.
 */
export default defineCapability({
  id: "notes.list",
  summary: "List the notes in your workspace.",
  input: z.object({}),
  output: z.object({
    notes: z.array(z.object({ id: z.number(), workspace: z.string(), body: z.string() })),
  }),
  scopes: ["notes:read"],
  risk: "read",
  handler: async (_input, ctx) => ({ notes: await store.list(ctx) }),
});
