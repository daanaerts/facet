import { createMcpServer } from "@facet/mcp";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { devMcpContextFor } from "./host";
import { billingRegistry } from "./registry";

/**
 * The billing app projected onto MCP (stdio) — the surface where the wedge matters most, because the caller is
 * an agent. `payments__charge` and `payments__refund` carry a required `confirm` field (the propose→confirm
 * handshake modelled in the schema); `payments__refund` is annotated `destructiveHint` with `reversibleHint:
 * false`, so a careful agent driver knows the refund is permanent before it ever proposes it.
 *
 * `createBillingMcpServer` returns the server unbound to a transport (tests drive it with the SDK `Client` over
 * an in-memory transport); the entrypoint binds it to stdio. Point a client at
 * `bun run /absolute/path/to/examples/billing/mcp.ts` (any logging MUST go to stderr).
 */
export function createBillingMcpServer() {
  return createMcpServer(billingRegistry(), { contextFor: devMcpContextFor() });
}

if (import.meta.main) {
  const server = createBillingMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("billing MCP surface listening on stdio (tools/list, tools/call)");
}
