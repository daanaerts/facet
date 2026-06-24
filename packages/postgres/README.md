# @facet/postgres

The opt-in Postgres adapter for Facet. Two small, independent things — and **`@facet/core` never imports
this package** (a tripwire enforces it: `tests/postgres-boundary.test.ts`).

1. **`PgLedger`** — a production [`Ledger`](../core/src/ledger.ts) for Facet's idempotency dedup. One atomic
   `INSERT … ON CONFLICT DO NOTHING` against a single table; the unique primary key is the whole correctness
   guarantee, so the engine never needs a lock.
2. **`withClaims`** — a claims→RLS bridge. It runs your work in a transaction that has adopted the caller's
   role and pushed `ctx.claims` into Postgres GUCs, so your Row-Level Security policies fire. This is
   defense-in-depth **under** Facet's chokepoint — `execute()` still authorizes the *verb*; RLS only adds
   *row* visibility.

It's **Drizzle-native**: you pass your own `drizzle()` db (`drizzle-orm` is a peer dependency you already
have). Nothing here is an ORM, a query builder, a migration runner, or a permissions engine — your domain
tables and migrations stay entirely yours.

## Install

```sh
npm i @facet/postgres   # drizzle-orm is a peer dep you already have
```

## The one table

`PgLedger` needs `facet_idempotency`. If you use drizzle-kit, fold the table object into your schema and let
your normal migration pipeline create it:

```ts
export { facetIdempotency } from "@facet/postgres/schema";
```

Otherwise apply the shipped [`migrations/0001_facet_idempotency.sql`](./migrations/0001_facet_idempotency.sql).

## Idempotency

```ts
import { PgLedger } from "@facet/postgres";
import { buildContext } from "@facet/core";

const ledger = new PgLedger(db); // your Drizzle db

const ctx = buildContext({
  actor,
  scopes,
  surface: "agent",
  confirm: true,
  idempotencyKey: req.headers["idempotency-key"],
  ledger, // a retry with the same key replays instead of re-running the write
});
```

## RLS (defense-in-depth)

Connect/work as a **non-owner** role (owners and superusers bypass RLS), and declare a policy that reads a
GUC:

```sql
ALTER TABLE todos ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON todos
  USING (workspace_id = current_setting('facet.workspace_id')::uuid);
```

Then bridge the caller's claims into that GUC inside your store:

```ts
import { withClaims } from "@facet/postgres";

const store = {
  list: (ctx) =>
    withClaims(
      db,
      ctx,
      { role: "facet_app", settings: { workspaceId: "facet.workspace_id" } },
      (tx) => tx.execute(sql`SELECT * FROM todos ORDER BY n`),
      //                   ^ no WHERE workspace_id — the policy adds it; forgetting it is now impossible
    ),
};
```

`SET LOCAL ROLE` and `set_config(_, _, true)` are transaction-scoped, so the adopted identity is released at
COMMIT/ROLLBACK and never leaks across a transaction pooler (PgBouncer).

## Testing against a live Postgres

The unit tests (`tests/ledger.test.ts`, `tests/rls.test.ts`) run with no database. The **live** tests
(`tests/integration.pg.test.ts` — atomic-claim race + real RLS enforcement) and the
[`notes-pg`](../../examples/notes-pg) example are gated on `FACET_TEST_DATABASE_URL` and skip when it's unset,
so `bun test` stays green with no services. A throwaway Postgres is one command (repo-root `docker-compose.yml`):

```sh
docker compose up -d   # Postgres on localhost:5433
bun run test:pg        # runs the suite with the live PG tests active
docker compose down -v
```

`FACET_TEST_DATABASE_URL` is a dedicated opt-in var (not the ambient `DATABASE_URL`) and the live tests
DROP/CREATE their fixtures — point it only at a throwaway database.

A worked, end-to-end multi-tenant example lives in [`examples/notes-pg`](../../examples/notes-pg).

## What this is not

- **Not an ORM / query builder** — you bring Drizzle (or raw SQL). It never models your `users`.
- **Not a permissions engine** — `withClaims` carries claims to the DB; it never *decides* anything.
  Authorization lives in the capability's `scopes`, checked once in `execute()`.
- **Not a migration runner** — one table + a recipe; your migrations stay yours.
