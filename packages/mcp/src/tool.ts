import type { CapabilityDef } from "@facet/core";
import { toJsonSchema } from "@facet/core";
import { capabilityId, mergeContextFields, toolName } from "@facet/surface-kit";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

/**
 * The projection of ONE capability onto ONE MCP tool — written once, run over every capability that declares
 * the `mcp` surface. A new `*.cap.ts` with `surfaces.includes("mcp")` becomes an MCP tool the moment its
 * registry is served, with no per-surface code.
 *
 * The tool `name` is the capability id mapped to its wire form (`toolName`, dots → `__`, so it satisfies the
 * Anthropic tool-name regex); the original dotted id is on `annotations.title`. The `inputSchema` is
 * `mergeContextFields(def)` — the capability's input as JSON Schema with the `confirm` / `idempotencyKey`
 * Context fields merged in. Both `toolName`/`capabilityId` and the merge are shared mechanism, so they live in
 * `@facet/surface-kit`; this file only assembles the SDK `Tool` and re-implements no check (validation, authz,
 * the confirm gate, idempotency and audit all live in `@facet/core` `execute()`).
 */

// The dotted-id ↔ wire-name mapping lives in @facet/surface-kit (shared by both schema-advertising surfaces).
// Re-export it so @facet/mcp's public API (toolName / capabilityId) is unchanged for existing importers.
export { capabilityId, toolName };

/**
 * Build the MCP tool definition for a capability: the wire-safe name, the summary as description, the input
 * schema with the Context fields merged in, the output schema (so an agent has a contract for
 * `structuredContent`), and `annotations` mirroring the threat model (read-only vs destructive).
 */
export function toolFor(def: CapabilityDef): Tool {
  return {
    name: toolName(def.id),
    description: def.summary,
    inputSchema: mergeContextFields(def) as Tool["inputSchema"],
    outputSchema: toJsonSchema(def.output, "output") as Tool["outputSchema"],
    annotations: {
      title: def.id,
      readOnlyHint: def.risk === "read",
      destructiveHint: def.risk === "destructive",
      idempotentHint: def.idempotent,
    },
  };
}
