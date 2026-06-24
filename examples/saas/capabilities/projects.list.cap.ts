import { defineCapability, requireClaim } from "@facet/core";
import { z } from "zod";
import { store } from "../store";

/**
 * `projects.list` — a read, scoped to the caller's workspace. The tenant is NOT an input: the handler pulls it
 * from `ctx.claims` via `requireClaim`, so a caller can only ever list its OWN workspace. This is the core
 * multi-tenant lesson — the same capability, called by two tenants, returns two disjoint result sets, and
 * neither the engine nor any surface had to know what a workspace is.
 */
export default defineCapability({
  id: "projects.list",
  summary: "List the projects in your workspace.",
  input: z.object({}),
  output: z.object({
    projects: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        workspace: z.string(),
        createdAt: z.string(),
      }),
    ),
  }),
  scopes: ["projects:read"],
  handler: async (_input, ctx) => {
    const workspace = requireClaim<string>(ctx, "workspace");
    return { projects: store.list(workspace) };
  },
});
