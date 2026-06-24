import type { SQL } from "drizzle-orm";

/**
 * The MINIMAL structural shape `@facet/postgres` needs from a Drizzle Postgres database — exactly two verbs:
 * run a parameterized statement, and open a transaction. Every `drizzle()` server flavor (node-postgres,
 * postgres.js, …) satisfies it structurally, so a host passes its OWN `db` and this package never pins a
 * specific Drizzle generic — a Drizzle minor bump cannot break these types, and there is nothing to keep in
 * sync with the adopter's client.
 *
 * `execute` is always handed a Drizzle `SQL` built with the `sql` tag, so every value (`key`, `capabilityId`,
 * a JSON result, a GUC value) is a BOUND PARAMETER — never string-concatenated. The result is normalized
 * internally (`rowsOf` in `ledger.ts`) across the flavors' two return shapes (`{ rows }` vs a plain array),
 * so a caller never sees the difference.
 *
 * If a particular Drizzle flavor's type does not structurally assign here, pass it through once at the call
 * site (`db as unknown as FacetPgDatabase`); the runtime shape is identical across the server drivers.
 */
export interface FacetPgDatabase {
  execute(query: SQL): Promise<unknown>;
  transaction<T>(fn: (tx: FacetPgDatabase) => Promise<T>): Promise<T>;
}
