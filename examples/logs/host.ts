import type { Actor, Context, Ledger, SurfaceKind } from "@facet/core";
import { ScopeError } from "@facet/core";

/**
 * The host's entire contribution to the framework: turn "who is calling + what they confirmed" into a
 * Context, and (optionally) implement the idempotency Ledger. For an in-memory demo the spine is THIS small
 * — ~40 lines, and not one framework concept leaks in. This is the "you bring the spine" claim made real:
 * the framework asks for a Context; the host decides what authentication, scopes, and tenancy mean.
 */

/**
 * An in-memory idempotency ledger — the only port this host bothers to implement. No tenant, no db.
 *
 * Atomic insert-once is FREE in a single-threaded runtime: `claim` checks-and-sets the marker with no `await`
 * in between, so the JS event loop cannot interleave a second `claim` mid-check — exactly one caller observes
 * the key absent and wins. A real adapter gets the same guarantee from a DB `UNIQUE` constraint / Redis
 * `SET NX`; here the event loop IS the lock. `#claimed` tracks won-but-maybe-uncommitted keys; `#results`
 * holds committed values (and is the source for `read`).
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
