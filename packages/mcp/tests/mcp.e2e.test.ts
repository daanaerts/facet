import { beforeEach, describe, expect, test } from "bun:test";
import { buildContext, type Context, type Ledger, Registry } from "@facet/core";
import { type ContextFor, capabilityId, createMcpServer, toolName } from "@facet/mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import jobsCancel from "../../../examples/logs/capabilities/jobs.cancel.cap";
import jobsList from "../../../examples/logs/capabilities/jobs.list.cap";
import jobsStart from "../../../examples/logs/capabilities/jobs.start.cap";
import logsTail from "../../../examples/logs/capabilities/logs.tail.cap";
import { MemoryLedger } from "../../../examples/logs/host";
import { store } from "../../../examples/logs/store";

/**
 * The MCP surface driven by the real SDK `Client` over an in-memory transport (the full JSON-RPC handshake,
 * in-process, no subprocess) — ported from apps-demo's `viaMcp` driver and MCP e2e suites, carved to the
 * spine-free framework. There is no db, no tenant, no install-gating: the host supplies a single
 * `contextFor` that turns the surface-read `confirm`/`idempotencyKey` into a Context, and every invariant
 * (the dotted→`__` name mapping, the merged `confirm` field, the confirmation gate, idempotency replay,
 * scope authz) is asserted to live in `@facet/core`, never re-implemented by the surface.
 */

/** The exact constraint the Anthropic define-tools docs impose on a tool name. */
const ANTHROPIC_TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

/** The four logs/jobs capabilities, registered into one registry (the same set the example serves). */
function logsRegistry(): Registry {
  const r = new Registry();
  for (const def of [logsTail, jobsList, jobsStart, jobsCancel]) r.register(def);
  return r;
}

/** Knobs for the test `contextFor`: the scopes to grant and an optional shared ledger for replay tests. */
interface CtxOpts {
  scopes?: string[];
  ledger?: Ledger;
}

/**
 * A test `contextFor` mirroring the example's dev seam: a fixed actor, the granted scopes, surface `mcp`,
 * and the per-call `confirm`/`idempotencyKey` the surface peels off the tool arguments folded in via
 * `buildContext`. The scopes default to the full logs/jobs grant; a test narrows them to prove the scope
 * gate is the core's, not the surface's.
 */
function contextFor(opts: CtxOpts = {}): ContextFor {
  const scopes = opts.scopes ?? ["logs:read", "jobs:read", "jobs:write"];
  return ({ confirm, idempotencyKey }): Context =>
    buildContext({
      actor: { kind: "user", id: "dev@example.com", email: "dev@example.com" },
      scopes,
      surface: "mcp",
      confirm,
      idempotencyKey,
      ledger: opts.ledger,
    });
}

/** Connect an SDK `Client` to a server over a linked in-memory transport pair (the apps-demo pattern). */
async function connect(server: ReturnType<typeof createMcpServer>): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "facet-mcp-test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

/**
 * The `code` an `isError` tool result carries. It is read from the JSON `content` text — NOT from
 * `structuredContent`, which an error result deliberately omits: a tool with an `outputSchema` makes the SDK
 * `Client` validate any `structuredContent` against that schema (even on errors), so the error body rides in
 * `content` where a client reads a tool failure. This is the exact path a real agent uses.
 */
function errorCode(res: Awaited<ReturnType<Client["callTool"]>>): string {
  const text = (res.content as Array<{ type: string; text?: string }>).find(
    (c) => c.type === "text",
  )?.text;
  return (JSON.parse(text ?? "{}") as { code?: string }).code ?? "";
}

beforeEach(() => store.reset());

