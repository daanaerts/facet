import { createMcpServer } from "@facet/mcp";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { devMcpContextFor } from "./host";
import { todoRegistry } from "./registry";

/**
 * The todo app projected onto MCP. It reuses the same registry every other surface builds (`todoRegistry`)
 * and the host's `devMcpContextFor` seam. `createTodoMcpServer` returns the server unbound to a transport, so
 * tests connect it to an in-memory transport pair and drive it with the SDK `Client`; the entrypoint below
 * binds it to stdio for real play.
 *
 * A stdio server is exactly what an MCP client (Claude Desktop, the SDK `Client`, an agent host) launches and
 * speaks JSON-RPC to over stdin/stdout — so this file is the real entry an external agent connects to. All
 * chatter is on stdin/stdout, so any logging MUST go to stderr.
 *
 * Point an MCP client at `bun run /absolute/path/to/examples/todo/mcp.ts`:
 *   - tools/list shows todos.list / todos.watch as `todos__list` / `todos__watch` (dots → `__`), and
 *     todos.add / todos.complete / todos.remove as write/destructive tools carrying a required `confirm` field.
 *   - call `todos__list` with {} → structuredContent with the todos.
 *   - call `todos__add` with { "title": "ship it" } → confirmation_required; re-call with `confirm: true`.
 */
export function createTodoMcpServer() {
  return createMcpServer(todoRegistry(), { contextFor: devMcpContextFor() });
}

if (import.meta.main) {
  const server = createTodoMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("todo MCP surface listening on stdio (tools/list, tools/call)");
}
