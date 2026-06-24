# saas — a multi-tenant app on Facet

A real, runnable **multi-tenant** "projects" app on `@facet/core`, projected onto **all four surfaces** — HTTP,
CLI, MCP, and the in-app agent — from **one** set of typed capabilities, with **zero per-surface code**. Where
[`examples/todo`](../todo) is deliberately spine-free, this example exists to demonstrate the **one** thing a
real SaaS adds: **tenancy**, carried the sanctioned way — through `ctx.claims`, not through the engine.

The engine still knows nothing about a workspace. Every capability pulls the tenant out of the Context with
`requireClaim<string>(ctx, "workspace")` and scopes its own data; the host folds the tenant *in* at the seam.
That split — **scopes drive authz, claims carry tenant/role** — is the whole lesson.

## What it teaches (the axis: `claims`)

| Concern | How it's done here |
|---|---|
| **Tenant isolation** | Every handler reads `requireClaim<string>(ctx, "workspace")` and scopes `store.*(workspace, …)`. Two tenants calling the same capability get disjoint data. |
| **Role-based authz** | `projects.delete` reads `claimOf<string>(ctx, "role")` and refuses non-admins — an authorization decision the coarse `projects:write` scope can't express. |
| **Per-tenant idempotency** | The host hands each request a `scopedLedger(sharedLedger, workspace)` (see [`ledger.ts`](./ledger.ts)), so two tenants' identical idempotency keys never replay across the boundary. |
| **The confirmation wedge** | `projects.create` (write) and `projects.delete` (destructive, `reversible: false`) are gated by the chokepoint. Ask an agent to delete a project → `confirmation_required`. |
| **A port with two adapters** | Auth is a seam: an in-memory token map (the default, hermetic) and a **real** HS256-JWT verifier built on Web Crypto — no deps, runs on Bun/Node/Deno (see [`auth.ts`](./auth.ts)). |

## The capabilities

| id | risk | reads claims | input | output |
|---|---|---|---|---|
| `projects.list` | read | `workspace` | `{}` | `{ projects: [...] }` (this workspace only) |
| `projects.create` | write (idempotent) | `workspace` | `{ name }` | the created project |
| `projects.delete` | destructive (`reversible: false`) | `workspace`, `role` | `{ id }` | `{ id, deleted: true }` — admins only; 404 across tenants |
| `projects.watch` | read (**streaming**) | `workspace` | `{}` | one chunk per project, then `{ count }` |

The store seeds two tenants so isolation is visible immediately: **acme** owns `proj_1`/`proj_2`, **globex**
owns `proj_3`. Three dev tokens span both tenants and both roles: `tok_acme_admin`, `tok_acme_member`,
`tok_globex_admin`.

## The tenancy seam, in one picture

```
Authorization: Bearer tok_acme_admin           ← the transport carries an opaque token
        │
   authenticator(token) → Principal            ← auth.ts: in-memory map OR real JWT verify
        │
   partsFor(principal) → AuthParts             ← scopes=[projects:*]  claims={workspace,role}  ledger=scoped
        │
   contextFromParts(...) → Context             ← the surface adds surface/confirm/key; engine sees only this
        │
   handler: requireClaim(ctx,"workspace")      ← the tenant is read here, and nowhere in the engine
```

## HTTP — `serve.ts`

The tenant rides in the `Authorization: Bearer <token>` header; no header falls back to the dev tenant (acme).

```bash
bun run examples/saas/serve.ts     # port 3003 (override with PORT)
```

