import { createMcpServer } from "@facet/mcp";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { saasMcpContextFor } from "./host";
import { saasRegistry } from "./registry";

/**
 * The multi-tenant app projected onto MCP (stdio). The tenant comes from `SAAS_TOKEN` (default
 * `tok_acme_admin`) — a real MCP host would derive the workspace from the connection's authenticated identity;
 * here one server process serves one tenant, so an agent connected to it is sandboxed to that workspace, and
 * the chokepoint's confirmation gate still fires on `projects.create` / `projects.delete`.
 *
 * `createSaasMcpServer` returns the server unbound to a transport, so tests connect it to an in-memory
 * transport and drive it with the SDK `Client`; the entrypoint binds it to stdio for real play. Point an MCP
 * client at `bun run /absolute/path/to/examples/saas/mcp.ts` (any logging MUST go to stderr).
 */
export function createSaasMcpServer() {
  return createMcpServer(saasRegistry(), { contextFor: saasMcpContextFor() });
}

if (import.meta.main) {
  const server = createSaasMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("saas MCP surface listening on stdio (tools/list, tools/call)");
}
