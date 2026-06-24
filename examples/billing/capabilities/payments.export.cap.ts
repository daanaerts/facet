import { defineStreamingCapability } from "@facet/core";
import { z } from "zod";
import { gateway } from "../gateway";

/**
 * `payments.export` — a STREAMING read: the "export / summarize" companion the validation plan pairs with the
 * destructive wedge. It yields one chunk per payment (with a running net total) and returns a final
 * `{ count, netCents }`. Being a read it is `read` by construction — no confirmation, no ledger — and one
 * definition projects to SSE (HTTP), printed lines (CLI), progress notifications (MCP) and a drained final value
 * (non-streaming callers). `netCents` is the running amount minus refunds, so an export doubles as a ledger tape.
 */
export default defineStreamingCapability({
  id: "payments.export",
  summary: "Stream every payment one at a time as an export tape, then a final total.",
  input: z.object({}),
  chunk: z.object({
    payment: z.object({
      id: z.string(),
      amountCents: z.number().int(),
      currency: z.string(),
      customer: z.string(),
      status: z.enum(["succeeded", "partially_refunded", "refunded"]),
      refundedCents: z.number().int(),
      createdAt: z.string(),
    }),
    runningNetCents: z.number().int().describe("Net (charged minus refunded) through this row."),
  }),
  output: z.object({
    count: z.number().int().min(0),
    netCents: z.number().int().describe("Net of all payments: total charged minus total refunded."),
  }),
  scopes: ["payments:read"],
  async *handler() {
    let netCents = 0;
    let count = 0;
    for (const payment of await gateway.list()) {
      count += 1;
      netCents += payment.amountCents - payment.refundedCents;
      yield { payment, runningNetCents: netCents };
    }
    return { count, netCents };
  },
});
