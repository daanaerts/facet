import { defineCapability } from "@facet/core";
import { z } from "zod";
import { gateway } from "../gateway";

/**
 * `payments.charge` — a write, confirmation-gated and scoped `payments:write`. It is `reversible: true`: a
 * charge is recoverable (you can refund it), which is the dimension `risk` alone can't express — a surface can
 * use it to soften its confirmation copy ("you can refund this later") versus the refund's permanent one. It is
 * `idempotent: true`: a retry carrying the same idempotency key replays the first charge instead of charging
 * twice — the dedup happens in `execute()` against the host's ledger, the classic never-double-charge guarantee.
 */
export default defineCapability({
  id: "payments.charge",
  summary: "Charge a customer.",
  input: z.object({
    amountCents: z.number().int().positive().describe("Amount in cents (integer, never a float)."),
    currency: z.string().default("usd").describe("ISO currency code."),
    customer: z.string().min(1).describe("The customer id to charge."),
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
  risk: "write",
  reversible: true,
  idempotent: true,
  handler: async (input, ctx) => {
    const payment = await gateway.charge({
      amountCents: input.amountCents,
      currency: input.currency,
      customer: input.customer,
    });
    ctx.audit("payments.charged", { id: payment.id, amountCents: payment.amountCents });
    return payment;
  },
});
