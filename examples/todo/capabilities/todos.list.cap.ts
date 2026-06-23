import { defineCapability } from "@facet/core";
import { z } from "zod";
import { store } from "../store";

/**
 * `todos.list` — a read over the current todos. Auto-runs on every surface, no confirmation. The optional
 * `done` filter narrows to completed (`true`) or open (`false`) items; omitted, it returns all of them.
 */
export default defineCapability({
  id: "todos.list",
  summary: "List to-do items, optionally filtered by done state.",
  input: z.object({
    done: z.boolean().optional().describe("Filter: only done (true) or only open (false) items."),
  }),
  output: z.object({
    todos: z.array(
      z.object({
        id: z.string(),
        title: z.string(),
        done: z.boolean(),
        createdAt: z.string(),
      }),
    ),
  }),
  scopes: ["todos:read"],
  handler: async (input) => ({
    todos: store.list(input.done === undefined ? undefined : { done: input.done }),
  }),
});
