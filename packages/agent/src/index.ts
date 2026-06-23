import {
  buildContext,
  type CapabilityDef,
  type Context,
  execute,
  executeStream,
  FacetError,
  type JsonSchema,
  type Ledger,
  type Registry,
  type Risk,
  toJsonSchema,
} from "@facet/core";

/**
 * @facet/agent — the in-app copilot's toolset, projected from the Registry. This is Facet's PRIMARY surface
 * (`SURFACES[0]`): the thesis is that an agent is the first-class consumer of a capability, and the human
 * surfaces (`http`, `cli`) and the machine surface (`mcp`, for *other* agents) are projections of the same
 * contract. So this surface is the cleanest expression of the whole idea — and it is the shortest, because
 * an in-app agent runs IN PROCESS: there is no transport, no wire, no JSON-RPC. The agent's tool-call lands
 * here, we build a Context and call `execute()`, and that is the entire surface.
 *
 * There is deliberately NO `@anthropic-ai/sdk` dependency. The LLM is the HOST's driver — the host owns the
 * model, the system prompt, the message loop. This package hands that driver two things and nothing more:
 *
 *   - `agentToolset(registry)` — the tool specs to advertise to the model (one per `agent`-surface
 *     capability), and
 *   - `dispatchToolCall(registry, call, { contextFor })` — the function the driver calls when the model
 *     emits a tool call, which runs that call through the one chokepoint every surface shares.
 *
 * The agent-native thesis falls out of `agentToolset` + `execute()` with no extra machinery: a write tool
 * carries a `confirm` boolean in its schema, calling it without `confirm` throws `ConfirmationRequiredError`
 * ("confirmation_required"), and the driver surfaces that to the human and re-calls with `confirm: true`.
 * The propose→confirm handshake is MODELLED IN THE SCHEMA, not coded in the surface — that is the point.
 *
 * Like every Facet surface, this one validates nothing and authorizes nothing: input validation, scope
 * authz, the confirmation gate, idempotency dedup, audit and the kill-switch all live in `@facet/core`
 * `execute()`. This file only NAMES the tools, SHAPES their input, and TRANSLATES a thrown FacetError into
 * an `errorCode` the driver can act on. It re-implements no check.
 *
 * CARVE NOTE: this surface takes only spine-free parts. `contextFor` returns the host's `{ actor, scopes,
 * ledger? }` — there is no tenant, no install, no db and no appId. A multi-tenant host folds its tenant
 * into `scopes` and the idempotency key inside `contextFor`; the framework never learns what a tenant is.
 */

/** The field the surface merges into a write/destructive tool's input schema — the propose→confirm gate. */
export const CONFIRM_FIELD = "confirm";
/** The field the surface merges into a non-read tool's input schema — optional dedup key for a retry. */
export const IDEMPOTENCY_FIELD = "idempotencyKey";

/**
 * One agent tool, projected from one capability.
 *
 * The `name` keeps the capability's dotted id UNCHANGED. An in-process agent never forwards these names into
 * an Anthropic `messages.tools` array (that is the `mcp` surface's job, and it is the one that mangles `.` →
 * `__` to satisfy the `^[a-zA-Z0-9_-]{1,64}$` tool-name regex). The driver here calls `dispatchToolCall`
 * with the same dotted name it advertised, so there is nothing to mangle and the id stays legible.
 *
 * The `inputSchema` is the capability's own Zod input emitted as JSON Schema (the single schema dialect),
 * with the surface's two Context-shaping fields merged in (see `toolFor`). `risk` is surfaced verbatim so a
 * driver can render the right affordance (auto-run a read, draw a confirm step for a write/destructive).
 */
export interface AgentTool {
  /** The capability id, dotted and unchanged — in-process agents need no name mangling. */
  name: string;
  /** The capability summary — the tool description the model reads. */
  description: string;
  /** The capability input as JSON Schema, with `confirm`/`idempotencyKey` merged in where they apply. */
  inputSchema: JsonSchema;
  /** The capability's threat model, surfaced so a driver renders the right affordance. */
  risk: Risk;
}

/** A tool call as the host's LLM driver emits it: the advertised tool name plus the model's arguments. */
export interface ToolCall {
  name: string;
  arguments?: Record<string, unknown>;
}

/**
 * What the host supplies per tool call: turn the capability id being called into the spine-free Context
 * parts the agent surface needs — who is acting, what scopes they hold, and an optional idempotency ledger.
 * This is the agent surface's authenticator seam (the analogue of the HTTP surface's `authenticate`). It is
 * handed the `id` so a host MAY vary scopes by capability, but most hosts ignore it and return a fixed actor.
 *
 * It returns ONLY `{ actor, scopes, ledger? }`; `dispatchToolCall` adds `surface: "agent"` and the per-call
 * `confirm` / `idempotencyKey` it split off the arguments. There is deliberately no tenant/install/db here —
 * a multi-tenant host folds its tenant into `scopes` and the key inside this function. It may be sync or async.
 */
