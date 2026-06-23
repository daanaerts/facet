import { streamToolCall } from "@facet/agent";
import { runCli, type WriterSink } from "@facet/cli";
import { executeStream, FacetError } from "@facet/core";
import { createFetchHandler, HEADER } from "@facet/http";
import { createMcpServer, toolName } from "@facet/mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { readCliErrorCode, readMcpErrorCode } from "./drivers";
import type { CallOpts, ParityHosts, StreamResult } from "./types";

/**
 * The STREAMING legs of the harness — the raw `executeStream()` baseline plus the four surface stream
 * renderings — each normalizing one streaming entry point into a single {@link StreamResult} of "the ordered
 * chunks, then how it terminated". A streaming capability is a read, so none of the confirmation / idempotency
 * gates apply; what these legs prove is that the SAME ordered chunk sequence and the SAME termination (a clean
 * final, or the SAME mid-stream `FacetError` code) come back regardless of surface. That is the keystone
 * corner: once the first chunk is out, a surface can no longer answer with a status — so the only thing
 * defining "it failed" is the terminal frame each surface emits, and these drivers read exactly that.
 *
 * A streaming capability is a read; `CallOpts` is accepted for signature symmetry with the unary drivers and
 * forwarded, but it never gates a stream.
 */

/**
 * viaExecuteStream — the RAW `@facet/core` streaming baseline, NO surface. Drive `executeStream()` directly,
 * collecting each yielded chunk in order; a clean return becomes `{ chunks, result }`, a thrown `FacetError`
 * (the core's mid-stream contract guarantees the throw is always a `FacetError`) becomes `{ chunks, errorCode }`
 * carrying whatever chunks made it out first. This is the ground-truth stream the four surface renderings are
 * compared against — chunk-for-chunk and terminator-for-terminator.
 */
export async function viaExecuteStream(
  hosts: ParityHosts,
  id: string,
  input: Record<string, unknown>,
  opts: CallOpts = {},
): Promise<StreamResult> {
  const ctx = hosts.executeContextFor(opts);
  const chunks: unknown[] = [];
  const gen = executeStream(hosts.registry(), id, input, ctx);
  try {
    let step = await gen.next();
    while (!step.done) {
      chunks.push(step.value);
      step = await gen.next();
    }
    return { chunks, result: step.value };
  } catch (err) {
    if (err instanceof FacetError) return { chunks, errorCode: err.code };
    throw err;
  }
}

/**
 * agent — the agent-primary stream: `streamToolCall` drives the capability's async generator and re-yields its
 * validated chunks AS THEY ARE PRODUCED, returning the validated final. We collect the chunks in order; a
 * thrown `FacetError` (the stream's refusal/mid-stream failure) becomes the `errorCode` terminator. This is
 * the closest surface to the baseline — no transport — so a divergence here is the loudest.
 */
export async function viaAgentStream(
  hosts: ParityHosts,
  id: string,
  input: Record<string, unknown>,
  opts: CallOpts = {},
): Promise<StreamResult> {
  const chunks: unknown[] = [];
  const gen = streamToolCall(
    hosts.registry(),
    { name: id, arguments: withSurfaceFields(input, opts) },
    { contextFor: hosts.agentContextFor },
  );
  try {
    let step = await gen.next();
    while (!step.done) {
      chunks.push(step.value);
      step = await gen.next();
    }
    return { chunks, result: step.value };
  } catch (err) {
    if (err instanceof FacetError) return { chunks, errorCode: err.code };
    throw err;
  }
}

/**
 * cli — the CLI prints ONE JSON line per chunk to stdout as it arrives, then (on a clean stream) the final
 * value as the last stdout line; a mid-stream failure prints the K chunk lines, then `✗ <code>: <message>` to
 * stderr with a non-zero exit and NO final line. So we normalize by exit code: on exit 0 the last stdout line
 * is the `result` and the rest are `chunks`; on a non-zero exit EVERY stdout line is a chunk and the code is
 * read off stderr. (This is the contract's CLI rendering: chunks-so-far on stdout, termination in the exit
 * code + the `✗` line.)
 */
export async function viaCliStream(
  hosts: ParityHosts,
  id: string,
  input: Record<string, unknown>,
  opts: CallOpts = {},
): Promise<StreamResult> {
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

  // Each stdout line is one JSON value — a chunk, or (on success) the trailing final.
  const values = outLines.map((line) => JSON.parse(line) as unknown);
  if (code !== 0) {
    const errorCode = readCliErrorCode(errLines);
    if (errorCode === undefined) {
      throw new Error(
        `CLI stream exited ${code} without a FacetError line. STDERR:\n${errLines.join("\n")}`,
      );
    }
    // A failed stream printed only its chunks; there is no final line.
    return { chunks: values, errorCode };
  }
  // A clean stream printed K chunks then the final — peel the final off the tail.
  const result = values[values.length - 1];
  return { chunks: values.slice(0, -1), result };
}

