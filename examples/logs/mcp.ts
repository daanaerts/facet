import type { Actor } from "@facet/core";
import { type ContextFor, createMcpServer } from "@facet/mcp";
import type { AuthParts } from "@facet/surface-kit";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { MemoryLedger } from "./host";
import { logsRegistry } from "./http";

/**
 * The `logs` domain projected onto MCP — the example host's whole MCP contribution. It reuses the SAME
 * registry the HTTP example builds (`logsRegistry`) and supplies a DEV `contextFor`: this is the seam where
 * a real app would verify the calling agent's credentials and decide scopes, but for the demo every call is
 * a single trusted dev user with a fixed scope grant. Nothing framework-specific leaks in — the host decides
 * what auth and scopes mean, and folds nothing tenant-shaped into the surface because this domain has no
 * tenants. It is the MCP twin of `http.ts`'s `devAuthenticate`; only the surface label differs.
 */

/** The dev user every tool call acts as. A real host would derive this from the agent's verified identity. */
const DEV_ACTOR: Actor = { kind: "user", id: "dev@example.com", email: "dev@example.com" };

/** The scopes the dev user is granted — enough to read logs and read/write jobs. */
const DEV_SCOPES = ["logs:read", "jobs:read", "jobs:write"];

/**
 * A dev `contextFor` — the shared {@link AuthParts} seam. Every tool call is the same trusted dev user,
 * granted the logs/jobs scopes, with one in-memory idempotency ledger (created ONCE here, closed over) so a
 * retried `jobs.start` carrying the same `idempotencyKey` dedupes. The SURFACE reads `confirm`/`idempotencyKey`
 * off the tool arguments and builds the Context (`surface: "mcp"`); the host returns only "who + what may they
 * do". A real host swaps this for real authentication; the surface does not change.
 */
export function devContextFor(): ContextFor {
  const ledger = new MemoryLedger();
  return (): AuthParts => ({ actor: DEV_ACTOR, scopes: DEV_SCOPES, ledger });
}

/** The built `logs` MCP server: the registry projected onto MCP behind the dev `contextFor`. */
export function createLogsMcpServer() {
  return createMcpServer(logsRegistry(), { contextFor: devContextFor() });
}

/**
 * Serve the `logs` MCP server over stdio for human play (`bun run examples/logs/mcp.ts`). A stdio server is
 * exactly what an MCP client (Claude Desktop, the SDK `Client`, an agent host) launches and speaks JSON-RPC
 * to over the process's stdin/stdout — so this file is the real entry an external agent connects to, the MCP
 * twin of `serve.ts`'s HTTP listener. All chatter is on stdin/stdout, so any logging MUST go to stderr.
 *
 * Try it from an MCP client pointed at `bun run /absolute/path/to/examples/logs/mcp.ts`:
 *   - tools/list shows logs.tail / jobs.list as `logs__tail` / `jobs__list` (dots → `__`), and jobs.start /
 *     jobs.cancel as write/destructive tools carrying a required `confirm` field.
 *   - call `logs__tail` with { "source": "build" } → structuredContent with the log lines.
 *   - call `jobs__start` with { "name": "nightly" } → confirmation_required; re-call with `confirm: true`.
 */
if (import.meta.main) {
  const server = createLogsMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("logs MCP surface listening on stdio (tools/list, tools/call)");
}