export type ContextParts = { actor: Context["actor"]; scopes: string[]; ledger?: Ledger };
export type ContextFor = (id: string) => ContextParts | Promise<ContextParts>;

/** Options for {@link dispatchToolCall} and {@link simulateAgentRun}: the host's per-call Context seam. */
export interface DispatchOpts {
  contextFor: ContextFor;
}

/** The result of dispatching a tool call: the capability output on success, or a translated error code. */
export type DispatchResult =
  | { output: unknown; errorCode?: undefined }
  | { output?: undefined; errorCode: string };

/** Whether the surface merges a `confirm` field for this capability — writes and destructive ops do. */
function needsConfirm(def: CapabilityDef): boolean {
  return def.risk !== "read";
}

/**
 * Build the agent tool for one capability. The `inputSchema` is the capability's input JSON Schema with the
 * surface's Context-shaping fields merged into its `properties`:
 *
 *   - `confirm` (boolean) — present and REQUIRED only on a write/destructive tool. This is the explicit
 *     "[Yes]" the core's confirmation invariant demands. Because it is part of the SCHEMA, an agent that
 *     calls a write tool without it gets `confirmation_required` straight out of `execute()` — the cue to
 *     surface the proposed action to the human and re-call with `confirm: true`. The handshake is in the
 *     contract, not in surface code.
 *   - `idempotencyKey` (string) — optional on any non-read tool; forwarded to the Context so a retried write
 *     dedupes in the chokepoint. Reads never carry it (they are already idempotent).
 *
 * Everything else is the capability's own input schema, untouched — the surface adds fields, it never edits
 * the author's contract.
 */
export function toolFor(def: CapabilityDef): AgentTool {
  const inputSchema = toJsonSchema(def.input, "input");
  const properties: Record<string, unknown> = {
    ...((inputSchema.properties as Record<string, unknown> | undefined) ?? {}),
  };
  const required = new Set<string>(
    Array.isArray(inputSchema.required) ? (inputSchema.required as string[]) : [],
  );

  if (needsConfirm(def)) {
    properties[CONFIRM_FIELD] = {
      type: "boolean",
      description: `Explicit confirmation for this ${def.risk} action. Call once without it to preview; the dispatch replies confirmation_required, then re-call with ${CONFIRM_FIELD}: true to run.`,
    };
    required.add(CONFIRM_FIELD);
  }

  if (def.risk !== "read") {
    properties[IDEMPOTENCY_FIELD] = {
      type: "string",
      description:
        "Optional idempotency key — re-sending the same key replays the first result instead of running again.",
    };
  }

  const merged: JsonSchema = { ...inputSchema, type: "object", properties };
  if (required.size > 0) merged.required = [...required];
  else delete merged.required;

  return {
    name: def.id,
    description: def.summary,
    inputSchema: merged,
    risk: def.risk,
  };
}

/**
 * The toolset the host advertises to its LLM driver: one {@link AgentTool} per ENABLED capability that
 * declares the `agent` surface. A new `*.cap.ts` whose `surfaces` includes `"agent"` becomes a tool the
 * moment it lands in the registry — this is one projection, not a hand-kept list. The toolset is exactly
 * the agent's reach: it can call these capabilities and no others, which is the whole carve.
 */
export function agentToolset(registry: Registry): AgentTool[] {
  return registry.forSurface("agent").map(toolFor);
}

/** The Context-shaping fields the surface peels off a tool call's arguments before forwarding to execute. */
interface CallMeta {
  /** The capability input — the tool arguments with the surface fields stripped off. */
  input: Record<string, unknown>;
  /** The surface-supplied confirmation for the core's write/destructive gate. */
  confirm: boolean;
  /** The optional idempotency key for a retried write. */
  idempotencyKey?: string;
}

/**
 * Split a tool call's raw arguments into the capability input plus the Context-shaping fields the surface
 * merged into the schema. `confirm` and `idempotencyKey` are peeled off; whatever remains is forwarded to
 * `execute()` verbatim, where the capability's own schema validates it — the surface never validates.
 */
function readCallMeta(args: Record<string, unknown> | undefined): CallMeta {
  const { [CONFIRM_FIELD]: confirm, [IDEMPOTENCY_FIELD]: key, ...input } = args ?? {};
  return {
    input,
    confirm: confirm === true,
    idempotencyKey: typeof key === "string" ? key : undefined,
  };
}

