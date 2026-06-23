export type { CapabilityDef, Risk } from "./capability";
export type { Actor, Context } from "./context";
export { describeActor } from "./context";
export { type CapabilitySpec, defineCapability } from "./define";
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
export type { Ledger } from "./ledger";
export { Registry } from "./registry";
export { SURFACES, type SurfaceKind } from "./surface";
