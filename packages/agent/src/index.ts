import {
  type CapabilityDef,
  execute,
  executeStream,
  FacetError,
  type JsonSchema,
  type Registry,
  type Risk,
} from "@facet/core";
import {
  type AuthParts,
  capabilityId,
  contextFromParts,
  mergeContextFields,
  splitContextFields,
  toolName,
} from "@facet/surface-kit";

/**
 * @facet/agent — the in-app copilot's toolset, projected from the Registry. This is Facet's PRIMARY surface
 * (`SURFACES[0]`): the thesis is that an agent is the first-class consumer of a capability, and the human
 * surfaces (`http`, `cli`) and the machine surface (`mcp`, for *other* agents) are projections of the same
 * contract. So this surface is the cleanest expression of the whole idea — and it is the shortest, because an
 * in-app agent runs IN PROCESS: there is no transport, no wire, no JSON-RPC. The agent's tool-call lands here,
 * we build a Context and call `execute()`, and that is the entire surface.
 *
 * There is deliberately NO `@anthropic-ai/sdk` dependency. The LLM is the HOST's driver — the host owns the
 * model, the system prompt, the message loop. This package hands that driver two things and nothing more:
 *
 *   - `agentToolset(registry)` — the tool specs to advertise to the model (one per `agent`-surface
 *     capability), and
 *   - `dispatchToolCall(registry, call, { contextFor })` — the function the driver calls when the model emits
 *     a tool call, which runs that call through the one chokepoint every surface shares.
 *
 * The agent-native thesis falls out of `agentToolset` + `execute()` with no extra machinery: a write tool
 * carries a `confirm` boolean in its schema (merged in by `@facet/surface-kit` `mergeContextFields`, the SAME
 * mechanism the MCP surface uses), calling it without `confirm` throws `ConfirmationRequiredError`, and the
 * driver surfaces that to the human and re-calls with `confirm: true`. The propose→confirm handshake is
 * MODELLED IN THE SCHEMA, not coded in the surface.
 *
 * Like every Facet surface, this one validates nothing and authorizes nothing: input validation, scope authz,
 * the confirmation gate, idempotency dedup, audit and the kill-switch all live in `@facet/core` `execute()`.
 * It re-implements no check; it only NAMES the tools (via `mergeContextFields`), peels the surface fields off a
 * call (`splitContextFields`), and TRANSLATES a thrown FacetError into an `errorCode` the driver can act on.
 *
 * CARVE NOTE: this surface takes only spine-free parts. `contextFor` returns the host's `{ actor, scopes,
 * ledger? }` (the shared {@link AuthParts}) — no tenant, install, db or appId. A multi-tenant host folds its
 * tenant into `scopes` and the idempotency key inside `contextFor`; the framework never learns what a tenant is.
 */

/**
 * One agent tool, projected from one capability.
 *
 * The `name` keeps the capability's dotted id UNCHANGED. An in-process agent never forwards these names into
 * an Anthropic `messages.tools` array (that is the `mcp` surface's job, and it is the one that mangles `.` →
 * `__` to satisfy the `^[a-zA-Z0-9_-]{1,64}$` tool-name regex). The driver here calls `dispatchToolCall` with
 * the same dotted name it advertised, so there is nothing to mangle and the id stays legible.
 *
 * The `inputSchema` is the capability's own input emitted as JSON Schema with the two Context-shaping fields
 * merged in (`mergeContextFields`); `risk` is surfaced verbatim so a driver can render the right affordance
 * (auto-run a read, draw a confirm step for a write/destructive).
 */
export interface AgentTool {
  /** The capability id, dotted and unchanged — the name to call `dispatchToolCall` with in-process. */
  name: string;
  /**
   * The Anthropic-regex-safe wire name (dots → `__`). Advertise THIS as the tool name to the real Messages
   * API (a dotted name is a 400). The model emits it on a `tool_use`, and `dispatchToolCall` / `streamToolCall`
   * accept it back (mapping it to the capability id), so a host driving a live LLM needs no name glue.
   */
  wireName: string;
  /** The capability summary — the tool description the model reads. */
  description: string;
  /** The capability input as JSON Schema, with `confirm`/`idempotencyKey` merged in where they apply. */
  inputSchema: JsonSchema;
  /** The capability's threat model, surfaced so a driver renders the right affordance. */
  risk: Risk;
  /**
   * OPTIONAL reversibility signal, surfaced alongside `risk` (additive): `true` ⇒ recoverable (archive,
   * capture-then-refund), `false` ⇒ permanent (hard delete, merge), omitted ⇒ unspecified. A driver calibrates
   * its confirmation copy from it — "move to trash" reads very differently from "permanently delete" — even
   * though both are `risk: "destructive"`. Absent on the tool when the capability never declared it.
   */
  reversible?: boolean;
}