/**
 * Dispatch ONE tool call — the exact path an in-app agent's tool-call takes. This is the entire surface:
 *
 *   1. split the surface fields (`confirm`, `idempotencyKey`) off the model's arguments;
 *   2. ask the host's `contextFor` who is acting (actor + scopes + optional ledger) for this capability;
 *   3. `buildContext` with `surface: "agent"` and the per-call confirm/idempotency;
 *   4. `execute()` — the one chokepoint that validates, authorizes, confirms, dedupes, audits and runs;
 *   5. return `{ output }` on success, or `{ errorCode }` carrying a thrown FacetError's `code`.
 *
 * Returning the FacetError as an `errorCode` rather than rethrowing is what makes the propose→confirm loop
 * fall out for free: a write called without `confirm` comes back `{ errorCode: "confirmation_required" }`,
 * the driver shows the human the proposed action, and re-dispatches the same call with `confirm: true`. The
 * surface translates the error; it does not decide the policy — `execute()` did. A non-FacetError (a real
 * bug in a handler) surfaces as `"internal"`, the same neutral code the other surfaces use, so a driver
 * never has to parse a stack trace.
 */
export async function dispatchToolCall(
  registry: Registry,
  call: ToolCall,
  opts: DispatchOpts,
): Promise<DispatchResult> {
  const { input, confirm, idempotencyKey } = readCallMeta(call.arguments);
  try {
    const parts = await opts.contextFor(call.name);
    const ctx = buildContext({
      actor: parts.actor,
      scopes: parts.scopes,
      surface: "agent",
      confirm,
      idempotencyKey,
      ledger: parts.ledger,
    });
    const output = await execute(registry, call.name, input, ctx);
    return { output };
  } catch (err) {
    if (err instanceof FacetError) return { errorCode: err.code };
    throw err;
  }
}

/**
 * Stream ONE tool call — the agent-primary projection of a STREAMING capability, made concrete. Where
 * {@link dispatchToolCall} runs a capability to a single value, this drives the capability's async generator
 * and re-yields its validated chunks AS THEY ARE PRODUCED, then returns the validated final. An in-app
 * copilot renders the chunks incrementally (a live log tail, a token-by-token answer) and shows the final
 * when the generator returns — no transport, no wire, just one in-process generator handed to the next.
 *
 * It is the same surface contract as the unary path: split the surface fields off the arguments, ask the
 * host's `contextFor` for the spine-free Context parts, `buildContext` with `surface: "agent"`, then delegate
 * to the core's `executeStream()` — the SAME chokepoint, which runs the read gates (resolve → validate →
 * authz → audit) before a single chunk escapes and validates every chunk and the final. The surface
 * re-implements no check; it only re-exposes the core stream as the generator a driver consumes.
 *
 * Unlike `dispatchToolCall`, a thrown `FacetError` is NOT translated to an `errorCode` here — a stream that
 * is refused (an unknown id, a missing scope, a non-streaming capability, invalid input) throws out of the
 * generator on the FIRST pull, exactly as `executeStream` does, so the driver sees the typed failure before
 * it has rendered any chunk. (A driver that wants the unary `{ errorCode }` shape for a refusal simply calls
 * `dispatchToolCall` instead.) `confirm`/`idempotencyKey` are still split off the arguments for symmetry, but
 * a streaming capability is a read, so they never gate it.
 */
export async function* streamToolCall<C = unknown, F = unknown>(
  registry: Registry,
  call: ToolCall,
  opts: DispatchOpts,
): AsyncGenerator<C, F, void> {
  const { input, confirm, idempotencyKey } = readCallMeta(call.arguments);
  const parts = await opts.contextFor(call.name);
  const ctx = buildContext({
    actor: parts.actor,
    scopes: parts.scopes,
    surface: "agent",
    confirm,
    idempotencyKey,
    ledger: parts.ledger,
  });
  // `yield*` re-yields every chunk the core produces and adopts the generator's RETURN as this generator's
  // return — so the chunks and the final both flow through unchanged, each already validated by the core.
  return yield* executeStream<C, F>(registry, call.name, input, ctx);
}

/** One step of a scripted agent run: a tool call paired with the {@link DispatchResult} it produced. */
export interface AgentStep {
  call: ToolCall;
  result: DispatchResult;
}

/**
 * Run a scripted list of tool calls through {@link dispatchToolCall}, modelling the in-app agent's loop
 * WITHOUT a live LLM. Each script entry is dispatched in order and the call+result is recorded, so a demo
 * (or a test) can exercise the whole surface — including the propose→confirm handshake — by handing in the
 * very calls a model would emit: e.g. `jobs.start` with no `confirm` (→ `confirmation_required`) followed by
 * the same call with `confirm: true` (→ output). This is purely a convenience harness around the real
 * dispatch path; it adds no behaviour the driver would not get from calling `dispatchToolCall` itself.
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
