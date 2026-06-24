import { z } from "zod";
import type { StandardSchemaV1 } from "./standard-schema";

/** A JSON Schema object, the shape `z.toJSONSchema()` emits. Held loosely — a surface only forwards it. */
export type JsonSchema = Record<string, unknown>;

/** Which side of a schema to project: the shape a caller SENDS vs. the shape a handler PRODUCES. */
export type SchemaIO = "input" | "output";

/**
 * THE PROJECTION SEAM — how a capability's schema becomes the JSON Schema the surfaces advertise.
 *
 * Validation in Facet is now any-StandardSchema (see `standard-schema.ts`), but PROJECTION — turning a schema
 * into the JSON Schema an HTTP catalogue advertises and an MCP tool declares as its `inputSchema` — is a
 * distinct concern with a distinct dialect. Not every StandardSchema library ships a JSON-Schema emitter, and
 * the emitters that exist differ, so projection lives behind this small port with a DEFAULT Zod adapter. The
 * surfaces call `toJsonSchema(...)`, which delegates to the active adapter; an adopter using a non-Zod
 * validator can register their own adapter (or a no-op) without the engine caring.
 *
 * DECIDED (TODO.md P0 #1): "Validation = any lib; projection ships Zod first." The default adapter below uses
 * Zod v4's native `z.toJSONSchema()`, so for the common case — authoring with `z.object(...)` — the JSON
 * Schema a client reads is derived from the EXACT same schema `execute()` validates against: advertise ==
 * enforce, no second dialect, no adapter drift. A capability authored with a non-Zod StandardSchema still
 * VALIDATES; it just needs a matching projection adapter to be ADVERTISED with a precise JSON Schema.
 */
export interface SchemaAdapter {
  /** A name for diagnostics (e.g. `"zod"`). */
  readonly name: string;
  /** Project a schema to JSON Schema for the given I/O side. Throws if the schema is not this adapter's. */
  toJsonSchema(schema: StandardSchemaV1, io: SchemaIO): JsonSchema;
}

/**
 * The default, Zod-first projection adapter. `z.toJSONSchema()` is Zod v4's native emitter:
 * - `io: "input"`  emits the shape a caller SENDS (pre-parse: defaults are optional) — what a tool's
 *   `inputSchema` needs, so the schema an agent reads matches what `execute()` will accept.
 * - `io: "output"` emits the post-parse shape, used for an output/result contract.
 *
 * It accepts a `StandardSchemaV1` (the engine's lingua franca) and treats it as a Zod schema at runtime — true
 * for every `z.*` schema, since a Zod schema both implements StandardSchema AND is the value `z.toJSONSchema`
 * consumes. A genuinely non-Zod schema reaching this adapter throws inside Zod, which is the correct, loud
 * failure: register the right adapter for that library.
 */
export const zodSchemaAdapter: SchemaAdapter = {
  name: "zod",
  toJsonSchema(schema: StandardSchemaV1, io: SchemaIO): JsonSchema {
    return z.toJSONSchema(schema as unknown as z.ZodType, { io }) as JsonSchema;
  },
};

/** The active projection adapter. Zod by default; an adopter may swap it once at boot via `setSchemaAdapter`. */
let activeAdapter: SchemaAdapter = zodSchemaAdapter;

/**
 * Swap the projection adapter (process-wide). Call once at startup if you author capabilities with a non-Zod
 * StandardSchema library and want the surfaces to advertise a precise JSON Schema for them. Validation is
 * unaffected — it always runs through the schema's own `~standard.validate`, never through this seam.
 *
 * NOTE: this sets PROCESS-GLOBAL state and is intended to be called ONCE at boot. The active adapter is a
 * single module-level value, so two registries living in the same process cannot use different projectors —
 * the last call wins for everyone. This is a deliberate boot-time-only global, not per-registry config.
 */
export function setSchemaAdapter(adapter: SchemaAdapter): void {
  activeAdapter = adapter;
}

/** The active projection adapter (for inspection/tests). */
export function getSchemaAdapter(): SchemaAdapter {
  return activeAdapter;
}

/**
 * Turn a capability's schema into a JSON Schema via the active projection adapter — the wire shape the HTTP
 * catalogue advertises and an MCP tool declares as its `inputSchema`. This is the single projection entry
 * point: surfaces import it from `@facet/core` rather than reaching for Zod (or any emitter) directly, so the
 * emitter choice lives in one place and every surface stays free of schema logic. Defaults to the `input` side.
 */
export function toJsonSchema(schema: StandardSchemaV1, io: SchemaIO = "input"): JsonSchema {
  return activeAdapter.toJsonSchema(schema, io);
}
