import {
  type Context,
  execute,
  executeStream,
  FacetError,
  NotFoundError,
  type Registry,
} from "@facet/core";
import { type AuthParts, contextFromParts, splitContextFields } from "@facet/surface-kit";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
  type ServerNotification,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { capabilityId, toolFor } from "./tool";

/**
 * The MCP surface — the registry projected onto a Model Context Protocol server, written ONCE and run over
 * every capability. Its tool list is exactly the capabilities that declare the `mcp` surface
 * (`registry.forSurface("mcp")`); a new `*.cap.ts` with `surfaces.includes("mcp")` lights up as a tool with
 * zero per-surface code.
 *
 * The surface's ONLY job, exactly as on HTTP and CLI, is to establish a Context and translate errors. Each
 * tool's handler reads the injected `confirm`/`idempotencyKey` fields off the arguments, asks the host for a
 * Context (with `surface: "mcp"`), and calls the same `execute()` chokepoint every other surface flows
 * through. Every invariant — input validation, scope authz, the confirmation gate, idempotency dedup, audit,
 * kill-switch — lives in `@facet/core`; this server re-implements none of them. A `FacetError` becomes an
 * `isError` tool result carrying the same `{ code, message }`, so an agent sees the same typed failure the
 * CLI and HTTP surfaces do.
 *
 * CARVE NOTE: Moral Fabric's MCP server was scoped to ONE tenant — it read tenancy/scopes/installs out of a
 * db via the spine's `createContext({ db, principal, tenant, … })`, filtered the tool list through
 * `visibleCapabilities` (per-tenant install-gating), and closed the tenant over the server so no tool
 * argument could change it. Facet has no spine: the host supplies a single `contextFor(meta)` — the seam
 * where a real app authenticates and decides scopes — that returns the Context this surface needs. A
 * multi-tenant host folds its tenant into the `scopes` and the idempotency key INSIDE `contextFor` (and may
 * close the tenant over it, just as MF did), exactly as the carve requires; this surface never learns what a
 * tenant is, and there is no install-gating in the framework.
 */

/**
 * What the MCP server hands a host's `contextFor`: just the capability id being dispatched, in case the host
 * varies its grant by capability. The per-call `confirm` / `idempotencyKey` are NOT here — the surface reads
 * them off the tool arguments itself (`splitContextFields`) and injects them when it builds the Context, so
 * the host only ever decides "who + what may they do".
 */
export interface ToolContext {
  /** The capability id being dispatched (dotted form), in case the host scopes its grant by capability. */
  id: string;
}

/**
 * The host-supplied authenticator for the MCP surface — the same {@link AuthParts} seam every Facet surface
 * uses. It returns "who is calling + what may they do" (`{ actor, scopes, ledger? }`); the SURFACE turns that
 * into a Context (adding `surface: "mcp"` + the per-call confirm/key it split off the arguments) via
 * `contextFromParts`. It may be sync or async. There is deliberately no tenant/db/install/appId: a
 * multi-tenant host folds its tenant into the `scopes` (and the idempotency key) before returning.
 */
export type ContextFor = (meta: ToolContext) => AuthParts | Promise<AuthParts>;

/** Options shared by the dispatch helper and the server: the host's `contextFor` seam. */
export interface McpOptions {
  contextFor: ContextFor;
}

/**
 * The per-call progress channel the server hands `dispatchTool` so a STREAMING capability can emit MCP
 * progress notifications. It is the SDK's own mechanism, lifted off the request handler's `extra`:
 *
 *   - `progressToken` — the opaque token the CLIENT attached to its `tools/call` request when (and only
 *     when) it passed an `onprogress` callback. Absent ⇒ the client did not ask for progress, so the server
 *     must NOT stream notifications (it has nowhere to address them) and instead drains to the final result.
 *   - `sendNotification` — `extra.sendNotification`, which routes a `notifications/progress` back on the
 *     same request so the client's `onprogress` fires for it.
 *
 * A streaming capability's chunks do not fit MCP's numeric `Progress` shape, so each chunk rides as JSON in
 * the notification's `message`; `progress` carries the 1-based chunk count (it must strictly increase). The
 * validated final value is returned as the tool result's `structuredContent`, exactly like a unary call.
 */
export interface ToolProgress {
  progressToken: string | number;
  sendNotification: (n: ServerNotification) => Promise<void>;
}

