import { dispatchToolCall } from "@facet/agent";
import { runCli, type WriterSink } from "@facet/cli";
import { createHttpApp } from "@facet/http";
import { createMcpServer, toolName } from "@facet/mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { devAgentContextFor, devAuthenticate, devCliContextFor, devMcpContextFor } from "../host";
import { todoRegistry } from "../registry";

/**
 * The four surface drivers, each normalizing one Facet entry point into a single `SurfaceResult` so the
 * parity test asserts over a uniform shape. Every driver does exactly what a real consumer of that surface
 * does — let the surface establish a Context from its host seam and call the capability — and nothing more:
 * all authz / validation / confirmation / idempotency stay in `@facet/core` `execute()`. The ONLY difference
 * a driver introduces is the surface label, which is the whole point of the parity proof.
 *
 * CARVE NOTE: this is the apps-demo `parity/surfaces.ts` shape ported SPINE-FREE. There is no tenant, no db,
 * no PGlite directory and no subprocess: the CLI leg runs IN-PROCESS via `runCli` with capturing sinks (the
 * surface is unit-testable without spawning), and the store is in-memory, so every leg shares the one process.
 * The drivers therefore prove cross-surface parity over a bare, spine-free engine.
 */

/** The normalized outcome of invoking a capability on one surface. */
export interface SurfaceResult {
  /** The capability output JSON when the call succeeded. */
  output?: Record<string, unknown>;
  /** The translated `FacetError` code when the surface refused (e.g. `"confirmation_required"`). */
  errorCode?: string;
}

/** What every driver needs to shape the call — the same confirm/key the Context carries. */
export interface CallOpts {
  /** Surface-supplied confirmation for the core's write/destructive gate. */
  confirm?: boolean;
  /** Optional idempotency key for a retried write. */
  idempotencyKey?: string;
}

/**
 * agent — exactly how the in-app copilot runs a capability: hand `dispatchToolCall` the tool call (with the
 * surface fields merged into the arguments) and the host's `contextFor`. It builds a `surface: "agent"`
 * Context and calls `execute()` straight — no transport at all. This is the baseline the other three surfaces
 * are compared against. `dispatchToolCall` already returns the normalized `{ output } | { errorCode }`.
 */
export async function viaAgent(
  id: string,
  input: Record<string, unknown>,
  opts: CallOpts = {},
): Promise<SurfaceResult> {
  const args: Record<string, unknown> = { ...input };
  if (opts.confirm) args.confirm = true;
  if (opts.idempotencyKey) args.idempotencyKey = opts.idempotencyKey;

  const result = await dispatchToolCall(
    todoRegistry(),
    { name: id, arguments: args },
    { contextFor: devAgentContextFor() },
  );
  if (result.errorCode !== undefined) return { errorCode: result.errorCode };
  return { output: result.output as Record<string, unknown> };
}

/**
 * cli — the CLI surface run IN-PROCESS via `runCli` with capturing sinks, the spine-free analogue of
 * apps-demo's subprocess leg. It builds the exact argv a human would type (`<id> --json <json> [--yes]
 * [--key <k>]`), captures stdout/stderr, and reads the result off them: a zero exit means stdout is the
 * pretty-printed JSON output; a non-zero exit means the surface refused, and the code is read off stderr's
 * `✗ <code>: <message>` line — the same translation a real terminal user would see.
 */
export async function viaCli(
  id: string,
  input: Record<string, unknown>,
  opts: CallOpts = {},
): Promise<SurfaceResult> {
  const argv = [id, "--json", JSON.stringify(input)];
  if (opts.confirm) argv.push("--yes");
  if (opts.idempotencyKey) argv.push("--key", opts.idempotencyKey);

  const outLines: string[] = [];
  const errLines: string[] = [];
  const sink: WriterSink = {
    out: (line) => outLines.push(line),
    err: (line) => errLines.push(line),
  };

  const code = await runCli(todoRegistry(), argv, { contextFor: devCliContextFor() }, sink);
  if (code !== 0) {
    const match = errLines.join("\n").match(/✗\s+(\w+):/);
    if (!match) {
      throw new Error(
        `CLI exited ${code} without a FacetError line. STDERR:\n${errLines.join("\n")}`,
      );
    }
    return { errorCode: match[1] };
  }
  return { output: JSON.parse(outLines.join("\n")) as Record<string, unknown> };
}

/**
 * http — the Elysia surface driven headlessly with `app.handle(new Request(...))` (no port, no fetch).
 * Confirm/key go in the branded `x-facet-*` headers; the body is the capability input verbatim. A 4xx/5xx
 * response carries the `{ code, message, data }` body, from which the error code is read.
 */
export async function viaHttp(
  id: string,
  input: Record<string, unknown>,
  opts: CallOpts = {},
): Promise<SurfaceResult> {
  const app = createHttpApp(todoRegistry(), { authenticate: devAuthenticate() });
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.confirm) headers["x-facet-confirm"] = "true";
  if (opts.idempotencyKey) headers["x-facet-idempotency-key"] = opts.idempotencyKey;

  const res = await app.handle(
    new Request(`http://localhost/cap/${id}`, {
      method: "POST",
      headers,
      body: JSON.stringify(input),
    }),
  );
  const json = (await res.json()) as Record<string, unknown>;
  if (res.status >= 400) return { errorCode: json.code as string };
  return { output: json };
}

/**
 * mcp — the Model Context Protocol surface driven by the SDK `Client` over an in-memory transport (the full
 * JSON-RPC handshake, in-process, no subprocess). Confirm/key ride as injected tool arguments (the
 * propose→confirm flow the surface merges into the schema). The capability id is mapped to its wire tool name
 * (dots → `__`, the Anthropic-regex-safe form the surface emits). An `isError` result carries the same
 * `{ code, message }` in its `content` text the other surfaces translate.
 */
export async function viaMcp(
  id: string,
  input: Record<string, unknown>,
  opts: CallOpts = {},
): Promise<SurfaceResult> {
  const server = createMcpServer(todoRegistry(), { contextFor: devMcpContextFor() });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "todo-parity", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const args: Record<string, unknown> = { ...input };
  if (opts.confirm) args.confirm = true;
  if (opts.idempotencyKey) args.idempotencyKey = opts.idempotencyKey;

  const res = await client.callTool({ name: toolName(id), arguments: args });
  await client.close();

  // The error body rides in `content` text (NOT structuredContent) on an error result — see @facet/mcp.
  if (res.isError) {
    const text = Array.isArray(res.content)
      ? (res.content[0] as { text?: string })?.text
      : undefined;
    const body = text ? (JSON.parse(text) as { code?: string }) : {};
    return { errorCode: body.code };
  }
  return { output: res.structuredContent as Record<string, unknown> };
}
