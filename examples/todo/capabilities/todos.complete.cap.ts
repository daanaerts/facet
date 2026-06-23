import { defineCapability, NotFoundError } from "@facet/core";
import { z } from "zod";
import { store } from "../store";

/**
 * `todos.complete` — a write that marks a todo done. Confirmation-gated and scoped `todos:write`, exactly
 * like `todos.add`. A missing id is a `NotFoundError` (the same `not_found` taxonomy every surface renders —
 * an HTTP 404, a CLI `✗ not_found`, an MCP `isError`).
 */
export default defineCapability({
  id: "todos.complete",
  summary: "Mark a to-do item as done.",
  input: z.object({
    id: z.string().min(1).describe("The id of the todo to complete."),
  }),
  output: z.object({
    id: z.string(),
    title: z.string(),
    done: z.boolean(),
    createdAt: z.string(),
  }),
  scopes: ["todos:write"],
  risk: "write",
  handler: async (input) => {
    const todo = store.complete(input.id);
    if (!todo) throw new NotFoundError(`todo not found: ${input.id}`, { id: input.id });
    return todo;
  },
});