/** A tool call as the host's LLM driver emits it: the advertised tool name plus the model's arguments. */
export interface ToolCall {
  name: string;
  arguments?: Record<string, unknown>;
}

/**
 * The host's per-call authenticator — the same {@link AuthParts} seam every Facet surface uses. It is handed
 * the capability `id` (so a host MAY vary scopes by capability; most hosts ignore it and return a fixed grant)
 * and returns ONLY `{ actor, scopes, ledger? }`. `dispatchToolCall` adds `surface: "agent"` and the per-call
 * `confirm` / `idempotencyKey` it split off the arguments, via `contextFromParts`. There is deliberately no
 * tenant/install/db here — a multi-tenant host folds its tenant into `scopes` inside this function. Sync or async.
 */
export type ContextFor = (id: string) => AuthParts | Promise<AuthParts>;

/** Options for {@link dispatchToolCall}, {@link streamToolCall} and {@link simulateAgentRun}. */
export interface DispatchOpts {
  contextFor: ContextFor;
}

/**
 * The result of dispatching a tool call: the capability output on success, or the translated FacetError on
 * refusal. The error carries the CODE *and the MESSAGE* (and any `data`) — because when you feed a tool
 * failure back to an LLM, the message ("missing required scope: inbox:admin", "thread not found: thr_9") is
 * the part the model needs to adapt; the code alone is not actionable.
 */
export type DispatchResult =
  | { output: unknown; errorCode?: undefined; errorMessage?: undefined; errorData?: undefined }
  | { output?: undefined; errorCode: string; errorMessage: string; errorData?: unknown };

/**
 * The toolset the host advertises to its LLM driver: one {@link AgentTool} per ENABLED capability that
 * declares the `agent` surface. A new `*.cap.ts` whose `surfaces` includes `"agent"` becomes a tool the moment
 * it lands in the registry — this is one projection, not a hand-kept list. The toolset is exactly the agent's
 * reach: it can call these capabilities and no others, which is the whole carve.
 */
export function agentToolset(registry: Registry): AgentTool[] {
  return registry.forSurface("agent").map(toolFor);
}

/** Build the agent tool for one capability: the dotted id, the summary, and the merged input schema + risk. */
function toolFor(def: CapabilityDef): AgentTool {
  return {
    name: def.id,
    wireName: toolName(def.id),
    description: def.summary,
    inputSchema: mergeContextFields(def),
    risk: def.risk,
    // Additive: carried through verbatim; `undefined` stays `undefined` (unspecified), the engine reads it not.
    reversible: def.reversible,
  };
}

/**
 * Resolve a tool-call name to a capability id, accepting EITHER the dotted id (what an in-process driver uses)
 * OR the `__` wire name (what a real Anthropic loop emits — a dotted name is invalid there). Capability ids
 * never contain `__`, so an unknown dotted name maps to itself and falls through to a clean not_found; there is
 * no ambiguity. This is what lets a host advertise `tool.wireName` and hand the model's reply straight back.
 */
function resolveId(registry: Registry, name: string): string {
  return registry.has(name) ? name : capabilityId(name);
}

/**
 * Dispatch ONE tool call — the exact path an in-app agent's tool-call takes. This is the entire surface:
 *
 *   1. split the surface fields (`confirm`, `idempotencyKey`) off the model's arguments (`splitContextFields`);
 *   2. ask the host's `contextFor` who is acting (the {@link AuthParts}: actor + scopes + optional ledger);
 *   3. `contextFromParts` with `surface: "agent"` and the per-call confirm/idempotency;
 *   4. `execute()` — the one chokepoint that validates, authorizes, confirms, dedupes, audits and runs;
 *   5. return `{ output }` on success, or `{ errorCode }` carrying a thrown FacetError's `code`.
 *
 * Returning the FacetError as an `errorCode` rather than rethrowing is what makes the propose→confirm loop fall
 * out for free: a write called without `confirm` comes back `{ errorCode: "confirmation_required" }`, the
 * driver shows the human the proposed action, and re-dispatches the same call with `confirm: true`. The surface
 * translates the error; it does not decide the policy — `execute()` did. A non-FacetError (a real handler bug)
 * surfaces as `"internal"`, the same neutral code the other surfaces use.
 */
