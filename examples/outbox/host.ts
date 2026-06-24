import type { Actor, Ledger } from "@facet/core";
import type { HeaderRecord } from "@facet/http";
import type { ToolContext } from "@facet/mcp";
import type { AuthParts } from "@facet/surface-kit";
import { devConnectors } from "./connectors";

/**
 * The host seam — the outbox app's contribution to the framework. Beyond the usual `actor` + `scopes` + a
 * shared idempotency `ledger`, this host wires the ONE thing this example is about: a `connector` resolver onto
 * the {@link AuthParts}, which `contextFromParts` carries onto `ctx.connector`. The handlers reach external
 * systems through that port; the host decides which connectors exist (and, in a real app, binds them to the
 * caller's credentials). The framework still learns nothing about email or GitHub — `connector` is opaque to it.
 */

export const DEV_SCOPES = ["outbox:read", "outbox:send"];
export const DEV_ACTOR: Actor = { kind: "agent", agentId: "outbox-demo" };

/** An in-memory idempotency Ledger — so a retried `email.send` carrying the same key never sends twice. */
export class MemoryLedger implements Ledger {
  #claimed = new Set<string>();
  #results = new Map<string, unknown>();
  #key(key: string, capabilityId: string): string {
    return `${capabilityId}::${key}`;
  }
  async claim(key: string, capabilityId: string): Promise<"won" | "lost"> {
    const k = this.#key(key, capabilityId);
    if (this.#claimed.has(k)) return "lost";
    this.#claimed.add(k);
    return "won";
  }
  async commit(key: string, capabilityId: string, result: unknown): Promise<void> {
    this.#results.set(this.#key(key, capabilityId), result);
  }
  async read(key: string, capabilityId: string): Promise<unknown> {
    return this.#results.get(this.#key(key, capabilityId));
  }
}

/** Each seam returns the same shared parts — now including the `connector` port the handlers resolve. */
export function devAuthenticate(): (headers: HeaderRecord) => AuthParts {
  const ledger = new MemoryLedger();
  const connector = devConnectors();
  return (_headers) => ({ actor: DEV_ACTOR, scopes: DEV_SCOPES, ledger, connector });
}

export function devCliContextFor(): (actor: Actor) => AuthParts {
  const ledger = new MemoryLedger();
  const connector = devConnectors();
  return (actor) => ({ actor, scopes: DEV_SCOPES, ledger, connector });
}

export function devMcpContextFor(): (meta: ToolContext) => AuthParts {
  const ledger = new MemoryLedger();
  const connector = devConnectors();
  return (_meta) => ({ actor: DEV_ACTOR, scopes: DEV_SCOPES, ledger, connector });
}

export function devAgentContextFor(): (id: string) => AuthParts {
  const ledger = new MemoryLedger();
  const connector = devConnectors();
  return (_id) => ({ actor: DEV_ACTOR, scopes: DEV_SCOPES, ledger, connector });
}