```bash
curl localhost:3003/cap                                              # the catalogue (four capabilities)

# the SAME read, two tenants → two different result sets
curl -X POST localhost:3003/cap/projects.list -d '{}' \
  -H 'content-type: application/json'                                # acme (the dev default)
curl -X POST localhost:3003/cap/projects.list -d '{}' \
  -H 'content-type: application/json' -H 'authorization: Bearer tok_globex_admin'

# destructive WITHOUT confirm → 409 confirmation_required (the wedge)
curl -i -X POST localhost:3003/cap/projects.delete -d '{"id":"proj_1"}' \
  -H 'content-type: application/json'

# admin + confirm → deleted; but try to cross tenants and it's a clean 404
curl -X POST localhost:3003/cap/projects.delete -d '{"id":"proj_1"}' \
  -H 'content-type: application/json' -H 'x-facet-confirm: true'
curl -i -X POST localhost:3003/cap/projects.delete -d '{"id":"proj_3"}' \
  -H 'content-type: application/json' -H 'x-facet-confirm: true' \
  -H 'authorization: Bearer tok_acme_admin'                         # proj_3 is globex's → 404 not_found
```

### Streaming over HTTP — `projects.watch` as SSE

```bash
curl -N -X POST localhost:3003/cap/projects.watch -d '{}' \
  -H 'content-type: application/json' -H 'accept: text/event-stream'
```

## CLI — `cli.ts`

The tenant comes from `SAAS_TOKEN` (default `tok_acme_admin`).

```bash
bun run examples/saas/cli.ts ls
bun run examples/saas/cli.ts projects.list                                  # acme's projects
SAAS_TOKEN=tok_globex_admin bun run examples/saas/cli.ts projects.list      # globex's — a different set

bun run examples/saas/cli.ts projects.create --json '{"name":"New thing"}'        # ✗ confirmation_required
bun run examples/saas/cli.ts projects.create --json '{"name":"New thing"}' --yes  # runs

bun run examples/saas/cli.ts projects.delete --json '{"id":"proj_1"}' --yes       # admin → deleted
SAAS_TOKEN=tok_acme_member bun run examples/saas/cli.ts projects.delete --json '{"id":"proj_1"}' --yes
                                                                                  # ✗ forbidden (not an admin)
```

## MCP — `mcp.ts`

A stdio MCP server, one tool per capability. The tenant comes from `SAAS_TOKEN`; one server process serves one
tenant, so an agent connected to it is sandboxed to that workspace.

```jsonc
// e.g. an MCP client config
{ "command": "bun", "args": ["run", "/ABSOLUTE/PATH/examples/saas/mcp.ts"], "env": { "SAAS_TOKEN": "tok_acme_admin" } }
```

`projects__create` and `projects__delete` carry a required `confirm` field (the propose→confirm handshake in
the schema); `projects__delete` is annotated `destructiveHint`. Call `projects__delete` with `{ "id": "proj_1" }`
→ `confirmation_required`; re-call with `confirm: true` → it runs (if you're an admin).

## Going to a real auth provider

The default authenticator is an in-memory token map — perfect for `bun run` and the test suite, never shipped.
The real adapter ships alongside it: `jwtAuthenticator(secret)` in [`auth.ts`](./auth.ts) verifies an HS256 JWT
with Web Crypto (no dependency, no network) and reads `workspace`/`role` from its claims. Flip to it in one line
in `serve.ts`:

```ts
import { jwtAuthenticator } from "./auth";
createFetchHandler(saasRegistry(), {
  authenticate: saasAuthenticate({ auth: jwtAuthenticator(process.env.SAAS_JWT_SECRET!) }),
});
```

A production host points the verify step at its provider (Clerk / Auth0 / WorkOS / a JWKS endpoint) instead —
the `Authenticator` shape, and everything downstream of it, is identical. The store likewise stays in-memory
here; a real host swaps it for Postgres with a `workspace_id` column behind the same `store.*(workspace, …)` API.

## Tests

```bash
bun test examples/saas
```

- `tests/headless.test.ts` — the chokepoint with a **bare** Context: read isolation, the loud `unauthorized`
  on a missing claim, confirmation gating, **workspace-scoped idempotency** (same key, two tenants, no
  cross-replay), the admin-only role gate, the cross-tenant `not_found`, and the **real JWT adapter** round-trip.
- `tests/parity.test.ts` — cross-surface parity via `@facet/parity`, with the `acme` tenant threaded through
  every leg: `projects.create` returns the **same** tenant-stamped output via execute · agent · cli · http ·
  mcp, and all five refuse an unconfirmed write with the **same** `confirmation_required` code.
