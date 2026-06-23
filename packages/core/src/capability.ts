import type { ZodType } from "zod";
import type { Context } from "./context";
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
 * A typed, headless use-case: the single source of truth from which every surface is projected. Stored in
 * the registry with its schemas erased to `ZodType`; `defineCapability` preserves full inference for authors.
 *
 * CARVE NOTE: Moral Fabric's `CapabilityDef` carried an `appId` (the owning app, derived from file path,
 * used for per-tenant install-gating). That is host metadata, not a capability-framework concept, so it is
 * gone. A capability here is owned by nothing but its `id`.
 */
export interface CapabilityDef {
  id: string;
  summary: string;
  input: ZodType;
  output: ZodType;
  scopes: string[];
  risk: Risk;
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
   * `stream` flags the capability as streaming; `chunk` is the Zod schema for ONE incremental element
   * (validated on every yield, exactly as `output` validates the final). Both are absent on the ordinary
   * unary capabilities, which are untouched by this addition. A streaming capability is always `risk:"read"`
   * — streaming is a read idiom, so the confirmation and idempotency gates never apply to it.
   */
  stream?: boolean;
  /** The Zod schema for one incremental chunk. Present iff `stream` is true. */
  chunk?: ZodType;
  /**
   * The async-generator handler for a streaming capability. It yields chunks and RETURNS the final value:
   * `async function*(input, ctx): AsyncGenerator<Chunk, Final, void>`. Stored separately from `handler` so
   * the unary `handler` field keeps its exact `Promise`-returning shape for non-streaming callers; for a
   * streaming capability `handler` is synthesized to DRAIN this generator down to the validated final.
   */
  streamHandler?: (input: unknown, ctx: Context) => AsyncGenerator<unknown, unknown, void>;
}
