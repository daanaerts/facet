/**
 * The idempotency Ledger port — atomic insert-once. A pure interface, no storage opinion, so `execute()` can
 * dedupe a write without importing a database. A host supplies an implementation (in-memory, Redis, a table…).
 *
 * WHY `claim`/`commit` AND NOT `lookup`/`record`: the old shape did `lookup → handler → record` as three
 * separate awaits. Between the `lookup` (miss) and the `record`, a SECOND call carrying the same key could
 * also miss and also run the handler — both writes execute, defeating idempotency under concurrent
 * double-submit (it only protected sequential retries). The fix is to make claiming the key the FIRST,
 * ATOMIC step: exactly one caller can win the insert.
 *
 *   claim(key, capabilityId)  → "won"  : you inserted the marker first; YOU run the handler and `commit`.
 *                              → "lost" : someone else already claimed this key; do NOT run — `read` theirs.
 *   commit(key, capabilityId, result)  : the winner stores its validated result against the claim.
 *   read(key, capabilityId)            : fetch a committed result, or `undefined` if none is committed yet.
 *
 * A real adapter backs `claim` with a primitive that is atomic AT THE STORE: a Postgres/MySQL `INSERT` on a
 * `UNIQUE(key, capability_id)` column (unique-violation ⇒ "lost"), or Redis `SET key val NX` (`null` reply ⇒
 * "lost"). That single atomic insert is the whole correctness guarantee — the engine never needs a lock.
 *
 * RACE BETWEEN claim AND commit: a winner is briefly "claimed but not yet committed" while its handler runs.
 * A loser that `read`s in that window sees `undefined`. The engine's documented behavior is the simple one —
 * a loser reads ONCE and, if the result is not committed yet, returns `not_committed` to the caller (a retry
 * with the same key then replays the committed value); the engine does not block waiting on the winner. An
 * adapter MAY offer a blocking/awaiting `read` (e.g. poll the row), but the port does not require it.
 *
 * CARVE NOTE: Moral Fabric's ledger keyed on `(key, capabilityId, tenant)`. The `tenant` parameter is gone —
 * multi-tenancy is a host concern, so a multi-tenant host folds the tenant INTO the `key` it passes. The
 * framework's dedup contract is simply: for a given `(key, capabilityId)`, exactly one caller `claim`s "won"
 * and runs the handler; every other caller is a loser that `read`s the committed result.
 */
export interface Ledger {
  /**
   * Atomically claim `(key, capabilityId)`. Returns `"won"` for the first caller (insert succeeded — it must
   * run the handler and `commit`), `"lost"` for every subsequent caller (the key already exists — it must not
   * run, and should `read` the committed result instead). MUST be atomic insert-once at the store.
   */
  claim(key: string, capabilityId: string): Promise<"won" | "lost">;
  /** Store the winner's result against an existing claim. Called once, by the caller that `claim`ed "won". */
  commit(key: string, capabilityId: string, result: unknown): Promise<void>;
  /** Return the committed result for `(key, capabilityId)`, or `undefined` if not committed yet. */
  read(key: string, capabilityId: string): Promise<unknown>;
}
