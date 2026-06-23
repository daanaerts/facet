import { defineStreamingCapability } from "@facet/core";
import { z } from "zod";
import { store } from "../store";

/**
 * `todos.watch` — a STREAMING read, the companion to `todos.list`. Where `list` returns the whole batch at
 * once, `watch` is an async generator: it yields ONE chunk per current todo (`{ todo, n }`) and returns a
 * final `{ count }`. This is the agent-primary streaming model — the core hands an agent the chunks as they
 * are produced (`executeStream`), and the human surfaces render them downstream (HTTP as SSE, CLI as printed
 * lines, MCP as progress), while a non-streaming caller still gets the final via `execute()`, which drains.
 * Being a read, it auto-runs on every surface with no confirmation and no ledger — exactly like `list`.
 *
 * A real watch would also stream NEW todos as they are added; this demo deliberately walks only the todos
 * present at call time so the example domain stays a finite, honest exercise of the streaming chokepoint.
 */
export default defineStreamingCapability({
  id: "todos.watch",
  summary: "Stream each current to-do item one at a time, then a final count.",
  input: z.object({
    done: z.boolean().optional().describe("Filter: only done (true) or only open (false) items."),
  }),
  chunk: z.object({
    todo: z.object({
      id: z.string(),
      title: z.string(),
      done: z.boolean(),
      createdAt: z.string(),
    }),
    n: z.number().int().min(1).describe("Its 1-based position in the stream."),
  }),
  output: z.object({
    count: z.number().int().min(0).describe("How many todos were streamed."),
  }),
  scopes: ["todos:read"],
  async *handler(input) {
    const todos = store.list(input.done === undefined ? undefined : { done: input.done });
    let n = 0;
    for (const todo of todos) {
      n += 1;
      yield { todo, n };
    }
    return { count: n };
  },
});
