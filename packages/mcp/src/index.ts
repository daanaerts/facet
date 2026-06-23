/**
 * @facet/mcp — the MCP surface. Generic over a Registry: each capability projects onto one MCP tool, with
 * the `confirm` + `idempotencyKey` fields MERGED into the tool input schema. The surface establishes a
 * Context via a host-supplied `contextFor` and translates the FacetError family into `isError` tool results.
 *
 * One tool per capability that declares the `mcp` surface; the dotted capability id is mapped to an
 * Anthropic-regex-safe wire name (dots → `__`) and round-trips back on dispatch. The surface validates
 * nothing and authorizes nothing — that all lives in `@facet/core` `execute()`.
 */
export {
  type ContextFor,
  createMcpServer,
  dispatchTool,
  type McpOptions,
  mcpTools,
  type ToolContext,
  type ToolProgress,
} from "./server";
export { capabilityId, toolFor, toolName } from "./tool";