export async function dispatchToolCall(
  registry: Registry,
  call: ToolCall,
  opts: DispatchOpts,
): Promise<DispatchResult> {
  const id = resolveId(registry, call.name);
  const { input, confirm, idempotencyKey } = splitContextFields(call.arguments);
  try {
    const parts = await opts.contextFor(id);
    const ctx = contextFromParts(parts, { surface: "agent", confirm, idempotencyKey });
    const output = await execute(registry, id, input, ctx);
    return { output };
  } catch (err) {
    if (err instanceof FacetError) {
      return { errorCode: err.code, errorMessage: err.message, errorData: err.data };
    }
    throw err;
  }
}

/**
 * Stream ONE tool call — the agent-primary projection of a STREAMING capability, made concrete. Where
 * {@link dispatchToolCall} runs a capability to a single value, this drives the capability's async generator
 * and re-yields its validated chunks AS THEY ARE PRODUCED, then returns the validated final. An in-app copilot
 * renders the chunks incrementally (a live log tail, a token-by-token answer) and shows the final when the
 * generator returns — no transport, no wire, just one in-process generator handed to the next.
 *
 * It is the same surface contract as the unary path — split the surface fields, ask `contextFor` for the
 * {@link AuthParts}, `contextFromParts` with `surface: "agent"` — then delegate to the core's `executeStream()`,
 * which runs the read gates before a single chunk escapes and validates every chunk and the final.
 *
 * Unlike `dispatchToolCall`, a thrown `FacetError` is NOT translated to an `errorCode` here — a stream that is
 * refused (unknown id, missing scope, non-streaming capability, invalid input) or that fails mid-stream throws
 * out of the generator (after any chunks already yielded), exactly as `executeStream` does, so the driver sees
 * the typed failure in its `for await`. (A driver that wants the unary `{ errorCode }` shape for a refusal
 * calls `dispatchToolCall` instead.) `confirm`/`idempotencyKey` are still split off for symmetry, but a
 * streaming capability is a read, so they never gate it.
 */
export async function* streamToolCall<C = unknown, F = unknown>(
  registry: Registry,
  call: ToolCall,
  opts: DispatchOpts,
): AsyncGenerator<C, F, void> {
  const id = resolveId(registry, call.name);
  const { input, confirm, idempotencyKey } = splitContextFields(call.arguments);
  const parts = await opts.contextFor(id);
  const ctx = contextFromParts(parts, { surface: "agent", confirm, idempotencyKey });
  // `yield*` re-yields every chunk the core produces and adopts the generator's RETURN as this generator's
  // return — so the chunks and the final both flow through unchanged, each already validated by the core.
  return yield* executeStream<C, F>(registry, id, input, ctx);
}

/** One step of a scripted agent run: a tool call paired with the {@link DispatchResult} it produced. */
export interface AgentStep {
  call: ToolCall;
  result: DispatchResult;
}

/**
 * Run a scripted list of tool calls through {@link dispatchToolCall}, modelling the in-app agent's loop WITHOUT
 * a live LLM. Each script entry is dispatched in order and the call+result is recorded, so a demo (or a test)
 * can exercise the whole surface — including the propose→confirm handshake — by handing in the very calls a
 * model would emit: e.g. `jobs.start` with no `confirm` (→ `confirmation_required`) followed by the same call
 * with `confirm: true` (→ output). It adds no behaviour the driver would not get from `dispatchToolCall` itself.
 */
export async function simulateAgentRun(
  registry: Registry,
  script: ToolCall[],
  opts: DispatchOpts,
): Promise<AgentStep[]> {
  const steps: AgentStep[] = [];
  for (const call of script) {
    const result = await dispatchToolCall(registry, call, opts);
    steps.push({ call, result });
  }
  return steps;
}
