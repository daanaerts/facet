import type { CapabilityDef } from "./capability";
import type { Context } from "./context";
import type { StandardSchemaV1 } from "./standard-schema";
import type { SurfaceKind } from "./surface";
import { SURFACES } from "./surface";

/** Dotted lowercase, ≥2 segments: `logs.follow`, `metrics.watch`. Same name rule as `defineCapability`. */
const ID_RE = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/;

/**
 * Author-facing spec for a STREAMING capability. It declares two schemas instead of one result schema:
 * `chunk` (the incremental element produced repeatedly) and `output` (the terminal/final value). The handler
 * is an async generator — it `yield`s chunks and `return`s the final — so authoring a stream is just writing
 * the obvious generator, with full input/chunk/final inference driven by the schemas.
 *
 * As with `defineCapability`, the schemas are typed to `StandardSchemaV1` (the validation contract), so any
 * Standard-Schema validator works; Zod schemas implement it, so `z.object(...)` flows through unchanged with
 * the author's inferred types preserved via the spec's `InferInput` / `InferOutput`.
 *
 * There is deliberately no `risk` field: a streaming capability is `risk:"read"` by construction (streaming
 * is a read idiom), so confirmation and idempotency never enter the picture. Everything else — `scopes`,
 * `surfaces`, `enabled` — matches `defineCapability`.
 */
export interface StreamingCapabilitySpec<
  I extends StandardSchemaV1,
  C extends StandardSchemaV1,
  O extends StandardSchemaV1,
> {
  id: string;
  summary: string;
  input: I;
  /** The schema for ONE incremental chunk; validated on every yield. */
  chunk: C;
  /** The schema for the terminal/final value the generator returns; validated once at the end. */
  output: O;
  scopes?: string[];
  /** Defaults to all surfaces. Narrow it to opt the stream out of, say, `cli`. */
  surfaces?: SurfaceKind[];
  enabled?: boolean;
  /**
   * The streaming handler: `async function*(input, ctx)` that yields chunk values and returns a final value.
   * It receives the parsed input (`InferOutput<I>`), yields values matching the chunk schema's input
   * (`InferInput<C>`) and returns one matching the output schema's input (`InferInput<O>`); the core validates
   * each yield and the return before they leave `executeStream()`. For Zod this is `z.infer` throughout.
   */
  handler: (
    input: StandardSchemaV1.InferOutput<I>,
    ctx: Context,
  ) => AsyncGenerator<StandardSchemaV1.InferInput<C>, StandardSchemaV1.InferInput<O>, void>;
}

/**
 * Define a STREAMING capability — the additive sibling of `defineCapability`. One generator handler, projected
 * to every enabled surface with no per-surface code: `executeStream()` hands an agent the chunks as they are
 * produced, and `execute()` still serves the terminal value to a caller that does not stream (it drains).
 *
 * The returned `CapabilityDef` is an ordinary registry entry with three streaming fields set — `stream:true`,
 * the `chunk` schema, and the generator under `streamHandler` — and `risk` pinned to `"read"`. Its unary
 * `handler` is synthesized to DRAIN the generator to the final, so the non-streaming `handler` contract still
 * holds even though `execute()` routes streaming capabilities through `drainStream` before ever calling it.
 */
export function defineStreamingCapability<
  I extends StandardSchemaV1,
  C extends StandardSchemaV1,
  O extends StandardSchemaV1,
>(spec: StreamingCapabilitySpec<I, C, O>): CapabilityDef {
  if (!ID_RE.test(spec.id)) {
    throw new Error(
      `invalid capability id "${spec.id}" — expected dotted lowercase like "logs.follow"`,
    );
  }

  const streamHandler = spec.handler as unknown as CapabilityDef["streamHandler"];

  return {
    id: spec.id,
    summary: spec.summary,
    input: spec.input,
    output: spec.output,
    scopes: spec.scopes ?? [],
    // A streaming capability is a read: it auto-runs everywhere, with no confirmation and no ledger.
    risk: "read",
    idempotent: true,
    surfaces: spec.surfaces ?? [...SURFACES],
    enabled: spec.enabled ?? true,
    stream: true,
    chunk: spec.chunk,
    streamHandler,
    // Synthesized unary handler: drain the generator to its final. `execute()` never reaches this (it routes
    // streaming caps through `drainStream`), but the field keeps the non-streaming `handler` contract honest.
    handler: async (input: unknown, ctx: Context): Promise<unknown> => {
      // biome-ignore lint/style/noNonNullAssertion: `streamHandler` is always set for a streaming capability.
      const gen = streamHandler!(input, ctx);
      let step = await gen.next();
      while (!step.done) step = await gen.next();
      return step.value;
    },
  };
}
