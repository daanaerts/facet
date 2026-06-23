import type { CapabilityDef, Risk } from "./capability";
import type { Context } from "./context";
import type { StandardSchemaV1 } from "./standard-schema";
import type { SurfaceKind } from "./surface";
import { SURFACES } from "./surface";

/** Dotted lowercase, ≥2 segments: `logs.tail`, `jobs.start`. The one stable name on every surface. */
const ID_RE = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/;

/**
 * Author-facing spec. The schemas drive full input/output inference for the handler.
 *
 * `input` / `output` are typed to `StandardSchemaV1` — the validation CONTRACT, not a specific library — so an
 * author may use any Standard-Schema-compatible validator. Zod v4 schemas implement Standard Schema, so the
 * common case is unchanged: `z.object(...)` is assignable to `StandardSchemaV1`, and the author's inferred
 * input/output types flow through the spec's `InferInput` / `InferOutput` so the handler stays fully typed.
 */
export interface CapabilitySpec<I extends StandardSchemaV1, O extends StandardSchemaV1> {
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
  handler: (
    input: StandardSchemaV1.InferOutput<I>,
    ctx: Context,
  ) => Promise<StandardSchemaV1.InferInput<O>>;
}

/**
 * Define a capability. One definition, projected to every enabled surface with no per-surface code. Export
 * it as the file's default and `discoverCapabilities` picks it up by glob (`**​/*.cap.ts`).
 *
 * The handler receives the schema's PARSED output (`InferOutput<I>` — defaults applied, types narrowed) and
 * returns a value matching the output schema's INPUT (`InferInput<O>` — `execute()` then validates it into the
 * advertised output shape). For Zod this is the familiar `z.infer` on both sides.
 */
export function defineCapability<I extends StandardSchemaV1, O extends StandardSchemaV1>(
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
