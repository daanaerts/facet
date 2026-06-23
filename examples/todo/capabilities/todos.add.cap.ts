import { defineCapability } from "@facet/core";
import { z } from "zod";
import { store } from "../store";

/**
 * `todos.add` — a write. Confirmation-gated by the chokepoint (the surface's "[Yes]" / `--yes` / MCP
 * `confirm: true`), scoped `todos:write`. `idempotent: true` ⇒ a retry carrying the same idempotency key
 * replays the first created todo instead of inserting a second one — the dedup happens in `execute()` against
 * the host's ledger, never here.
 */
export default defineCapability({
  id: "todos.add",
  summary: "Add a to-do item.",
  input: z.object({
    title: z.string().min(1).describe("What to do."),
  }),
  output: z.object({
    id: z.string(),
    title: z.string(),
    done: z.boolean(),
    createdAt: z.string(),
  }),
  scopes: ["todos:write"],
  risk: "write",
  idempotent: true,
  handler: async (input, ctx) => {
    const todo = store.add(input.title);
    ctx.audit("todos.added", { id: todo.id, title: todo.title });
    return todo;
  },
});
