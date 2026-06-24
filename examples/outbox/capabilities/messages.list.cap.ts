import { defineCapability } from "@facet/core";
import { z } from "zod";
import { outbox } from "../outbox";

/** The wire shape of an outbox entry, shared by the list / send / open / tail outputs. */
const entryShape = z.object({
  id: z.string(),
  kind: z.enum(["email", "issue"]),
  target: z.string(),
  summary: z.string(),
  provider: z.string(),
  createdAt: z.string(),
});

/** `messages.list` — a read of the local outbox log. Auto-runs on every surface with no confirmation. */
export default defineCapability({
  id: "messages.list",
  summary: "List everything in the outbox (sent emails and opened issues).",
  input: z.object({}),
  output: z.object({ messages: z.array(entryShape) }),
  scopes: ["outbox:read"],
  handler: async () => {
    return { messages: outbox.list() };
  },
});
