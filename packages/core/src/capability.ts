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
}
