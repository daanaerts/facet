import type { ContextFor as AgentContextFor } from "@facet/agent";
import type { Actor, Context, Registry } from "@facet/core";
import type { Authenticate } from "@facet/http";
import type { ContextFor as McpContextFor } from "@facet/mcp";
import type { AuthParts } from "@facet/surface-kit";

/**
 * @facet/parity — the GENERIC cross-surface harness. Where the old harness lived in `examples/todo/tests`
 * and hard-wired the todo registry + the todo host seams, this package is parameterized over a `ParityHosts`
 * bundle: hand it a registry factory and the per-surface host seams, and it drives ANY capability through the
 * raw `execute()` baseline AND all four surfaces, normalizing each to one shared shape so a parity test can
 * assert they AGREE. It is a TEST HARNESS, not a surface — so, unlike the four surface packages, it MAY call
 * `execute()` / `executeStream()` directly: that is exactly the `viaExecute` baseline leg the surfaces are
 * compared against (the ground truth the four projections must match). The surface-purity tripwire only scans
 * the four surface dirs; this package is outside its remit by design.
 */

/**
 * The normalized outcome of invoking a UNARY capability on one leg. Exactly one of `output` / `errorCode` is
 * set: a leg either produced a validated capability output or refused with a translated `FacetError` code.
 * This is the spine-free `SurfaceResult` the todo example's old hand-rolled harness used (now subsumed here) —
 * there is no tenant, no surface label, nothing but "what came back", which is what lets every leg be compared
 * as one shape.
 */
export interface SurfaceResult {
  /** The capability output JSON when the call succeeded. */
  output?: Record<string, unknown>;
  /** The translated `FacetError` code when the leg refused (e.g. `"confirmation_required"`). */
  errorCode?: string;
}

/**
 * The normalized outcome of invoking a STREAMING capability on one leg. A stream is compared as TWO things:
 *
 *   - `chunks` — the ORDERED sequence of validated incremental chunks the leg emitted, in production order.
 *   - its TERMINATION — exactly one of `result` (the validated final value, a clean completion) or
 *     `errorCode` (a mid-stream `FacetError` code, a failed termination).
 *
 * Splitting "the chunks so far" from "how it ended" is the whole point of the mid-stream-error contract: two
 * surfaces are in parity iff they emit the same K chunks AND end the same way (both with the same final, or
 * both with the same error code). A surface that silently truncated would show fewer chunks and neither a
 * `result` nor an `errorCode`; this shape makes that a visible mismatch rather than a quiet pass.
 */
export interface StreamResult {
  /** The ordered, validated chunks the leg emitted before it terminated. */
  chunks: unknown[];
  /** The validated final value when the stream completed cleanly. Mutually exclusive with `errorCode`. */
  result?: unknown;
  /** The `FacetError` code when the stream FAILED mid-flight. Mutually exclusive with `result`. */
  errorCode?: string;
}

/** What every driver needs to shape the call — the same confirm/key the Context carries on any surface. */
export interface CallOpts {
  /** Surface-supplied confirmation for the core's write/destructive gate. */
  confirm?: boolean;
  /** Optional idempotency key for a retried write. */
  idempotencyKey?: string;
}

/**
 * The host seams a parity run is parameterized over — the framework's whole "you bring the spine" contribution,
 * one entry per leg. The harness owns NONE of these: a caller supplies a registry factory plus the exact
 * per-surface seam each surface package already asks for, so the drivers stay generic over any domain (todo,
 * logs, a fresh fixture) and any host policy.
 *
 * `registry` is a FACTORY, not a value: every surface builds its OWN registry instance (the surfaces share
 * only their domain's module state, e.g. an in-memory store), and a parity test resets that state per leg, so
 * each driver call must mint a fresh registry over the same world. The five seams below are precisely the
 * authenticators the five legs need — note they are the SAME types the surface packages export, so a host
 * already wired for the surfaces drops in here unchanged.
 */
export interface ParityHosts {
  /** Mint a fresh registry over the (shared) domain world — called once per leg. */
  registry: () => Registry;
  /**
   * The raw-`execute()` baseline's Context. The baseline has no surface to derive an actor/scopes from, so the
   * host hands the Context directly — the ground-truth principal the four surfaces' seams must mirror. Built
   * per call so `confirm` / `idempotencyKey` can be folded in (see {@link buildExecuteContext}).
   */
  executeContextFor: (opts: CallOpts) => Context;
  // Every surface seam below returns the SAME shared `{ actor, scopes, ledger? }` (`AuthParts`) and the SURFACE
  // builds the Context — the one host-seam contract. The only difference is the ARGUMENT each transport hands.
  /** The HTTP surface's `authenticate(headers)` seam. */
  authenticate: Authenticate;
  /** The CLI surface's `contextFor(actor)` seam — the parsed `--actor` → the shared `AuthParts`. */
  cliContextFor: (actor: Actor) => AuthParts | Promise<AuthParts>;
  /** The MCP surface's `contextFor({ id })` seam — the dispatched capability id → the shared `AuthParts`. */
  mcpContextFor: McpContextFor;
  /** The agent surface's `contextFor(id)` seam — a capability id → the shared `AuthParts`. */
  agentContextFor: AgentContextFor;
}
