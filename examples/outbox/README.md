# outbox — external connectors on Facet

A real, runnable app that reaches the **outside world** — sends email, opens GitHub issues — on `@facet/core`,
projected onto **all four surfaces** from **one** set of typed capabilities, with **zero per-surface code**.
Where `examples/saas` is about tenancy and `examples/billing` is about money, this example is about the
**`ctx.connector` port**: how a Facet handler reaches an external system, and how a *missing* connector fails
loudly as `connector_unavailable` instead of silently doing nothing.

> **Dogfooding note.** Building this example surfaced — and fixed — a real gap in the library. `Context.connector`
> was documented but only half-wired: `buildContext`/`AuthParts`/`contextFromParts` never threaded it, so
> `ctx.connector` was always `undefined` through every surface (the asymmetric sibling of `ctx.ledger`). The fix
> was the minimal completion — `connector` is now an optional field on `BuildContextOpts` and `AuthParts`,
> carried onto the Context by `contextFromParts`, exactly like `ledger`. This example is the proof it works.

## What it teaches (the axis: the `connector` port)

| Concern | How it's done here |
|---|---|
| **Reaching external systems** | Handlers call `useConnector<EmailConnector>(ctx, "email")` — resolving the connector off `ctx.connector`, never importing a provider. The host decides which connectors exist and (in prod) binds them to the caller. |
| **Loud failure, never silent** | A connector that isn't wired — the port absent, or an unknown id — throws `ConnectorUnavailableError` (`connector_unavailable`), translated natively by each surface (HTTP 501, MCP `isError`, CLI `✗`). |
| **One port, many providers** | `email.send` uses `"email"`, `issues.open` uses `"github"` — the same port, two connectors, two reversibility postures. |
| **A port with two adapters** | In-memory connectors (the default, tested) and **real** Resend + GitHub clients over `fetch` (see [`connectors.ts`](./connectors.ts)). |
| **The wedge** | Both writes are confirmation-gated. Ask an agent to email a customer → `confirmation_required` until the surface confirms. |

## The capabilities

| id | risk | reversible | connector | input | output |
|---|---|---|---|---|---|
| `messages.list` | read | — | — | `{}` | `{ messages: [...] }` |
| `email.send` | write | **false** (can't un-send) | `"email"` | `{ to, subject, body }` | the outbox entry |
| `issues.open` | write | **true** (can be closed) | `"github"` | `{ repo, title, body }` | the outbox entry |
| `outbox.tail` | read (**streaming**) | — | — | `{}` | one chunk per entry, then `{ count }` |

The outbox log seeds one entry (`out_1`) so `messages.list` shows something immediately.

## HTTP — `serve.ts`

```bash
bun run examples/outbox/serve.ts     # port 3005 (override with PORT)
```

```bash
curl localhost:3005/cap
curl -X POST localhost:3005/cap/messages.list -d '{}' -H 'content-type: application/json'

# a send WITHOUT confirm → 409 confirmation_required (the wedge)
curl -i -X POST localhost:3005/cap/email.send \
  -d '{"to":"cust@acme.example","subject":"Hi","body":"Hello"}' \
  -H 'content-type: application/json'

# confirmed → sent (provider: memory in dev)
curl -X POST localhost:3005/cap/email.send \
  -d '{"to":"cust@acme.example","subject":"Hi","body":"Hello"}' \
  -H 'content-type: application/json' -H 'x-facet-confirm: true'
```

## CLI — `cli.ts`

```bash
bun run examples/outbox/cli.ts messages.list
bun run examples/outbox/cli.ts email.send --json '{"to":"a@b.com","subject":"Hi","body":"Yo"}'        # ✗ confirmation_required
bun run examples/outbox/cli.ts email.send --json '{"to":"a@b.com","subject":"Hi","body":"Yo"}' --yes  # sent
bun run examples/outbox/cli.ts issues.open --json '{"repo":"acme/app","title":"Bug","body":"…"}' --yes
bun run examples/outbox/cli.ts outbox.tail
```

## MCP — `mcp.ts`

A stdio MCP server. `email__send` / `issues__open` carry a required `confirm` field. If a connector isn't wired,
the tool call returns a `connector_unavailable` error result — the agent gets a clear, typed reason, not silence.

## Going to real providers

The default connectors are in-memory — perfect for `bun run` and the test suite, never shipped. The real
adapters ship alongside them: `resendEmail(apiKey, from)` and `githubIssues(token)` in
[`connectors.ts`](./connectors.ts) are genuine `fetch` clients. Wire them into the host's connector resolver
(`devConnectors` in [`host.ts`](./host.ts)) keyed by id, and the same handlers deliver for real:

```ts
// host.ts — swap devConnectors() for a resolver that returns the real clients
const email = resendEmail(process.env.RESEND_API_KEY!, "noreply@acme.example");
const github = githubIssues(process.env.GITHUB_TOKEN!);
const connector = <T>(id: string): T => {
  if (id === "email") return email as T;
  if (id === "github") return github as T;
  throw new ConnectorUnavailableError(id, `no connector registered for "${id}"`);
};
```

They require API keys and a network, so — unlike the in-memory adapters — they are **not** exercised by the
test suite. A network failure surfaces as `connector_unavailable`; a provider 4xx as the matching FacetError.

## Tests

```bash
bun test examples/outbox
```

- `tests/headless.test.ts` — the chokepoint with a **bare** Context: read, the per-capability `risk`/`reversible`
  metadata, the send wedge + delivery through the wired connector, **`connector_unavailable` when no port is
  wired** and when an unknown id is asked for, `issues.open` through a second connector, idempotent send (no
  double send), and the streaming tail.
- `tests/parity.test.ts` — cross-surface parity via `@facet/parity`: a confirmed `email.send` returns the
  **same** outbox entry via execute · agent · cli · http · mcp, and all five refuse an unconfirmed send with the
  **same** `confirmation_required` code — proving the newly-threaded `connector` port projects identically
  across every surface.
