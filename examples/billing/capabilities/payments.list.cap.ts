import { defineCapability } from "@facet/core";
import { z } from "zod";
import { gateway } from "../gateway";

/** The wire shape of a payment, shared by `list` / `charge` / `refund` / `export` outputs. */
const paymentShape = z.object({
  id: z.string(),
  amountCents: z.number().int(),
  currency: z.string(),
  customer: z.string(),
  status: z.enum(["succeeded", "partially_refunded", "refunded"]),
  refundedCents: z.number().int(),
  createdAt: z.string(),
});

/**
 * `payments.list` — a read. Auto-runs on every surface with no confirmation. It reaches the payment gateway
 * through the same `PaymentGateway` port `charge` and `refund` use, so it returns live data whether the gateway
 * is the in-memory fake or real Stripe.
 */
export default defineCapability({
  id: "payments.list",
  summary: "List recent payments.",
  input: z.object({}),
  output: z.object({ payments: z.array(paymentShape) }),
  scopes: ["payments:read"],
  handler: async () => {
    return { payments: await gateway.list() };
  },
});
