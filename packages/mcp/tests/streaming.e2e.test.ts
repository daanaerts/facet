import { beforeEach, describe, expect, test } from "bun:test";
import { buildContext, type Context, Registry } from "@facet/core";
import { type ContextFor, createMcpServer, toolName } from "@facet/mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import logsFollow from "../../../examples/logs/capabilities/logs.follow.cap";
import logsTail from "../../../examples/logs/capabilities/logs.tail.cap";
import { store } from "../../../examples/logs/store";

/**
 * THE MCP STREAMING PROOF.
 *
 * `logs.follow` — a streaming capability — projected onto MCP, driven by the real SDK `Client` over an
 * in-memory transport (the full JSON-RPC handshake, in-process). When the client passes an `onprogress`
 * callback, the SDK attaches a `progressToken` and the surface emits ONE real `notifications/progress` per
 * validated chunk (the chunk JSON rides in the notification's `message`, since a Progress carries only
 * numbers + a string), then returns the validated final as `structuredContent`. This is the SDK's genuine
 * progress mechanism, not a drained final dressed up as one. Without `onprogress` (no token), the same call
 * drains to the same `structuredContent` — proven by the last test.
 */

/** A registry with the streaming `logs.follow` plus its unary sibling `logs.tail`. */
function registry(): Registry {
  const r = new Registry();
  for (const def of [logsFollow, logsTail]) r.register(def);
  return r;
}

/** A test `contextFor` granting logs:read (all a streaming read needs), surface `mcp`. */
function contextFor(scopes = ["logs:read"]): ContextFor {
  return (): Context => buildContext({ actor: { kind: "service" }, scopes, surface: "mcp" });
}

/** Connect an SDK `Client` to a server over a linked in-memory transport pair. */
async function connect(server: ReturnType<typeof createMcpServer>): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "facet-mcp-stream-test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

/** One progress notification the client observed: its count and the chunk JSON-decoded from `message`. */
interface SeenProgress {
  progress: number;
  chunk: unknown;
}

beforeEach(() => store.reset());

describe("@facet/mcp streams a capability — progress notifications per chunk + final structuredContent", () => {
  test("calling a streaming tool with onprogress fires one progress per chunk, then returns the final", async () => {
    const client = await connect(createMcpServer(registry(), { contextFor: contextFor() }));

    const seen: SeenProgress[] = [];
    const res = await client.callTool(
      { name: toolName("logs.follow"), arguments: { source: "build" } },
      undefined,
      {
        onprogress: (p) => {
          // The chunk rides as JSON in `message`; `progress` is its strictly-increasing 1-based index.
          seen.push({ progress: p.progress, chunk: p.message ? JSON.parse(p.message) : undefined });
        },
      },
    );

    // "build" has three lines → three progress notifications, one per chunk, in order.
    expect(seen).toEqual([
      { progress: 1, chunk: { line: "build started", n: 1 } },
      { progress: 2, chunk: { line: "compiling", n: 2 } },
      { progress: 3, chunk: { line: "build ok", n: 3 } },
    ]);

    // The final value is the tool result's structuredContent, exactly like a unary call.
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toEqual({ source: "build", lineCount: 3 });

    await client.close();
  });

  test("an unknown source fires no progress and still returns the zero-count final", async () => {
    const client = await connect(createMcpServer(registry(), { contextFor: contextFor() }));

    const seen: unknown[] = [];
    const res = await client.callTool(
      { name: toolName("logs.follow"), arguments: { source: "nope" } },
      undefined,
      { onprogress: (p) => seen.push(p) },
    );

    expect(seen).toHaveLength(0);
    expect(res.structuredContent).toEqual({ source: "nope", lineCount: 0 });

    await client.close();
  });

  test("WITHOUT onprogress (no progress token) the stream drains to the same final structuredContent", async () => {
    const client = await connect(createMcpServer(registry(), { contextFor: contextFor() }));

    // No onprogress ⇒ the SDK attaches no progressToken ⇒ the surface drains to the final via execute().
    const res = await client.callTool({
      name: toolName("logs.follow"),
      arguments: { source: "build" },
    });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toEqual({ source: "build", lineCount: 3 });

    await client.close();
  });

  test("a missing scope is refused by the core and surfaced as forbidden — before any progress", async () => {
    const client = await connect(createMcpServer(registry(), { contextFor: contextFor([]) }));

    const seen: unknown[] = [];
    const res = await client.callTool(
      { name: toolName("logs.follow"), arguments: { source: "build" } },
      undefined,
      { onprogress: (p) => seen.push(p) },
    );

    expect(seen).toHaveLength(0); // the gate refused before a single chunk was produced
    expect(res.isError).toBe(true);
    const text = (res.content as Array<{ type: string; text?: string }>).find(
      (c) => c.type === "text",
    )?.text;
    expect((JSON.parse(text ?? "{}") as { code?: string }).code).toBe("forbidden");

    await client.close();
  });
});
