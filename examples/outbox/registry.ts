import { Registry } from "@facet/core";
import emailSend from "./capabilities/email.send.cap";
import issuesOpen from "./capabilities/issues.open.cap";
import messagesList from "./capabilities/messages.list.cap";
import outboxTail from "./capabilities/outbox.tail.cap";

/**
 * The outbox registry — the four capabilities every surface reads. The entrypoints (serve / cli / mcp), the
 * agent driver, and the tests all build from this one function, so a new `*.cap.ts` lights up on every surface
 * the moment it is added here.
 */
export function outboxRegistry(): Registry {
  const registry = new Registry();
  for (const def of [messagesList, emailSend, issuesOpen, outboxTail]) {
    registry.register(def);
  }
  return registry;
}