/** Whether a capability projects onto the mcp surface: it is enabled and declares `mcp`. */
function servesMcp(def: { enabled: boolean; surfaces: string[] }): boolean {
  return def.enabled && def.surfaces.includes("mcp");
}

/**
 * The capabilities this registry serves on MCP, each projected to a tool. Written once over the registry —
 * `forSurface("mcp")` already filters to enabled + mcp-declaring capabilities, so a new mcp capability
 * appears here automatically.
 */
export function mcpTools(registry: Registry): Tool[] {
  return registry.forSurface("mcp").map(toolFor);
}

/**
 * Wrap a thrown value as an `isError` tool result carrying the `FacetError` `{ code, message }` as JSON in
 * `content` — and DELIBERATELY without `structuredContent`. A tool that declares an `outputSchema` (every
 * Facet tool does — `toolFor` emits the capability's output schema) makes the SDK `Client` validate any
 * `structuredContent` it receives against THAT schema, even on an error result. The error body
 * (`{ code, message }`) is not a valid capability output, so attaching it as `structuredContent` would make
 * the client throw `-32602` and SWALLOW the typed error — the agent would never see `confirmation_required`,
 * and the whole propose→confirm flow would break the moment a client has listed the tools. The SDK
 * explicitly permits an error result to omit `structuredContent`; the `{ code, message }` rides in the JSON
 * text instead, exactly where a client reads a tool error. (apps-demo set `structuredContent` here and had
 * this latent bug; its tests never listed tools before an error call, so it stayed hidden.)
 */
function toErrorResult(err: unknown): CallToolResult {
  const body =
    err instanceof FacetError
      ? { code: err.code, message: err.message }
      : { code: "internal", message: err instanceof Error ? err.message : "internal error" };
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(body) }],
  };
}

/**
 * Run a STREAMING capability and emit one MCP `notifications/progress` per validated chunk, returning the
 * validated final value as `structuredContent` — the MCP projection of the core's `executeStream()` contract.
 *
 * MCP's real progress mechanism is used (NOT a drained final dressed up as one): for each chunk produced we
 * call `progress.sendNotification` with a `notifications/progress` addressed to the client's `progressToken`,
 * so the client's `onprogress` callback fires for every chunk as it is produced. A chunk is a structured
 * object, which does not fit MCP's numeric `Progress` shape, so the chunk rides as JSON in `message` while
 * `progress` carries its strictly-increasing 1-based index. When the generator returns, its validated final
 * is the tool result's `structuredContent`, identical to a unary call — so a client that ignored the
 * progress notifications still gets the same terminal value.
 *
 * This path is taken only when the client requested progress (a `progressToken` is present). Without one the
 * caller falls back to `execute()`, which drains the same stream to the same final — there is simply nowhere
 * to address per-chunk notifications, so emitting them would be undeliverable.
 *
 * MID-STREAM FAILURE (see `docs/STREAMING-CONTRACT.md`): if `executeStream()` throws AFTER K chunks (a bad
 * chunk or a handler throw), the K `notifications/progress` have already gone out and cannot be recalled. The
 * throw is NOT caught here — it propagates to `dispatchTool`'s `catch`, which returns `toErrorResult(err)`: an
 * `isError` result carrying `{ code, message }` in `content` text and DELIBERATELY no `structuredContent`,
 * byte-for-byte the same shape as a unary MCP error (the error body is not a valid capability output, so it
 * must not ride as `structuredContent` against the tool's `outputSchema`). The core guarantees a `FacetError`.
 */
async function runStreamingTool(
  registry: Registry,
  id: string,
  input: Record<string, unknown>,
  ctx: Context,
  progress: ToolProgress,
): Promise<CallToolResult> {
  const gen = executeStream(registry, id, input, ctx);
  let count = 0;
  let step = await gen.next();
  while (!step.done) {
    count += 1;
    await progress.sendNotification({
      method: "notifications/progress",
      params: {
        progressToken: progress.progressToken,
        progress: count,
        // The chunk itself — JSON-encoded, since a Progress notification carries only numbers + a string.
        message: JSON.stringify(step.value),
      },
    });
    step = await gen.next();
  }
  const final = step.value;
  return {
    content: [{ type: "text", text: JSON.stringify(final) }],
    structuredContent: final as CallToolResult["structuredContent"],
  };
}

