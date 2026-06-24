import { defineCapability, requireClaim } from "@facet/core";
import { z } from "zod";
import { store } from "../store";

/**
 * `projects.create` — a write, confirmation-gated by the chokepoint and scoped `projects:write`. The new
 * project is stamped with the caller's workspace claim (never an input field), so a create lands in the
 * caller's tenant and nowhere else. `idempotent: true` ⇒ a retry carrying the same idempotency key replays the
 * first created project — and because the host hands a workspace-scoped ledger (see `ledger.ts`), two tenants
 * using the same key `"k1"` get two independent projects, not a cross-tenant replay.
 */
export default defineCapability({
  id: "projects.create",
  summary: "Create a project in your workspace.",
  input: z.object({
    name: z.string().min(1).describe("The project name."),
  }),
  output: z.object({
    id: z.string(),
    name: z.string(),
    workspace: z.string(),
    createdAt: z.string(),
  }),
  scopes: ["projects:write"],
  risk: "write",
  idempotent: true,
  handler: async (input, ctx) => {
    const workspace = requireClaim<string>(ctx, "workspace");
    const project = store.create(workspace, input.name);
    ctx.audit("projects.created", { id: project.id, workspace });
    return project;
  },
});
