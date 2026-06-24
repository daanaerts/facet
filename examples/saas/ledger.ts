import type { Ledger } from "@facet/core";

/**
 * The idempotency ledger for the multi-tenant app — and the reason a tenant needs MORE than the bare
 * `MemoryLedger` the single-tenant examples use. Two different workspaces can legitimately submit the SAME
 * idempotency key (`"k1"`) for the same capability; if both hit one flat ledger, the second tenant's write
 * would replay the FIRST tenant's stored result — a cross-tenant data leak through the dedup path. So the host
 * hands each request a {@link scopedLedger} that namespaces the key by workspace before it ever reaches the
 * shared store. This is the `scopedLedger(sharedLedger, workspaceId)` line from `docs/quickstart.md`, made real.
 */

/**
 * The process-wide insert-once store. Atomic claim is free in a single-threaded runtime: `claim` checks and
 * sets with no `await` between, so a concurrent second claim for the same key cannot interleave and always
 * loses. A real adapter gets the same guarantee from a DB `UNIQUE(key, capability_id)` constraint or Redis
 * `SET NX`. There is ONE of these per process; per-tenant isolation comes from {@link scopedLedger} above it.
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

/** The single shared ledger every request's scoped view sits on top of. */
export const sharedLedger = new MemoryLedger();

/**
 * A per-workspace VIEW of a base ledger: it prefixes every key with `"<workspace>::"` before delegating, so
 * two tenants' identical keys land on distinct rows and never replay across the tenant boundary. The framework
 * sees a plain `Ledger`; the namespacing is entirely the host's, folded in at the seam — the engine still
 * never learns what a workspace is.
 */
export function scopedLedger(base: Ledger, workspace: string): Ledger {
  const scope = (key: string): string => `${workspace}::${key}`;
  return {
    claim: (key, capabilityId) => base.claim(scope(key), capabilityId),
    commit: (key, capabilityId, result) => base.commit(scope(key), capabilityId, result),
    read: (key, capabilityId) => base.read(scope(key), capabilityId),
  };
}