/**
 * The generic tool dispatch — one function, every tool. It maps the wire name back to a capability id
 * (`__` → `.`), refuses anything not served on MCP BEFORE forming a Context (so an unknown/non-mcp tool is a
 * clean not-found rather than a confusing authz failure), reads the injected `confirm`/`idempotencyKey` off
 * the arguments, asks the host for a Context, and runs `execute()`. Success returns `{ structuredContent }`
 * (the capability output, machine-readable per the tool's `outputSchema`, with a JSON text mirror for
 * clients that only read `content`); a `FacetError` returns an `isError` result carrying `{ code, message }`.
 *
 * STREAMING (additive): when the capability streams AND the client requested progress (it passed an
 * `onprogress` callback, so a `progressToken` rides on the call), the optional `progress` channel drives
 * `runStreamingTool`, which emits one `notifications/progress` per chunk and returns the final as
 * `structuredContent`. Absent a token (or for a non-streaming capability) it falls through to `execute()`,
 * which drains a streaming capability to the same final — so a client that did not ask for progress still
 * gets the terminal value.
 *
 * Validation, authz, confirmation and idempotency all happen inside the core — never here.
 */
export async function dispatchTool(
  registry: Registry,
  name: string,
  args: Record<string, unknown> | undefined,
  opts: McpOptions,
  progress?: ToolProgress,
): Promise<CallToolResult> {
  // The wire name maps `.` → `__` for the Anthropic regex (see tool.ts); reverse it to look the cap up.
  const id = capabilityId(name);
  const def = registry.get(id);
  if (!def || !servesMcp(def)) {
    return toErrorResult(new NotFoundError(`capability not found: ${id}`, { id }));
  }

  const { input, confirm, idempotencyKey } = splitContextFields(args);
  try {
    const parts = await opts.contextFor({ id });
    const ctx = contextFromParts(parts, { surface: "mcp", confirm, idempotencyKey });
    // A streaming capability with a client-supplied progress token streams real progress notifications; any
    // other case (non-streaming, or no token to address) drains through `execute()` to the validated final.
    if (def.stream && progress) {
      return await runStreamingTool(registry, id, input, ctx, progress);
    }
    const out = await execute(registry, id, input, ctx);
    return {
      content: [{ type: "text", text: JSON.stringify(out) }],
      structuredContent: out as CallToolResult["structuredContent"],
    };
  } catch (err) {
    return toErrorResult(err);
  }
}

/**
 * Build an MCP `Server` over a registry. The tool list is the registry's mcp projection; `tools/call` runs
 * the generic `dispatchTool`. The server is the transport wiring only — `ListTools` → `mcpTools`,
 * `CallTool` → `dispatchTool` — so it shares the exact dispatch path with anyone calling `dispatchTool`
 * directly (e.g. a parity harness). The host supplies `contextFor`; the surface adds nothing else.
 *
 * The returned `Server` is not yet bound to a transport — the caller connects it (an in-memory pair in
 * tests, a `StdioServerTransport` for human play, see `examples/logs/mcp.ts`).
 */
export function createMcpServer(registry: Registry, opts: McpOptions): Server {
  const server = new Server(
    { name: "facet-mcp", version: "0.0.0" },
    {
      capabilities: { tools: {} },
      instructions:
        "Facet capabilities, one tool per capability; its input is its schema. Write/destructive tools " +
        "require confirm: true (call once to preview the confirmation_required error, then re-call with " +
        "confirm: true). Pass idempotencyKey to make a write safely retryable.",
    },
  );

  // tools/list — the registry's mcp projection, written once. A new mcp capability appears automatically.
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: mcpTools(registry) }));

  // tools/call — the generic dispatch. One handler, every tool: establish the Context, call execute(). For a
  // streaming capability we also hand `dispatchTool` a progress channel built from the request's `extra`:
  // `_meta.progressToken` (present iff the client passed an `onprogress` callback) plus `sendNotification`
  // (which routes a `notifications/progress` back on this request). With no token the dispatch drains to the
  // final instead — there is nowhere to deliver per-chunk notifications.
  server.setRequestHandler(CallToolRequestSchema, async (req, extra): Promise<CallToolResult> => {
    const progressToken = extra._meta?.progressToken;
    const progress =
      progressToken !== undefined
        ? { progressToken, sendNotification: extra.sendNotification }
        : undefined;
    return dispatchTool(registry, req.params.name, req.params.arguments, opts, progress);
  });

  return server;
}
