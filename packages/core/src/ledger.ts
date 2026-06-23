/**
 * The idempotency Ledger port. A pure interface — no storage opinion — so `execute()` can dedupe a retried
 * write without importing a database. A host supplies an implementation (in-memory, Redis, a table…).
 *
 * CARVE NOTE: Moral Fabric's `Ledger` keyed on `(key, capabilityId, tenant)`. The `tenant` parameter is
 * gone — multi-tenancy is a host concern, so a multi-tenant host folds the tenant INTO the key it passes.
 * The framework's dedup contract is simply: for a given (key, capabilityId), `record` runs once with the
 * first result and every later `lookup` returns it.
 */
export interface Ledger {
  /** Return a previously recorded result for this (key, capabilityId), or `undefined`. */
  lookup(key: string, capabilityId: string): Promise<unknown>;
  /** Record the first run's result. Implementations should be insert-once (ignore duplicates). */
  record(key: string, capabilityId: string, result: unknown): Promise<void>;
}
