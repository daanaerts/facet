import { claimOf, defineCapability, FacetError, NotFoundError, requireClaim } from "@facet/core";
import { z } from "zod";
import { store } from "../store";

/**
 * `projects.delete` — the example's wedge AND its tenant-isolation proof in one capability.
 *
 *  - It is `destructive` and `reversible: false`: the chokepoint refuses it unless the surface confirms, so an
 *    agent asked to "delete project X" comes back `confirmation_required` rather than just doing it. The GUI's
 *    button, the CLI's `--yes`, and the agent's propose→confirm all assert that one gate.
 *  - It reads TWO claims. `workspace` (required) scopes the delete to the caller's tenant — deleting an id that
 *    belongs to another workspace returns `false` from the store and renders as a clean `not_found`, so the
 *    tenant boundary holds even on a guessed id. `role` (optional) gates the action to admins: claims here drive
 *    an AUTHORIZATION decision the coarse `projects:write` scope can't express.
 */
export default defineCapability({
  id: "projects.delete",
  summary: "Permanently delete a project from your workspace (admins only).",
  input: z.object({
    id: z.string().describe("The id of the project to delete."),
  }),
  output: z.object({ id: z.string(), deleted: z.literal(true) }),
  scopes: ["projects:write"],
  risk: "destructive",
  reversible: false,
  handler: async (input, ctx) => {
    const workspace = requireClaim<string>(ctx, "workspace");
    if (claimOf<string>(ctx, "role") !== "admin") {
      throw new FacetError("forbidden", "only workspace admins may delete projects", 403);
    }
    if (!store.remove(workspace, input.id)) {
      throw new NotFoundError(`project not found: ${input.id}`, { id: input.id });
    }
    ctx.audit("projects.deleted", { id: input.id, workspace });
    return { id: input.id, deleted: true as const };
  },
});
