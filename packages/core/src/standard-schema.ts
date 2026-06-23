/**
 * THE VALIDATION CONTRACT — Standard Schema, inlined.
 *
 * Facet validates input and output through ONE narrow interface — `StandardSchemaV1`, the community spec
 * (standardschema.dev, `@standard-schema/spec`) that Zod, Valibot, ArkType and others all implement. The
 * engine therefore depends on the *contract*, not on Zod: an adopter can author capabilities with any
 * StandardSchema-compatible library and `execute()` validates them unchanged. Projection (JSON Schema for the
 * surfaces) is a SEPARATE seam that still ships Zod-first — see `schema-adapter.ts`. Validation = any lib;
 * projection = Zod by default.
 *
 * WHY INLINE rather than `npm i @standard-schema/spec`: the engine is deliberately dependency-light and the
 * background build is hermetic, so we copy the spec's ~20-line type shape here verbatim (it is a frozen,
 * versioned interface — `version: 1` — so a copy cannot drift from a moving target). This is the published
 * shape, trimmed to exactly what the engine consumes: the `~standard` property carrying `validate` plus the
 * `Result` union and the `InferInput` / `InferOutput` helpers that let `defineCapability` keep an author's
 * inferred types. Anything a vendor adds beyond this (its own `vendor` string, extra metadata) is preserved
 * structurally but unused by the core.
 *
 * Zod v4 schemas already implement this (`z.object(...)["~standard"].vendor === "zod"`, `version === 1`), so
 * authors keep writing `z.object(...)` with NO edits — `z.ZodType` is assignable to `StandardSchemaV1`.
 */

/** The Standard Schema interface (spec v1). A schema exposes its machine-readable contract under `~standard`. */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  /** The Standard Schema properties. The funny key is the whole point: one reserved, collision-proof slot. */
  readonly "~standard": StandardSchemaV1.Props<Input, Output>;
}

export declare namespace StandardSchemaV1 {
  /** The properties under `~standard`: a version tag, the vendor name, the validator, and inferred types. */
  export interface Props<Input = unknown, Output = Input> {
    /** The version number of the standard. Always `1` for this revision. */
    readonly version: 1;
    /** The vendor that produced the schema (e.g. `"zod"`), for diagnostics only. */
    readonly vendor: string;
    /** Validate an unknown value. May be async; the engine always `await`s it. */
    readonly validate: (value: unknown) => Result<Output> | Promise<Result<Output>>;
    /** Inference helper carrier — never populated at runtime, present only so the types below can read it. */
    readonly types?: Types<Input, Output> | undefined;
  }

  /** The validation result: a success carrying the parsed `value`, or a failure carrying `issues`. */
  export type Result<Output> = SuccessResult<Output> | FailureResult;

  /** A successful validation: `issues` is absent, `value` is the parsed output. */
  export interface SuccessResult<Output> {
    readonly value: Output;
    readonly issues?: undefined;
  }

  /** A failed validation: `issues` is a non-empty array describing what went wrong. */
  export interface FailureResult {
    readonly issues: ReadonlyArray<Issue>;
  }

  /** One validation issue. `message` is required; `path` locates it within the input when present. */
  export interface Issue {
    readonly message: string;
    readonly path?: ReadonlyArray<PropertyKey | PathSegment> | undefined;
  }

  /** A structured path segment (some vendors emit objects rather than bare keys). */
  export interface PathSegment {
    readonly key: PropertyKey;
  }

  /** The carrier for an author's input/output types, surfaced through `InferInput` / `InferOutput`. */
  export interface Types<Input = unknown, Output = Input> {
    readonly input: Input;
    readonly output: Output;
  }

  /** The type a caller SENDS (pre-parse): defaults/transforms are still optional here. */
  export type InferInput<Schema extends StandardSchemaV1> = NonNullable<
    Schema["~standard"]["types"]
  >["input"];

  /** The type a schema PRODUCES (post-parse): the validated shape `execute()` hands the handler. */
  export type InferOutput<Schema extends StandardSchemaV1> = NonNullable<
    Schema["~standard"]["types"]
  >["output"];
}

/**
 * Run a schema's Standard-Schema validation and `await` it (the spec allows a sync OR async validator, so the
 * engine always awaits — a sync vendor just resolves immediately). Returns the spec's own `Result` union;
 * callers branch on `issues`. This is the ONE place the engine touches `['~standard']`; `execute()` and
 * `executeStream()` go through here so the validation entry point lives in a single, greppable spot.
 */
export function validateStandard<Output>(
  schema: StandardSchemaV1<unknown, Output>,
  value: unknown,
): Promise<StandardSchemaV1.Result<Output>> {
  return Promise.resolve(schema["~standard"].validate(value));
}
