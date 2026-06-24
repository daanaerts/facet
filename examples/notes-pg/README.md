# notes-pg — multi-tenant notes on Postgres

A worked end-to-end example of [`@facet/postgres`](../../packages/postgres): **RLS tenant isolation** (via
`withClaims`) + **idempotency** (via `PgLedger`), driven through Facet's real `execute()` chokepoint. It's the
Postgres sibling of the `todo` (SQLite) demo — same shape, but multi-workspace and RLS-backed.

## What it shows

- **One capability, two result sets.** `notes.list` carries no tenant `WHERE` clause; the RLS policy scopes
  rows to the caller's `workspace`. `ws_a` and `ws_b` call the exact same capability and see only their own
  notes. Forgetting the tenant filter is structurally impossible.
- **Authorization stays in the chokepoint.** `execute()` checks the *verb* scope (`notes:read`/`notes:write`);
  RLS only adds *row* visibility underneath. Two independent layers.
- **Idempotency that respects tenancy.** A retried `notes.add` with the same key replays the first note. The
  host namespaces the ledger key by workspace, so the *same* key in a *different* workspace never cross-replays.
- **Persistence is the host's.** The framework imports none of this; `db.ts`/`store.ts` own the SQL, the role,
  and the policy — swap them for node-postgres or raw SQL with no change to a capability.

## Run it

```sh
docker compose up -d   # from the repo root — throwaway Postgres on localhost:5433
NOTES_PG_URL=postgres://facet:facet@localhost:5433/facet bun run examples/notes-pg/run.ts
docker compose down -v
```

Expected: `ws_a` sees its two notes, `ws_b` sees its one, and the idempotent add replays a single row.

## The headless tests

`tests/headless.test.ts` proves the same through the chokepoint. They're gated on `FACET_TEST_DATABASE_URL`
and skip when it's unset, so a bare `bun test` needs no database:

```sh
docker compose up -d && bun run test:pg   # from the repo root
```

## Files

| File | Role |
|---|---|
| `schema.ts` | the `notes` Drizzle table + a re-export of `facetIdempotency` (the fold-into-your-schema pattern) |
| `db.ts` | lazy connection + idempotent `setup()` (tables, `notes_app` role, RLS policy) |
| `store.ts` | `withClaims`-wrapped queries — no tenant `WHERE`, RLS supplies it |
| `host.ts` | the host seam: per-workspace Context + a workspace-namespaced `PgLedger` |
| `capabilities/` | `notes.add` (write, idempotent), `notes.list` (read) |
| `run.ts` | the runnable demo |
