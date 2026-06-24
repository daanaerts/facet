import type { CapabilityDef, CapabilityExample, Risk } from "./capability";
import { type JsonSchema, toJsonSchema } from "./schema-adapter";
import type { SurfaceKind } from "./surface";

/**
 * One field of a capability's input or output, normalized out of its JSON Schema for a help renderer. The
 * material — name, type, requiredness, default, description — already lives in the schema (`describe()` text
 * survives into the JSON Schema the projection adapter emits); this is just that schema flattened into the
 * row a `--help` table, an HTTP describe payload, or an MCP client wants. Nested object/array shape is NOT
 * expanded here — `type` is the one-word JSON-Schema type and the raw schema travels alongside for a surface
 * that wants to render deeper.
 */
export interface FieldDoc {
  /** The property name. */
  name: string;
  /** A one-word JSON-Schema type (`string`, `integer`, `object`, …) or a `|`-joined union/enum. */
  type: string;
  /** Whether the input schema lists this property as required. */
  required: boolean;
  /** The schema default, when the property declares one (omitted otherwise). */
  default?: unknown;
  /** The property's `.describe()` text, when present. */
  description?: string;
}

/**
 * The SURFACE-AGNOSTIC documentation model for one capability — the single source every surface's help is a
 * projection of. It carries the contract a reader needs (id, summary, long-form `description`, threat model,
 * scopes, the surfaces it lights up, whether it streams), the input/output flattened to {@link FieldDoc} rows
 * for tabular renderers, the raw input/output JSON Schema for renderers that want the full shape, and the
 * authored {@link CapabilityExample}s. `describeCapability` builds it; the CLI renders it as a man page, and
 * the MCP/HTTP surfaces can reuse it for their own describe payloads — none of them re-derives the model.
 */
export interface CapabilityDoc {
  id: string;
  summary: string;
  description?: string;
  risk: Risk;
  reversible?: boolean;
  idempotent: boolean;
  stream: boolean;
  scopes: string[];
  surfaces: SurfaceKind[];
  input: FieldDoc[];
  output: FieldDoc[];
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  examples: CapabilityExample[];
}

/** The one-word display type for a JSON-Schema property (or a `|`-joined union/enum when it is not atomic). */
function typeName(prop: Record<string, unknown>): string {
  // An enum is more informative than its base type — show the allowed values (`"a"|"b"`) before falling back.
  if (Array.isArray(prop.enum)) return prop.enum.map((v) => JSON.stringify(v)).join("|");
  if (typeof prop.type === "string") return prop.type;
  if (Array.isArray(prop.type)) return prop.type.join("|");
  const union = prop.anyOf ?? prop.oneOf;
  if (Array.isArray(union)) {
    return union.map((s) => typeName(s as Record<string, unknown>)).join("|");
  }
  if (prop.$ref !== undefined) return "ref";
  return "any";
}

/** Flatten a JSON Schema object's `properties` into {@link FieldDoc} rows (top level only). */
function fieldsOf(schema: JsonSchema): FieldDoc[] {
  const props = (schema.properties as Record<string, Record<string, unknown>> | undefined) ?? {};
  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
  return Object.entries(props).map(([name, prop]) => {
    const field: FieldDoc = { name, type: typeName(prop), required: required.has(name) };
    if (prop.default !== undefined) field.default = prop.default;
    if (typeof prop.description === "string") field.description = prop.description;
    return field;
  });
}

/**
 * Project a capability into its {@link CapabilityDoc} — the surface-agnostic help model. This is the doc
 * counterpart of the schema projection: the field descriptions, examples and threat model an author wrote
 * ONCE become a normalized record every surface renders in its own idiom (CLI `--help`, MCP/HTTP describe
 * payloads), so the docs can no more drift from the capability than the advertised schema can drift from the
 * enforced one — both derive from the same definition.
 */
export function describeCapability(def: CapabilityDef): CapabilityDoc {
  const inputSchema = toJsonSchema(def.input, "input");
  const outputSchema = toJsonSchema(def.output, "output");
  return {
    id: def.id,
    summary: def.summary,
    description: def.description,
    risk: def.risk,
    reversible: def.reversible,
    idempotent: def.idempotent,
    stream: def.stream === true,
    scopes: def.scopes,
    surfaces: def.surfaces,
    input: fieldsOf(inputSchema),
    output: fieldsOf(outputSchema),
    inputSchema,
    outputSchema,
    examples: def.examples ?? [],
  };
}
