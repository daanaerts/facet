import type { ZodType, z } from "zod";
import type { CapabilityDef, Risk } from "./capability";
import type { Context } from "./context";
import type { SurfaceKind } from "./surface";
import { SURFACES } from "./surface";

/** Dotted lowercase, ≥2 segments: `logs.tail`, `jobs.start`. The one stable name on every surface. */
const ID_RE = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/;

/** Author-facing spec. The schemas drive full input/output inference for the handler. */
export interface CapabilitySpec<I extends ZodType, O extends ZodType> {
  id: string;
  summary: string;
  input: I;
  output: O;
  scopes?: string[];
  /** Defaults to `read`. */
  risk?: Risk;
  /** Defaults to `true` for reads, `false` for writes. */
  idempotent?: boolean;
  /** Defaults to all surfaces. Narrow it to opt a capability out of, say, `cli`. */
  surfaces?: SurfaceKind[];
  enabled?: boolean;
  handler: (input: z.infer<I>, ctx: Context) => Promise<z.infer<O>>;
}

/**
 * Define a capability. One definition, projected to every enabled surface with no per-surface code. Export
 * it as the file's default and `discoverCapabilities` picks it up by glob (`**​/*.cap.ts`).
 */
export function defineCapability<I extends ZodType, O extends ZodType>(
  spec: CapabilitySpec<I, O>,
): CapabilityDef {
  if (!ID_RE.test(spec.id)) {
    throw new Error(
      `invalid capability id "${spec.id}" — expected dotted lowercase like "jobs.start"`,
    );
  }
  const risk: Risk = spec.risk ?? "read";
  return {
    id: spec.id,
    summary: spec.summary,
    input: spec.input,
    output: spec.output,
    scopes: spec.scopes ?? [],
    risk,
    idempotent: spec.idempotent ?? risk === "read",
    surfaces: spec.surfaces ?? [...SURFACES],
    enabled: spec.enabled ?? true,
    handler: spec.handler as unknown as CapabilityDef["handler"],
  };
}
