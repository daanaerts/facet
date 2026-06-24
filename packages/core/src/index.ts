export { type BuildContextOpts, buildContext } from "./build-context";
export type { CapabilityDef, CapabilityExample, Risk } from "./capability";
export { claimOf, requireClaim } from "./claims";
export type { Actor, Context } from "./context";
export { describeActor } from "./context";
export { type CapabilitySpec, defineCapability } from "./define";
export {
  defineStreamingCapability,
  type StreamingCapabilitySpec,
} from "./define-streaming";
export {
  type CapabilityDoc,
  describeCapability,
  type FieldDoc,
} from "./describe";
export { discoverCapabilities } from "./discover";
export {
  ConfirmationRequiredError,
  ConnectorUnavailableError,
  FacetError,
  type FacetErrorCode,
  KillSwitchError,
  NotFoundError,
  ScopeError,
  ValidationError,
} from "./errors";
export { execute } from "./execute";
export { collectStream, executeStream } from "./execute-stream";
export type { Ledger } from "./ledger";
export { Registry } from "./registry";
export {
  getSchemaAdapter,
  type JsonSchema,
  type SchemaAdapter,
  type SchemaIO,
  setSchemaAdapter,
  toJsonSchema,
  zodSchemaAdapter,
} from "./schema-adapter";
export type { StandardSchemaV1 } from "./standard-schema";
export { validateStandard } from "./standard-schema";
export { SURFACES, type SurfaceKind } from "./surface";
