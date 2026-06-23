import { dispatchToolCall } from "@facet/agent";
import { runCli, type WriterSink } from "@facet/cli";
import { execute, FacetError } from "@facet/core";
import { createFetchHandler } from "@facet/http";
import { createMcpServer, toolName } from "@facet/mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallOpts, ParityHosts, SurfaceResult } from "./types";

/**
 * The UNARY legs of the harness — the raw `execute()` baseline plus the four surface drivers — each
 * normalizing one entry point into a single {@link SurfaceResult}. Every driver does exactly what a real
 * consumer of that leg does (let the leg establish a Context and call the capability) and NOTHING more: all
 * authz / validation / confirmation / idempotency stay in `@facet/core` `execute()`. The only thing a driver
 * introduces is the leg label, which is the whole point of the parity proof.
 *
 * Generic over a {@link ParityHosts}: each driver mints a fresh registry from `hosts.registry()` and uses the
 * one seam its leg needs, so the same drivers run over any domain and any host policy.
 */

/**
 * viaExecute — the RAW `@facet/core` baseline, NO surface at all. This is the ground truth the four surfaces
 * are compared against: it builds a Context straight from the host's `executeContextFor` and calls `execute()`
 * directly, so it exercises the chokepoint with zero projection in the way. The four surfaces each ADD a
 * transport/translation layer on top of this exact call; if any of them drifts, it drifts AWAY from this leg.
 * (The old harness lacked this — the agent stood in as the baseline, so agent-surface drift was invisible.)
 *
 * A thrown `FacetError` is caught and normalized to `{ errorCode }`, exactly as every surface translates it;
 * any other throw is a real bug and propagates (it would be an `internal` on a surface, but the baseline lets
 * it surface raw so a genuine handler crash is never silently flattened into the parity comparison).
 */
export async function viaExecute(
  hosts: ParityHosts,
  id: string,
  input: Record<string, unknown>,
  opts: CallOpts = {},
): Promise<SurfaceResult> {
  const ctx = hosts.executeContextFor(opts);
  try {
    const output = await execute<Record<string, unknown>>(hosts.registry(), id, input, ctx);
    return { output };
  } catch (err) {
    if (err instanceof FacetError) return { errorCode: err.code };
    throw err;
  }
}

/**
 * agent — exactly how an in-app copilot runs a capability: hand `dispatchToolCall` the tool call (with the
 * surface fields merged into the arguments) and the host's `contextFor`. It builds a `surface: "agent"`
 * Context and calls `execute()` straight — no transport at all. `dispatchToolCall` already returns the
 * normalized `{ output } | { errorCode }`.
 */
export async function viaAgent(
  hosts: ParityHosts,
  id: string,
  input: Record<string, unknown>,
  opts: CallOpts = {},
): Promise<SurfaceResult> {
  const result = await dispatchToolCall(
    hosts.registry(),
    { name: id, arguments: withSurfaceFields(input, opts) },
    { contextFor: hosts.agentContextFor },
  );
  if (result.errorCode !== undefined) return { errorCode: result.errorCode };
  return { output: result.output as Record<string, unknown> };
}

/**
 * cli — the CLI surface run IN-PROCESS via `runCli` with capturing sinks (no subprocess). It builds the exact
 * argv a human would type (`<id> --json <json> [--yes] [--key <k>]`), captures stdout/stderr, and reads the
 * result off them: a zero exit means stdout is the pretty-printed JSON output; a non-zero exit means the
 * surface refused, and the code is read off stderr's `✗ <code>: <message>` line — the same translation a real
 * terminal user would see.
 */
export async function viaCli(
  hosts: ParityHosts,
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

  const code = await runCli(hosts.registry(), argv, { contextFor: hosts.cliContextFor }, sink);
  if (code !== 0) {
    const errorCode = readCliErrorCode(errLines);
    if (errorCode === undefined) {
      throw new Error(
        `CLI exited ${code} without a FacetError line. STDERR:\n${errLines.join("\n")}`,
      );
    }
    return { errorCode };
  }
  return { output: JSON.parse(outLines.join("\n")) as Record<string, unknown> };
}

/**
 * http — the PORTABLE Web fetch handler driven headlessly with `handler(new Request(...))` (no port, no real
 * fetch, no web framework). This is the artifact a host mounts in `Bun.serve`/`Deno.serve`/Elysia, so the
 * parity leg exercises exactly what ships. Confirm/key go in the branded `x-facet-*` headers; the body is the
 * capability input verbatim. A 4xx/5xx response carries the `{ code, message, data }` body, from which the
 * error code is read.
 */
export async function viaHttp(
  hosts: ParityHosts,
  id: string,
  input: Record<string, unknown>,
  opts: CallOpts = {},
): Promise<SurfaceResult> {
  const handler = createFetchHandler(hosts.registry(), { authenticate: hosts.authenticate });
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.confirm) headers["x-facet-confirm"] = "true";
  if (opts.idempotencyKey) headers["x-facet-idempotency-key"] = opts.idempotencyKey;

  const res = await handler(
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
 * (dots → `__`). An `isError` result carries the same `{ code, message }` in its `content` text the other
 * surfaces translate.
 */
export async function viaMcp(
  hosts: ParityHosts,
  id: string,
  input: Record<string, unknown>,
  opts: CallOpts = {},
): Promise<SurfaceResult> {
  const server = createMcpServer(hosts.registry(), { contextFor: hosts.mcpContextFor });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "facet-parity", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const res = await client.callTool({
    name: toolName(id),
    arguments: withSurfaceFields(input, opts),
  });
  await client.close();

  // The error body rides in `content` text (NOT structuredContent) on an error result — see @facet/mcp.
  if (res.isError) return { errorCode: readMcpErrorCode(res.content) };
  return { output: res.structuredContent as Record<string, unknown> };
}

/**
 * Merge the surface-shaping fields (`confirm`, `idempotencyKey`) into the capability input as the agent and
 * MCP surfaces expect them — they live IN the tool arguments (the propose→confirm gate is modeled in the
 * schema), not in a separate channel. Returns a fresh object so the caller's `input` is never mutated.
 */
function withSurfaceFields(
  input: Record<string, unknown>,
  opts: CallOpts,
): Record<string, unknown> {
  const args: Record<string, unknown> = { ...input };
  if (opts.confirm) args.confirm = true;
  if (opts.idempotencyKey) args.idempotencyKey = opts.idempotencyKey;
  return args;
}

/** Read a `FacetError` code off the CLI's stderr `✗ <code>: <message>` line, or `undefined` if absent. */
export function readCliErrorCode(errLines: string[]): string | undefined {
  const match = errLines.join("\n").match(/✗\s+(\w+):/);
  return match?.[1];
}

/** Read a `FacetError` code off an MCP error result's `content` text (`{ code, message }` JSON). */
export function readMcpErrorCode(content: unknown): string | undefined {
  const text = Array.isArray(content) ? (content[0] as { text?: string })?.text : undefined;
  if (text === undefined) return undefined;
  return (JSON.parse(text) as { code?: string }).code;
}
