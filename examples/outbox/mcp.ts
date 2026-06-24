import { createMcpServer } from "@facet/mcp";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { devMcpContextFor } from "./host";
import { outboxRegistry } from "./registry";

/**
 * The outbox app projected onto MCP (stdio) — the surface where an agent reaches the outside world. `email__send`
 * and `issues__open` carry a required `confirm` field (the propose→confirm handshake in the schema), so an agent
 * asked to email a customer must propose first and act only on confirmation. If a connector isn't wired, the
 * tool call returns a `connector_unavailable` error result rather than silently doing nothing.
 *
 * `createOutboxMcpServer` returns the server unbound to a transport (tests drive it with the SDK `Client`); the
 * entrypoint binds it to stdio. Point a client at `bun run /absolute/path/to/examples/outbox/mcp.ts` (logging to
 * stderr only).
 */
export function createOutboxMcpServer() {
  return createMcpServer(outboxRegistry(), { contextFor: devMcpContextFor() });
}

if (import.meta.main) {
  const server = createOutboxMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("outbox MCP surface listening on stdio (tools/list, tools/call)");
}