/**
 * http — the SSE rendering, driven headlessly with the PORTABLE fetch handler and `Accept: text/event-stream`.
 * The response body is a Web `ReadableStream` of SSE frames: each chunk is a bare `data: <json>` frame, the
 * clean terminus is an `event: result` frame, and a mid-stream failure is an `event: error` frame carrying
 * `{ code, message }`. We read the stream to completion and parse the frames: `data`-only frames are chunks,
 * `event: result` sets the `result`, `event: error` sets the `errorCode`. (Reading the whole stream is fine —
 * these fixtures are finite; a live `follow` would stream forever, which is out of scope for a parity assertion.)
 */
export async function viaHttpStream(
  hosts: ParityHosts,
  id: string,
  input: Record<string, unknown>,
  _opts: CallOpts = {},
): Promise<StreamResult> {
  const handler = createFetchHandler(hosts.registry(), { authenticate: hosts.authenticate });
  const res = await handler(
    new Request(`http://localhost/cap/${id}`, {
      method: "POST",
      headers: { "content-type": "application/json", [HEADER.accept]: SSE_MEDIA_TYPE },
      body: JSON.stringify(input),
    }),
  );

  // A pre-stream refusal (unknown id, missing scope, bad input) never commits a 200 SSE response — it is a
  // normal JSON status, exactly like the unary path. Map it to the terminator so the streaming baseline and
  // the SSE leg agree even when the stream never starts.
  if (!isSse(res)) {
    const json = (await res.json()) as { code?: string };
    return { chunks: [], errorCode: json.code };
  }

  return parseSseFrames(await res.text());
}

/**
 * mcp — the MCP rendering: the SDK `Client` requests progress (it passes an `onprogress` callback, which is
 * what makes it attach a `progressToken`, which is what makes the server stream). Each chunk arrives as a
 * `notifications/progress` whose `message` is the chunk's JSON; the validated final is the tool result's
 * `structuredContent`. A mid-stream failure arrives as an `isError` result (after the K progress
 * notifications) carrying `{ code, message }` in `content` text. We collect the progress chunks in order and
 * read the terminator off the result.
 */
export async function viaMcpStream(
  hosts: ParityHosts,
  id: string,
  input: Record<string, unknown>,
  opts: CallOpts = {},
): Promise<StreamResult> {
  const server = createMcpServer(hosts.registry(), { contextFor: hosts.mcpContextFor });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "facet-parity", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  // Each progress notification carries one chunk as JSON in `message`; `progress` is its 1-based index, so the
  // SDK delivers them in order. Collecting the parsed messages reconstructs the ordered chunk sequence.
  const chunks: unknown[] = [];
  const res = await client.callTool(
    { name: toolName(id), arguments: withSurfaceFields(input, opts) },
    undefined,
    {
      onprogress: (p) => {
        if (typeof p.message === "string") chunks.push(JSON.parse(p.message) as unknown);
      },
    },
  );
  await client.close();

  if (res.isError) return { chunks, errorCode: readMcpErrorCode(res.content) };
  return { chunks, result: res.structuredContent };
}

/** The media type a client sends in `Accept` to receive a streaming capability as Server-Sent Events. */
const SSE_MEDIA_TYPE = "text/event-stream";

/** Merge the surface-shaping fields into the input as the agent/MCP surfaces expect (a read ignores them). */
function withSurfaceFields(
  input: Record<string, unknown>,
  opts: CallOpts,
): Record<string, unknown> {
  const args: Record<string, unknown> = { ...input };
  if (opts.confirm) args.confirm = true;
  if (opts.idempotencyKey) args.idempotencyKey = opts.idempotencyKey;
  return args;
}

/** Whether a response committed to an SSE stream (a 200 `text/event-stream`) vs a plain JSON status. */
function isSse(res: Response): boolean {
  return (res.headers.get("content-type") ?? "").includes(SSE_MEDIA_TYPE);
}

/**
 * Parse a finished SSE body into a {@link StreamResult}. SSE frames are separated by a blank line; within a
 * frame, `event:` names the frame type (absent ⇒ a default `message` frame, which is a chunk here) and `data:`
 * carries the JSON payload. The surface emits exactly one terminal frame: `event: result` (clean) carrying the
 * final, or `event: error` carrying `{ code, message }`. Everything before it is a chunk.
 */
function parseSseFrames(body: string): StreamResult {
  const chunks: unknown[] = [];
  let result: unknown;
  let errorCode: string | undefined;

  for (const frame of body.split("\n\n")) {
    if (frame.trim() === "") continue;
    let event: string | undefined;
    const dataLines: string[] = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith("event:")) event = line.slice("event:".length).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice("data:".length).trim());
    }
    const data = dataLines.length > 0 ? (JSON.parse(dataLines.join("\n")) as unknown) : undefined;
    if (event === "result") result = data;
    else if (event === "error") errorCode = (data as { code?: string } | undefined)?.code;
    else chunks.push(data);
  }

  return errorCode !== undefined ? { chunks, errorCode } : { chunks, result };
}
