import type { Actor, Context, Ledger, SurfaceKind } from "@facet/core";
import { ScopeError } from "@facet/core";

/**
 * The host's entire contribution to the framework: turn "who is calling + what they confirmed" into a
 * Context, and (optionally) implement the idempotency Ledger. For an in-memory demo the spine is THIS small
 * — ~40 lines, and not one framework concept leaks in. This is the "you bring the spine" claim made real:
 * the framework asks for a Context; the host decides what authentication, scopes, and tenancy mean.
 */

/** An in-memory idempotency ledger — the only port this host bothers to implement. No tenant, no db. */
export class MemoryLedger implements Ledger {
  #store = new Map<string, unknown>();
  #key(key: string, capabilityId: string): string {
    return `${capabilityId}::${key}`;
  }
  async lookup(key: string, capabilityId: string): Promise<unknown> {
    return this.#store.get(this.#key(key, capabilityId));
  }
  async record(key: string, capabilityId: string, result: unknown): Promise<void> {
    const k = this.#key(key, capabilityId);
    if (!this.#store.has(k)) this.#store.set(k, result);
  }
}

export interface MakeContextOpts {
  actor?: Actor;
  surface?: SurfaceKind;
  scopes?: string[];
  confirm?: boolean;
  idempotencyKey?: string;
  ledger?: Ledger;
  audit?: (event: string, data?: unknown) => void;
}

/**
 * Build a Context. The default actor is an `agent` on the `agent` surface — Facet's primary consumer — so
 * the cheapest call in the demo is the agent path, and the human surfaces are the ones that add ceremony.
 */
export function makeContext(opts: MakeContextOpts = {}): Context {
  const scopes = opts.scopes ?? [];
  return {
    actor: opts.actor ?? { kind: "agent", agentId: "demo" },
    surface: opts.surface ?? "agent",
    scopes,
    confirm: opts.confirm ?? false,
    idempotencyKey: opts.idempotencyKey,
    ledger: opts.ledger,
    requireScope(scope: string): void {
      if (!scopes.includes(scope) && !scopes.includes("*")) throw new ScopeError(scope);
    },
    audit: opts.audit ?? (() => {}),
  };
}
