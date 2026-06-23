import { describe, expect, test } from "bun:test";
import { agentToolset, dispatchToolCall } from "@facet/agent";
import { runCli, type WriterSink } from "@facet/cli";
import { defineCapability, Registry } from "@facet/core";
import { createHttpApp } from "@facet/http";
import { createMcpServer, mcpTools, toolName } from "@facet/mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";

/**
 * THE SURPRISE-CAPABILITY TEST — the most direct proof of "zero per-surface code".
 *
 * We define a capability the four surface adapters have NEVER seen — a `widgets` domain unrelated to logs or
 * todo, declared INLINE right here — register it in a fresh registry, and drive it through all four surfaces.
 * Nothing in `@facet/{http,cli,mcp,agent}` was touched to support it: the adapters are imported exactly as
 * published. If the projection is truly generic over the registry, a brand-new capability is fully functional
 * on every surface — same output, same confirmation gate, same error code — with no adapter change. That is
 * the claim, mechanically demonstrated rather than intended.
 */

// A read and a write the adapters have never met. INLINE — no `*.cap.ts`, no discovery, no registration code.
const widgetsPeek = defineCapability({
  id: "widgets.peek",
  summary: "Read the current widget value.",
  input: z.object({}),
  output: z.object({ value: z.number() }),
  scopes: ["widgets:read"],
  handler: async () => ({ value: 42 }),
});

const widgetsSpin = defineCapability({
  id: "widgets.spin",
  summary: "Spin the widget a number of turns.",
  input: z.object({ turns: z.number().int().min(1) }),
  output: z.object({ spun: z.number() }),
  scopes: ["widgets:write"],
  risk: "write",
  handler: async (input) => ({ spun: input.turns }),
});

/** A fresh registry holding only the surprise capabilities. Each driver builds its own over this. */
function registry(): Registry {
  const r = new Registry();
  r.register(widgetsPeek);
  r.register(widgetsSpin);
  return r;
}

const ACTOR = { kind: "service" } as const;
const SCOPES = ["widgets:read", "widgets:write"];

/** The normalized outcome, identical to the parity harness. */
type Result = { output?: Record<string, unknown>; errorCode?: string };

async function viaAgent(
  id: string,
  input: Record<string, unknown>,
  confirm = false,
): Promise<Result> {
  const args = { ...input, ...(confirm ? { confirm: true } : {}) };
  const r = await dispatchToolCall(
    registry(),
    { name: id, arguments: args },
    {
      contextFor: () => ({ actor: ACTOR, scopes: SCOPES }),
    },
  );
  return r.errorCode !== undefined
    ? { errorCode: r.errorCode }
    : { output: r.output as Record<string, unknown> };
}

async function viaCli(
  id: string,
  input: Record<string, unknown>,
  confirm = false,
): Promise<Result> {
  const argv = [id, "--json", JSON.stringify(input)];
  if (confirm) argv.push("--yes");
  const out: string[] = [];
  const err: string[] = [];
  const sink: WriterSink = { out: (l) => out.push(l), err: (l) => err.push(l) };
  const code = await runCli(
    registry(),
    argv,
    { contextFor: (actor) => ({ actor, scopes: SCOPES }) },
    sink,
  );
  if (code !== 0) {
    const m = err.join("\n").match(/✗\s+(\w+):/);
    return { errorCode: m?.[1] };
  }
  return { output: JSON.parse(out.join("\n")) as Record<string, unknown> };
}

async function viaHttp(
  id: string,
  input: Record<string, unknown>,
  confirm = false,
): Promise<Result> {
  const app = createHttpApp(registry(), { authenticate: () => ({ actor: ACTOR, scopes: SCOPES }) });
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (confirm) headers["x-facet-confirm"] = "true";
  const res = await app.handle(
    new Request(`http://local/cap/${id}`, { method: "POST", headers, body: JSON.stringify(input) }),
  );
  const json = (await res.json()) as Record<string, unknown>;
  return res.status >= 400 ? { errorCode: json.code as string } : { output: json };
}

async function viaMcp(
  id: string,
  input: Record<string, unknown>,
  confirm = false,
): Promise<Result> {
  const server = createMcpServer(registry(), {
    contextFor: () => ({ actor: ACTOR, scopes: SCOPES }),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "surprise", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const args = { ...input, ...(confirm ? { confirm: true } : {}) };
  const res = await client.callTool({ name: toolName(id), arguments: args });
  await client.close();

  if (res.isError) {
    const text = Array.isArray(res.content)
      ? (res.content[0] as { text?: string })?.text
      : undefined;
    const body = text ? (JSON.parse(text) as { code?: string }) : {};
    return { errorCode: body.code };
  }
  return { output: res.structuredContent as Record<string, unknown> };
}

const DRIVERS = { agent: viaAgent, cli: viaCli, http: viaHttp, mcp: viaMcp } as const;

/** Run one call across all four surfaces, keyed by surface name so a failure shows exactly which diverged. */
async function onAllSurfaces(
  id: string,
  input: Record<string, unknown>,
  confirm = false,
): Promise<Record<string, Result>> {
  const entries = await Promise.all(
    Object.entries(DRIVERS).map(
      async ([name, via]) => [name, await via(id, input, confirm)] as const,
    ),
  );
  return Object.fromEntries(entries);
}

describe("a surprise capability the adapters have never seen works on every surface, unchanged", () => {
  test("READ: widgets.peek returns the same output on agent · cli · http · mcp", async () => {
    const results = await onAllSurfaces("widgets.peek", {});
    expect(results).toEqual({
      agent: { output: { value: 42 } },
      cli: { output: { value: 42 } },
      http: { output: { value: 42 } },
      mcp: { output: { value: 42 } },
    });
  });

  test("WRITE: widgets.spin (confirmed) returns the same output on all four surfaces", async () => {
    const results = await onAllSurfaces("widgets.spin", { turns: 3 }, true);
    expect(results).toEqual({
      agent: { output: { spun: 3 } },
      cli: { output: { spun: 3 } },
      http: { output: { spun: 3 } },
      mcp: { output: { spun: 3 } },
    });
  });

  test("WRITE GATE: widgets.spin without confirmation is refused confirmation_required everywhere", async () => {
    const results = await onAllSurfaces("widgets.spin", { turns: 3 });
    expect(results).toEqual({
      agent: { errorCode: "confirmation_required" },
      cli: { errorCode: "confirmation_required" },
      http: { errorCode: "confirmation_required" },
      mcp: { errorCode: "confirmation_required" },
    });
  });

  test("the surprise capability is also DISCOVERABLE on every surface with zero registration code", async () => {
    expect(agentToolset(registry()).map((t) => t.name)).toContain("widgets.spin");
    expect(mcpTools(registry()).map((t) => t.name)).toContain(toolName("widgets.spin"));

    const app = createHttpApp(registry(), {
      authenticate: () => ({ actor: ACTOR, scopes: SCOPES }),
    });
    const cat = (await (
      await app.handle(new Request("http://local/cap", { method: "GET" }))
    ).json()) as {
      capabilities: { id: string }[];
    };
    expect(cat.capabilities.map((c) => c.id)).toContain("widgets.spin");
  });
});
