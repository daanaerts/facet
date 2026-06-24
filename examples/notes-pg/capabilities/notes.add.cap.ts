import { defineCapability } from "@facet/core";
import { z } from "zod";
import { store } from "../store";

/**
 * `notes.add` — a write, scoped `notes:write`, confirmation-gated by the chokepoint. `idempotent: true` ⇒ a
 * retry carrying the same idempotency key replays the first note instead of inserting a second; the dedup
 * happens in `execute()` against the host's `PgLedger`, never here. The note lands in the caller's workspace,
 * enforced by the RLS `WITH CHECK` the store runs under.
 */
export default defineCapability({
  id: "notes.add",
  summary: "Add a note to your workspace.",
  input: z.object({
    body: z.string().min(1).describe("The note text."),
  }),
  output: z.object({
    id: z.number(),
    workspace: z.string(),
    body: z.string(),
  }),
  scopes: ["notes:write"],
  risk: "write",
  idempotent: true,
  handler: async (input, ctx) => {
    const note = await store.add(ctx, input.body);
    ctx.audit("notes.added", { id: note.id });
    return note;
  },
});
