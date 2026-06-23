import type { ZodType } from "zod";
import { z } from "zod";

/** A JSON Schema object, the shape `z.toJSONSchema()` emits. Held loosely — a surface only forwards it. */
export type JsonSchema = Record<string, unknown>;

/**
 * Turn a capability's Zod schema into a JSON Schema — the wire shape the HTTP catalogue advertises and an
 * MCP tool declares as its `inputSchema`. Zod is the single schema dialect; its native v4 `z.toJSONSchema()`
 * is the emitter, so the MCP tool input, the HTTP catalogue and any client all derive their shape from the
 * exact same `z.object(...)` the handler validates against — no second dialect, no adapter drift.
 *
 * `io: "input"` emits the shape a caller SENDS (pre-parse: defaults are optional); that is what a tool's
 * `inputSchema` needs, so the schema an agent reads matches what `execute()` will accept. `io: "output"`
 * emits the post-parse shape, used for an output/result contract.
 *
 * This is a deliberately thin wrapper: surfaces import it from `@facet/core` rather than reaching for Zod
 * directly, so the single emitter choice lives in one place and every surface stays free of schema logic.
 */
export function toJsonSchema(schema: ZodType, io: "input" | "output" = "input"): JsonSchema {
  return z.toJSONSchema(schema, { io }) as JsonSchema;
}
