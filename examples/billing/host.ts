import type { Actor, Ledger } from "@facet/core";
import type { HeaderRecord } from "@facet/http";
import type { ToolContext } from "@facet/mcp";
import type { AuthParts } from "@facet/surface-kit";

/**
 * The host seam — the billing app's contribution to the framework. Like the todo host it is spine-free (no
 * tenant: a refund app can be single-tenant), so the only thing each surface needs is "who is calling + what
 * may they do" (`actor` + `scopes`) and a shared idempotency `ledger` — and for MONEY the ledger is not
 * optional polish, it is the safety mechanism: it is what makes a double-submitted `payments.refund` replay the
 * first result instead of refunding twice. The atomic insert-once `claim` is the whole point.
 */

/** The scopes the dev principal is granted — enough to read and move money. The whole authz policy. */
export const DEV_SCOPES = ["payments:read", "payments:write"];

/** The default actor. Facet's primary consumer is the agent, so the demo's default principal is an `agent`. */
export const DEV_ACTOR: Actor = { kind: "agent", agentId: "billing-demo" };

/**
 * An in-memory idempotency Ledger — the port that makes money safe under retries. `claim` checks-and-sets with
 * no `await` between the read and the write, so a concurrent second `claim` for the same key cannot interleave
 * and always loses (in a single-threaded runtime the event loop IS the lock). A real adapter gets the same
 * atomicity from a DB `UNIQUE(key, capability_id)` constraint or Redis `SET NX` — swap it without touching a
 * capability or a surface. `#claimed` records who won the race; `#results` holds committed values for `read`.
 */
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

/** The HTTP seam: every request is the trusted dev principal, sharing ONE ledger (so a retry actually dedupes). */
export function devAuthenticate(): (headers: HeaderRecord) => AuthParts {
  const ledger = new MemoryLedger();
  return (_headers) => ({ actor: DEV_ACTOR, scopes: DEV_SCOPES, ledger });
}

/** The CLI seam — `runCli` hands it the `--actor`; it returns the payment scopes + one shared ledger. */
export function devCliContextFor(): (actor: Actor) => AuthParts {
  const ledger = new MemoryLedger();
  return (actor) => ({ actor, scopes: DEV_SCOPES, ledger });
}

/** The MCP seam — every tool call is the trusted dev principal with one shared ledger. */
export function devMcpContextFor(): (meta: ToolContext) => AuthParts {
  const ledger = new MemoryLedger();
  return (_meta) => ({ actor: DEV_ACTOR, scopes: DEV_SCOPES, ledger });
}

/** The agent seam — the in-process copilot; `dispatchToolCall` adds `surface: "agent"` + confirm/key. */
export function devAgentContextFor(): (id: string) => AuthParts {
  const ledger = new MemoryLedger();
  return (_id) => ({ actor: DEV_ACTOR, scopes: DEV_SCOPES, ledger });
}
