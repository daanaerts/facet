import { Registry } from "@facet/core";
import paymentsCharge from "./capabilities/payments.charge.cap";
import paymentsExport from "./capabilities/payments.export.cap";
import paymentsList from "./capabilities/payments.list.cap";
import paymentsRefund from "./capabilities/payments.refund.cap";

/**
 * The billing registry — the four capabilities every surface reads. The entrypoints (serve / cli / mcp), the
 * agent driver, and the tests all build from this one function, so a new `payments.*.cap.ts` lights up on every
 * surface the moment it is added here.
 */
export function billingRegistry(): Registry {
  const registry = new Registry();
  for (const def of [paymentsList, paymentsCharge, paymentsRefund, paymentsExport]) {
    registry.register(def);
  }
  return registry;
}
