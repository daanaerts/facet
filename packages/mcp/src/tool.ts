import type { CapabilityDef } from "@facet/core";
import { type JsonSchema, toJsonSchema } from "@facet/core";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

/**
 * The projection of ONE capability onto ONE MCP tool — written once, run over every capability that
 * declares the `mcp` surface. The surface wires this; a capability author writes no per-surface code, so a
 * new `*.cap.ts` with `surfaces.includes("mcp")` becomes an MCP tool the moment its registry is served.
 *
 * The tool name is the capability id with its dots mapped to `__` (see `toolName`/`capabilityId` below),
 * the description is the summary, and the tool's `inputSchema` is the capability's Zod input emitted as
 * JSON Schema (via core `toJsonSchema`) — with two platform fields MERGED IN so the surface contributes
 * exactly the parts of the Context an agent must supply and nothing else:
 *
 *   - `confirm` (boolean) — present only on `write`/`destructive` tools; the explicit "[Yes]" gate the
 *     core's confirmation invariant requires. Calling a write tool without it errors `confirmation_required`;
 *     an agent reads that, surfaces the proposed action to the human, then re-calls with `confirm: true` —
 *     the propose→confirm flow, modeled in the schema, not in surface code.
 *   - `idempotencyKey` (string) — optional on any non-read tool; passed straight to the Context so a retried
 *     write dedupes in the chokepoint. Reads never carry it (they are idempotent).
 *
 * Everything else — input validation, scope authz, the confirmation gate, idempotency dedup, audit — lives
 * in `@facet/core` `execute()` and the host-supplied Context. This file only NAMES the tool and SHAPES its
 * input; it re-implements no check.
 *
 * CARVE NOTE: Moral Fabric's `tool.ts` typed the def as `@mf/shared`'s `CapabilityDef` (an appId-carrying,
 * spine-bound shape) and gated tool listing on per-tenant installs in the server. Facet's `CapabilityDef`
 * is owned by nothing but its id; there is no tenant, install or appId anywhere here. The projection is
 * otherwise the same.
 */

/** The two platform fields the surface injects into a write/non-read tool's input schema. */
export const CONFIRM_FIELD = "confirm";
export const IDEMPOTENCY_FIELD = "idempotencyKey";

/**
 * Capability ids are dotted (`logs.tail`, `jobs.start`) — `defineCapability` requires it (core `define.ts`).
 * But the Anthropic Messages API rejects a tool `name` that contains a period: a name must match
 * `^[a-zA-Z0-9_-]{1,64}$`. The MCP SDK itself imposes no pattern, so dotted names round-trip fine over
 * `InMemoryTransport` in the e2e tests — but a real external agent over stdio that lists these tools and
 * forwards them into a v1 `messages` `tools` array would get a 400. So the surface maps `.` → `__` for the
 * wire name and reverses it on dispatch; the original dotted id is preserved on `annotations.title`. The
 * separator is two underscores so it is unambiguous against capability segments, which are single lowercase
 * words with no underscores (core's id rule).
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

/** The Context-shaping fields pulled back out of a tool call's arguments. */
export interface ToolMeta {
  /** The capability input — the tool arguments with the platform fields stripped off. */
  input: Record<string, unknown>;
  /** The surface-supplied confirmation for the core's write/destructive gate. */
  confirm: boolean;
  /** The optional idempotency key for a retried write. */
  idempotencyKey?: string;
}

/** Whether the surface injects a `confirm` field for this capability (writes and destructive ops do). */
function needsConfirm(def: CapabilityDef): boolean {
  return def.risk !== "read";
}

/**
 * Build the MCP tool definition for a capability. The `name` is the capability id with dots mapped to `__`
 * so it satisfies the Anthropic tool-name regex (see `toolName`); the original dotted id is surfaced on
 * `annotations.title`. The `inputSchema` is the capability's input JSON Schema with the platform fields
 * merged into its `properties` (`confirm` REQUIRED on a write/destructive tool — the gate is not optional —
 * while `idempotencyKey` stays optional), and `outputSchema` is the capability's output JSON Schema so an
 * agent has a machine-readable contract for the `structuredContent` the server returns. The tool's
 * `annotations` mirror the capability's threat model so a client can show the right affordance (read-only
 * vs destructive).
 */
export function toolFor(def: CapabilityDef): Tool {
  const inputSchema = toJsonSchema(def.input, "input");
  const properties: Record<string, unknown> = {
    ...((inputSchema.properties as Record<string, unknown> | undefined) ?? {}),
  };
  const required = new Set<string>(
    Array.isArray(inputSchema.required) ? (inputSchema.required as string[]) : [],
  );

  if (needsConfirm(def)) {
    properties[CONFIRM_FIELD] = {
      type: "boolean",
      description: `Explicit confirmation for this ${def.risk} action. Call once without it to preview; the server replies confirmation_required, then re-call with ${CONFIRM_FIELD}: true to run.`,
    };
    required.add(CONFIRM_FIELD);
  }

  if (def.risk !== "read") {
    properties[IDEMPOTENCY_FIELD] = {
      type: "string",
      description:
        "Optional idempotency key — re-sending the same key replays the first result instead of running again.",
    };
  }

  const merged: JsonSchema = {
    ...inputSchema,
    type: "object",
    properties,
  };
  if (required.size > 0) merged.required = [...required];
  else delete merged.required;

  return {
    name: toolName(def.id),
    description: def.summary,
    inputSchema: merged as Tool["inputSchema"],
    outputSchema: toJsonSchema(def.output, "output") as Tool["outputSchema"],
    annotations: {
      title: def.id,
      readOnlyHint: def.risk === "read",
      destructiveHint: def.risk === "destructive",
      idempotentHint: def.idempotent,
    },
  };
}

/**
 * Split a tool call's raw arguments into the capability input plus the Context-shaping fields the surface
 * injected. The platform fields (`confirm`, `idempotencyKey`) are peeled off; whatever remains is forwarded
 * to `execute()` verbatim, where the capability's own schema validates it — the surface never validates.
 */
export function readToolMeta(args: Record<string, unknown> | undefined): ToolMeta {
  const { [CONFIRM_FIELD]: confirm, [IDEMPOTENCY_FIELD]: key, ...input } = args ?? {};
  return {
    input,
    confirm: confirm === true,
    idempotencyKey: typeof key === "string" ? key : undefined,
  };
}