describe("@facet/mcp — the registry projected onto MCP, spine-free", () => {
  test("listTools maps dotted ids to `__` names, each surfacing its dotted id on annotations.title", async () => {
    const registry = logsRegistry();
    const client = await connect(createMcpServer(registry, { contextFor: contextFor() }));

    const { tools } = await client.listTools();
    // One tool per mcp capability — all four logs/jobs caps declare the default surfaces (mcp included).
    expect(tools.length).toBe(4);
    for (const tool of tools) {
      // The wire name is Anthropic-safe and carries no dot …
      expect(tool.name).toMatch(ANTHROPIC_TOOL_NAME);
      expect(tool.name).not.toContain(".");
      // … and it round-trips back to a real, dotted capability id surfaced on the title.
      const id = capabilityId(tool.name);
      expect(id).toContain(".");
      expect(registry.has(id)).toBe(true);
      expect(tool.annotations?.title).toBe(id);
    }
    expect(tools.map((t) => t.name).sort()).toEqual([
      "jobs__cancel",
      "jobs__list",
      "jobs__start",
      "logs__tail",
    ]);

    await client.close();
  });

  test("a write tool surfaces confirm (required) and idempotencyKey (optional); a read carries neither", async () => {
    const client = await connect(createMcpServer(logsRegistry(), { contextFor: contextFor() }));
    const { tools } = await client.listTools();

    const write = tools.find((t) => t.name === toolName("jobs.start"));
    const writeSchema = write?.inputSchema as {
      properties: Record<string, unknown>;
      required?: string[];
    };
    expect(writeSchema.properties.confirm).toBeDefined();
    expect(writeSchema.properties.idempotencyKey).toBeDefined();
    expect(writeSchema.required).toContain("confirm");
    // The write's threat model rides on its annotations so a client can show the right affordance.
    expect(write?.annotations?.readOnlyHint).toBe(false);
    expect(write?.annotations?.idempotentHint).toBe(true);

    // A destructive tool is also confirm-gated, and flags destructiveHint.
    const destructive = tools.find((t) => t.name === toolName("jobs.cancel"));
    const destructiveSchema = destructive?.inputSchema as { required?: string[] };
    expect(destructiveSchema.required).toContain("confirm");
    expect(destructive?.annotations?.destructiveHint).toBe(true);

    // A read carries NO platform fields — it is idempotent and auto-runs.
    const read = tools.find((t) => t.name === toolName("logs.tail"));
    const readSchema = read?.inputSchema as {
      properties: Record<string, unknown>;
      required?: string[];
    };
    expect(readSchema.properties.confirm).toBeUndefined();
    expect(readSchema.properties.idempotencyKey).toBeUndefined();
    expect(read?.annotations?.readOnlyHint).toBe(true);

    await client.close();
  });

  test("calling logs.tail returns the capability output as structuredContent", async () => {
    const client = await connect(createMcpServer(logsRegistry(), { contextFor: contextFor() }));

    const res = await client.callTool({
      name: toolName("logs.tail"),
      arguments: { source: "build" },
    });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toEqual({
      source: "build",
      lines: ["build started", "compiling", "build ok"],
    });

    await client.close();
  });

  test("calling the jobs.start write WITHOUT confirm errors confirmation_required (the gate is the core's)", async () => {
    const client = await connect(createMcpServer(logsRegistry(), { contextFor: contextFor() }));

    const res = await client.callTool({
      name: toolName("jobs.start"),
      arguments: { name: "nightly" },
    });
    expect(res.isError).toBe(true);
    expect(errorCode(res)).toBe("confirmation_required");
    // The handler never ran — no job was created.
    expect(store.listJobs()).toHaveLength(0);

    await client.close();
  });

  test("calling the same write WITH confirm: true runs it and returns structuredContent", async () => {
    const client = await connect(createMcpServer(logsRegistry(), { contextFor: contextFor() }));

    const res = await client.callTool({
      name: toolName("jobs.start"),
      arguments: { name: "nightly", confirm: true },
    });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({ name: "nightly", status: "running" });
    expect(store.listJobs()).toHaveLength(1);

    await client.close();
  });

  test("an idempotencyKey replay returns the stored result and does NOT re-run the handler", async () => {
    const ledger = new MemoryLedger();
    const client = await connect(
      createMcpServer(logsRegistry(), { contextFor: contextFor({ ledger }) }),
    );

    const first = await client.callTool({
      name: toolName("jobs.start"),
      arguments: { name: "nightly", confirm: true, idempotencyKey: "k1" },
    });
    const firstId = (first.structuredContent as { id: string }).id;

    // Replay with the SAME key but DIFFERENT input — the stored result wins, the handler never re-runs.
    const replay = await client.callTool({
      name: toolName("jobs.start"),
      arguments: { name: "different", confirm: true, idempotencyKey: "k1" },
    });
    expect((replay.structuredContent as { id: string }).id).toBe(firstId);
    expect(store.listJobs()).toHaveLength(1);

    await client.close();
  });

  test("a missing scope is refused by the core and forwarded as forbidden (authz is not the surface's)", async () => {
    // Grant only logs:read — jobs.list needs jobs:read, so the chokepoint's scope gate throws.
    const client = await connect(
      createMcpServer(logsRegistry(), { contextFor: contextFor({ scopes: ["logs:read"] }) }),
    );

    const res = await client.callTool({ name: toolName("jobs.list"), arguments: {} });
    expect(res.isError).toBe(true);
    expect(errorCode(res)).toBe("forbidden");

    await client.close();
  });

  test("an unknown tool name is a clean not_found, before any Context is formed", async () => {
    const client = await connect(createMcpServer(logsRegistry(), { contextFor: contextFor() }));

    const res = await client.callTool({ name: "nope__missing", arguments: {} });
    expect(res.isError).toBe(true);
    expect(errorCode(res)).toBe("not_found");

    await client.close();
  });

  test("after listTools, an error result still surfaces (it carries no schema-violating structuredContent)", async () => {
    // THE REGRESSION GUARD. The SDK Client caches a tool's outputSchema from listTools and then validates
    // any structuredContent on a subsequent callTool against it — EVEN on an error result. If the surface
    // put the { code, message } error body in structuredContent, the client would throw -32602 here and the
    // agent would never see confirmation_required, breaking propose→confirm the moment tools are listed.
    const client = await connect(createMcpServer(logsRegistry(), { contextFor: contextFor() }));
    await client.listTools(); // populate the SDK's cached output validators — this is what exposes the bug

    const gated = await client.callTool({ name: toolName("jobs.start"), arguments: { name: "x" } });
    expect(gated.isError).toBe(true);
    expect(gated.structuredContent).toBeUndefined();
    expect(errorCode(gated)).toBe("confirmation_required");

    // And a success on the same tool still returns schema-valid structuredContent (the happy path is intact).
    const ok = await client.callTool({
      name: toolName("jobs.start"),
      arguments: { name: "x", confirm: true },
    });
    expect(ok.isError).toBeFalsy();
    expect(ok.structuredContent).toMatchObject({ name: "x", status: "running" });

    await client.close();
  });
});
