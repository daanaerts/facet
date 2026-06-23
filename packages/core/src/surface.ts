/**
 * The surfaces a capability projects onto.
 *
 * `agent` is listed FIRST on purpose. Facet's thesis is that the agent is the primary consumer; the human
 * surfaces (`http`, `cli`) and the machine surface (`mcp` for other agents) are projections of the same
 * capability. When two surfaces want conflicting idioms for one contract (output shape, pagination,
 * streaming), the agent's idiom wins and the others derive — that is what keeps "one definition, zero
 * per-surface code" true. See README.
 */
export const SURFACES = ["agent", "http", "mcp", "cli"] as const;

export type SurfaceKind = (typeof SURFACES)[number];
