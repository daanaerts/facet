export { type BuildContextOpts, buildContext } from "./build-context";
export type { CapabilityDef, Risk } from "./capability";
export type { Actor, Context } from "./context";
export { describeActor } from "./context";
export { type CapabilitySpec, defineCapability } from "./define";
export {
  defineStreamingCapability,
  type StreamingCapabilitySpec,
} from "./define-streaming";
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
export { executeStream } from "./execute-stream";
export { type JsonSchema, toJsonSchema } from "./json-schema";
export type { Ledger } from "./ledger";
export { Registry } from "./registry";
export { SURFACES, type SurfaceKind } from "./surface";
