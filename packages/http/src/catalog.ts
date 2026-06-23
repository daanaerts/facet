import type { CapabilityDef } from "@facet/core";
import {
  type JsonSchema,
  type Registry,
  type Risk,
  type SurfaceKind,
  toJsonSchema,
} from "@facet/core";

/**
 * The introspection record for one capability — id, threat model, the surfaces it lights up, and its
 * input/output JSON Schema. A client (a browser, another agent's MCP surface, or a human) reads the
 * catalogue and knows exactly what to send without importing the registry. The schema fields come from the
 * same Zod object the handler validates against, so the advertised shape can never drift from the enforced
 * one.
 *
 * CARVE NOTE: Moral Fabric's catalogue entry carried an `appId` (the owning app, for per-tenant
 * install-gating). A Facet capability is owned by nothing but its `id`, so that field is gone — this is the
 * MF `catalogEntry`/`httpCatalog` ported with the spine dropped.
 */
export interface CapabilityCatalogEntry {
  id: string;
  summary: string;
  risk: Risk;
  /** Whether this capability streams (its result is incremental chunks + a final). Drives SSE affordances. */
  stream: boolean;
  surfaces: SurfaceKind[];
  input: JsonSchema;
  output: JsonSchema;
}

/** Project one capability definition into its catalogue entry (input/output erased to JSON Schema). */
export function catalogEntry(def: CapabilityDef): CapabilityCatalogEntry {
  return {
    id: def.id,
    summary: def.summary,
    risk: def.risk,
    stream: def.stream === true,
    surfaces: def.surfaces,
    input: toJsonSchema(def.input, "input"),
    output: toJsonSchema(def.output, "output"),
  };
}

/**
 * The HTTP catalogue: every enabled capability that projects onto the `http` surface, as wire records.
 * This is the registry projected once — a new capability with `surfaces.includes("http")` appears here
 * (and on its route) automatically, with no per-capability code.
 */
export function httpCatalog(registry: Registry): CapabilityCatalogEntry[] {
  return registry.forSurface("http").map(catalogEntry);
}
