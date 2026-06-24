import { defineCapability } from "@facet/core";
import { z } from "zod";
import { gateway } from "../gateway";

/**
 * `payments.refund` — the example's wedge. It is `destructive` and `reversible: false`: money out the door, you
 * cannot un-refund. So the chokepoint refuses it unless the surface confirms — ask an agent to "refund $5000"
 * and it comes back `confirmation_required` rather than just moving the money. The GUI's button, the CLI's
 * `--yes`, and the agent's propose→confirm all assert that one gate; it lives in `execute()`, not in any surface.
 *
 * It is `idempotent: true`, and here that is a MONEY-SAFETY property, not an optimization: a double-submitted
 * refund (a retried request, a double-clicked button, an agent that re-fired the tool) carrying the same key
 * replays the first refund's result instead of issuing a second one. The atomic `claim` in the ledger is what
 * stands between a network blip and a duplicate refund.
 */
export default defineCapability({
  id: "payments.refund",
  summary: "Refund a payment, fully or partially.",
  input: z.object({
    paymentId: z.string().describe("The payment to refund."),
    amountCents: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Cents to refund; omit for a full refund of the remaining balance."),
  }),
  output: z.object({
    id: z.string(),
    amountCents: z.number().int(),
    currency: z.string(),
    customer: z.string(),
    status: z.enum(["succeeded", "partially_refunded", "refunded"]),
    refundedCents: z.number().int(),
    createdAt: z.string(),
  }),
  scopes: ["payments:write"],
  risk: "destructive",
  reversible: false,
  idempotent: true,
  handler: async (input, ctx) => {
    const payment = await gateway.refund(input.paymentId, input.amountCents);
    ctx.audit("payments.refunded", { id: payment.id, refundedCents: payment.refundedCents });
    return payment;
  },
});
