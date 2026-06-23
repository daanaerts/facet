import type { CapabilityDef } from "@facet/core";
import { toJsonSchema } from "@facet/core";
import { mergeContextFields } from "@facet/surface-kit";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

/**
 * The projection of ONE capability onto ONE MCP tool — written once, run over every capability that declares
 * the `mcp` surface. The surface wires this; a capability author writes no per-surface code, so a new
 * `*.cap.ts` with `surfaces.includes("mcp")` becomes an MCP tool the moment its registry is served.
 *
 * The tool name is the capability id with its dots mapped to `__` (see `toolName`/`capabilityId` below), the
 * description is the summary, and the tool's `inputSchema` is the capability's input as JSON Schema with the
 * `confirm` / `idempotencyKey` Context fields merged in — that merge is the SAME mechanism the agent surface
 * uses, so it lives once in `@facet/surface-kit` (`mergeContextFields`) rather than being copied here. This
 * file only NAMES the tool (and maps the wire name) and assembles the SDK `Tool`; it re-implements no check —
 * input validation, scope authz, the confirmation gate, idempotency dedup and audit all live in
 * `@facet/core` `execute()`.
 *
 * CARVE NOTE: Moral Fabric's `tool.ts` typed the def as `@mf/shared`'s `CapabilityDef` (an appId-carrying,
 * spine-bound shape) and gated tool listing on per-tenant installs in the server. Facet's `CapabilityDef`
 * is owned by nothing but its id; there is no tenant, install or appId anywhere here.
 */

/**
 * Capability ids are dotted (`logs.tail`, `jobs.start`) — `defineCapability` requires it. But the Anthropic
 * Messages API rejects a tool `name` containing a period: a name must match `^[a-zA-Z0-9_-]{1,64}$`. The MCP
 * SDK itself imposes no pattern, so dotted names round-trip fine over `InMemoryTransport` in the e2e tests —
 * but a real external agent over stdio that lists these tools and forwards them into a v1 `messages` `tools`
 * array would get a 400. So the surface maps `.` → `__` for the wire name and reverses it on dispatch; the
 * original dotted id is preserved on `annotations.title`. The separator is two underscores so it is
 * unambiguous against capability segments, which are single lowercase words with no underscores.
 */
const NAME_SEPARATOR = "__";

/** The MCP tool name for a capability id: dots → `__`, so the name matches the Anthropic tool-name regex. */
export function toolName(id: string): string {
  return id.replaceAll(".", NAME_SEPARATOR);
}

/** The capability id for an MCP tool name: the inverse of `toolName` (`__` → `.`). */
export function capabilityId(name: string): string {
  return name.replaceAll(NAME_SEPARATOR, ".");
}

/**
 * Build the MCP tool definition for a capability. The `name` is the wire-safe `toolName(id)`; the original
 * dotted id is surfaced on `annotations.title`. The `inputSchema` is `mergeContextFields(def)` — the
 * capability's input JSON Schema with `confirm` (REQUIRED on a write/destructive tool) and `idempotencyKey`
 * (optional on a non-read) merged in — and `outputSchema` is the capability's output JSON Schema so an agent
 * has a machine-readable contract for the `structuredContent` the server returns. The `annotations` mirror the
 * capability's threat model so a client can show the right affordance (read-only vs destructive).
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
