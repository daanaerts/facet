import type { Context } from "./context";
import type { StandardSchemaV1 } from "./standard-schema";
import type { SurfaceKind } from "./surface";

/**
 * The threat model of a capability — the single field that produces the right affordance on every surface.
 * - `read`        → idempotent, auto-runs everywhere.
 * - `write`       → confirmation-gated; may be idempotent by business identity.
 * - `destructive` → confirmation-gated; pairs with an undo capability (undo is a capability PATTERN, not a
 *                   core engine — kept out of `execute()` deliberately).
 */
export type Risk = "read" | "write" | "destructive";

/**
 * One worked example for a capability — an input payload plus an optional note. Examples are authored ONCE on
 * the spec (typed against the input schema) and rendered into every surface's help: the CLI `--help`, and the
 * MCP / HTTP describe payloads that reuse {@link describeCapability}. The `input` is the shape a caller SENDS
 * (pre-parse — defaults may be omitted), so an example is a literal payload a reader can copy into a call.
 */
export interface CapabilityExample {
  /** A worked input payload — the shape a caller sends (pre-parse). */
  input: unknown;
  /** Optional one-line note explaining what the example demonstrates. */
  note?: string;
}

/**
 * A typed, headless use-case: the single source of truth from which every surface is projected. Stored in
 * the registry with its schemas erased to `StandardSchemaV1`; `defineCapability` preserves full inference for
 * authors. The schemas are held as the validation CONTRACT (Standard Schema) — `execute()` validates through
 * `['~standard'].validate`, and the surfaces project them to JSON Schema through the adapter seam — so the
 * engine is decoupled from any one validation library (Zod is the default, not a hard dependency of the type).
 *
 * CARVE NOTE: Moral Fabric's `CapabilityDef` carried an `appId` (the owning app, derived from file path,
 * used for per-tenant install-gating). That is host metadata, not a capability-framework concept, so it is
 * gone. A capability here is owned by nothing but its `id`.
 */
export interface CapabilityDef {
  id: string;
  summary: string;
  /**
   * LONG-FORM help body (OPTIONAL), distinct from the one-line `summary`. `summary` is the tool-list blurb
   * (the MCP/agent tool `description`, the `facet ls` row); `description` is the multi-paragraph man-page body
   * rendered by `facet <id> --help` (and available to the MCP/HTTP describe payloads). Absent when not
   * declared — surfaces fall back to `summary` alone.
   */
  description?: string;
  /**
   * EXAMPLES (OPTIONAL) — worked input payloads, authored once and rendered into every surface's help via
   * {@link describeCapability}. Empty/absent when not declared; the engine attaches no semantics to them (they
   * are documentation, never executed by the core).
   */
  examples?: CapabilityExample[];
  input: StandardSchemaV1;
  output: StandardSchemaV1;
  scopes: string[];
  risk: Risk;
  /**
   * REVERSIBILITY (additive, OPTIONAL). `risk` alone cannot separate a recoverable destructive action
   * (archive-to-trash, capture-then-refund) from a permanent one (hard delete, merge) — eight of ten dogfood
   * apps wanted the distinction. `reversible: true` marks an effect that can be undone, `false` one that is
   * permanent, and `undefined` (the default) leaves it UNSPECIFIED — the engine attaches no semantics to it
   * either way (it gates nothing on it, exactly as it does nothing extra for `risk`). It is surfaced wherever
   * `risk` already is — the HTTP `/cap` entry, the MCP tool annotations, the agent toolset — so a surface or
   * agent can calibrate its confirmation copy ("move to trash" vs "permanently delete") from the contract.
   */
  reversible?: boolean;
  /** Read ⇒ always true. Writes opt in (deduped by business identity). */
  idempotent: boolean;
  surfaces: SurfaceKind[];
  /** Central kill-switch — disable without deleting. */
  enabled: boolean;
  handler: (input: unknown, ctx: Context) => Promise<unknown>;
  /**
   * STREAMING (additive). A streaming capability produces its result as structured INCREMENTAL chunks plus
   * a terminal final value, so `executeStream()` can hand an agent the pieces as they are produced and a
   * human surface can render them (SSE, printed lines, MCP progress) downstream. The canonical shape is
   * "chunks then a final"; a non-streaming caller still gets the final via `execute()`, which drains.
   *
   * `stream` flags the capability as streaming; `chunk` is the schema for ONE incremental element
   * (validated on every yield, exactly as `output` validates the final). Both are absent on the ordinary
   * unary capabilities, which are untouched by this addition. A streaming capability is always `risk:"read"`
   * — streaming is a read idiom, so the confirmation and idempotency gates never apply to it.
   */
  stream?: boolean;
  /** The schema for one incremental chunk (Standard Schema). Present iff `stream` is true. */
  chunk?: StandardSchemaV1;
  /**
   * The async-generator handler for a streaming capability. It yields chunks and RETURNS the final value:
   * `async function*(input, ctx): AsyncGenerator<Chunk, Final, void>`. Stored separately from `handler` so
   * the unary `handler` field keeps its exact `Promise`-returning shape for non-streaming callers; for a
   * streaming capability `handler` is synthesized to DRAIN this generator down to the validated final.
   */
  streamHandler?: (input: unknown, ctx: Context) => AsyncGenerator<unknown, unknown, void>;
}
