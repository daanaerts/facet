import { defineCapability } from "@facet/core";
import { z } from "zod";
import { type EmailConnector, useConnector } from "../connectors";
import { outbox } from "../outbox";

/**
 * `email.send` — a write with an IRREVERSIBLE external effect: `reversible: false`, because you cannot un-send
 * an email. So the chokepoint gates it — ask an agent to email a customer and it comes back
 * `confirmation_required` until the surface confirms. The actual delivery goes through `ctx.connector`: the
 * handler resolves an `EmailConnector` off the Context (the in-memory one in dev, Resend in prod) and never
 * imports a provider. If no connector is wired, `useConnector` throws `ConnectorUnavailableError` — a loud,
 * typed failure on every surface, not a silent no-op. `idempotent: true` ⇒ a retried send with the same key
 * replays the first result instead of sending twice.
 */
export default defineCapability({
  id: "email.send",
  summary: "Send an email through the configured email connector.",
  input: z.object({
    to: z.string().min(1).describe("Recipient address."),
    subject: z.string().min(1).describe("Subject line."),
    body: z.string().min(1).describe("Message body."),
  }),
  output: z.object({
    id: z.string(),
    kind: z.enum(["email", "issue"]),
    target: z.string(),
    summary: z.string(),
    provider: z.string(),
    createdAt: z.string(),
  }),
  scopes: ["outbox:send"],
  risk: "write",
  reversible: false,
  idempotent: true,
  handler: async (input, ctx) => {
    const email = useConnector<EmailConnector>(ctx, "email");
    const sent = await email.send({ to: input.to, subject: input.subject, body: input.body });
    const entry = outbox.append({
      kind: "email",
      target: input.to,
      summary: input.subject,
      provider: sent.provider,
    });
    ctx.audit("email.sent", { id: entry.id, to: input.to, provider: sent.provider });
    return entry;
  },
});
