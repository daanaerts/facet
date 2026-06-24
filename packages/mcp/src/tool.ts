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
 * Build the MCP tool definition for a capability: the wire-safe name, the tool description (summary +
 * long-form `description` + worked `examples`, via {@link toolDescription}), the input schema with the
 * Context fields merged in, the output schema (so an agent has a contract for `structuredContent`), and
 * `annotations` mirroring the threat model (read-only vs destructive).
 *
 * When the capability declared a reversibility signal (additive, OPTIONAL), it rides on the annotations next
 * to `destructiveHint` as a `reversibleHint` (`true` ⇒ recoverable, `false` ⇒ permanent), so an MCP client can
 * calibrate its confirmation copy ("move to trash" vs "permanently delete"). The hint is OMITTED entirely when
 * the capability left reversibility unspecified, so the annotation shape is unchanged for those tools. The MCP
 * `ToolAnnotations` type is open (extra hints are permitted), and the SDK strips unknown keys on the wire.
 */
/**
 * The tool description an MCP client renders — the MCP equivalent of the CLI's `facet <id> --help`. The
 * one-line `summary` leads (it is what a tool list shows at a glance); the long-form `description` and the
 * worked `examples` follow when the capability declares them, so an agent reading the tool sees the SAME docs
 * a human gets on `--help`, from the same single source on the capability. Per-field docs are deliberately
 * NOT repeated here — they already ride the `inputSchema` (a Zod `.describe()` survives into the JSON Schema
 * `mergeContextFields` emits). For a write/destructive capability an example is shown carrying `confirm: true`
 * so it is a tool call a model can copy verbatim — mirroring the CLI appending `--yes` to a write's example.
 */
function toolDescription(def: CapabilityDef): string {
  const parts: string[] = [def.summary];
  if (def.description) parts.push(def.description.trim());
  if (def.examples && def.examples.length > 0) {
    const lines = def.examples.map((ex) => {
      const args =
        def.risk === "read"
          ? ex.input
          : { ...(ex.input as Record<string, unknown>), confirm: true };
      const call = JSON.stringify(args);
      return ex.note ? `- ${ex.note}\n  ${call}` : `- ${call}`;
    });
    parts.push(`Examples:\n${lines.join("\n")}`);
  }
  return parts.join("\n\n");
}

export function toolFor(def: CapabilityDef): Tool {
  return {
    name: toolName(def.id),
    description: toolDescription(def),
    inputSchema: mergeContextFields(def) as Tool["inputSchema"],
    outputSchema: toJsonSchema(def.output, "output") as Tool["outputSchema"],
    annotations: {
      title: def.id,
      readOnlyHint: def.risk === "read",
      destructiveHint: def.risk === "destructive",
      idempotentHint: def.idempotent,
      // Additive: only present when the capability actually declared reversibility. A spread of an empty
      // object adds nothing, so an unspecified capability's annotations stay byte-for-byte what they were.
      ...(def.reversible !== undefined ? { reversibleHint: def.reversible } : {}),
    },
  };
}
