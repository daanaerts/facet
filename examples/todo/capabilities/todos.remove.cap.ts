import { defineCapability, NotFoundError } from "@facet/core";
import { z } from "zod";
import { store } from "../store";

/**
 * `todos.remove` — a destructive write. Same confirmation gate as a write, but `risk: "destructive"` drives
 * the stronger affordance on each surface (the MCP `destructiveHint`, an undo pairing if the host wants one).
 * A missing id 404s with the shared `not_found` taxonomy.
 */
export default defineCapability({
  id: "todos.remove",
  summary: "Remove a to-do item.",
  input: z.object({
    id: z.string().min(1).describe("The id of the todo to remove."),
  }),
  output: z.object({
    id: z.string(),
    removed: z.literal(true),
  }),
  scopes: ["todos:write"],
  risk: "destructive",
  handler: async (input) => {
    const removed = store.remove(input.id);
    if (!removed) throw new NotFoundError(`todo not found: ${input.id}`, { id: input.id });
    return { id: input.id, removed: true as const };
  },
});
