import { beforeEach, describe, expect, test } from "bun:test";
import { buildContext, type Context } from "@facet/core";
import {
  assertParity,
  type CallOpts,
  type ParityHosts,
  type SurfaceResult,
  viaAgent,
  viaCli,
  viaExecute,
  viaHttp,
  viaMcp,
} from "@facet/parity";
import { devConnectors } from "../connectors";
import {
  DEV_ACTOR,
  DEV_SCOPES,
  devAgentContextFor,
  devAuthenticate,
  devCliContextFor,
  devMcpContextFor,
} from "../host";
import { outbox } from "../outbox";
import { outboxRegistry } from "../registry";

/**
 * THE MONEY TEST for the outbox app — cross-surface parity over a CONNECTOR-backed capability. `email.send`
 * returns the SAME outbox entry on the raw `execute()` baseline and on HTTP, CLI, MCP and the agent, and every
 * leg refuses an unconfirmed send with the SAME `confirmation_required` code — proving the connector port
 * (newly threaded through `contextFromParts`) projects identically across every surface, exactly like the
 * ledger and claims before it.
 */

const FIXED = "2026-06-24T12:00:00.000Z";

function freshWorld(): void {
  outbox.reset(() => FIXED);
}
beforeEach(freshWorld);

const hosts: ParityHosts = {
  registry: outboxRegistry,
  executeContextFor: ({ confirm, idempotencyKey }: CallOpts): Context =>
    buildContext({
      actor: DEV_ACTOR,
      scopes: DEV_SCOPES,
      surface: "agent",
      confirm,
      idempotencyKey,
      connector: devConnectors(),
    }),
  authenticate: devAuthenticate(),
  cliContextFor: devCliContextFor(),
  mcpContextFor: devMcpContextFor(),
  agentContextFor: devAgentContextFor(),
};

const LEGS: Record<
  string,
  (
    h: ParityHosts,
    id: string,
    input: Record<string, unknown>,
    opts?: CallOpts,
  ) => Promise<SurfaceResult>
> = {
  execute: viaExecute,
  agent: viaAgent,
  cli: viaCli,
  http: viaHttp,
  mcp: viaMcp,
};

async function onAllLegs(
  id: string,
  input: Record<string, unknown>,
  opts?: CallOpts,
): Promise<Record<string, SurfaceResult>> {
  const results: Record<string, SurfaceResult> = {};
  for (const [label, via] of Object.entries(LEGS)) {
    freshWorld();
    results[label] = await via(hosts, id, input, opts);
  }
  return results;
}

describe("four-surface parity — a connector-backed capability projects identically on every surface", () => {
  const EMAIL = { to: "cust@acme.example", subject: "Hi", body: "Hello" };

  test("WRITE parity: email.send returns the SAME entry via execute · agent · cli · http · mcp", async () => {
    const results = await onAllLegs("email.send", EMAIL, { confirm: true });
    assertParity(results);
    const expected = {
      id: "out_2",
      kind: "email",
      target: "cust@acme.example",
      summary: "Hi",
      provider: "memory",
      createdAt: FIXED,
    };
    for (const result of Object.values(results)) expect(result.output).toEqual(expected);
  });

  test("WRITE confirmation parity: every leg REFUSES an unconfirmed send with confirmation_required", async () => {
    const results = await onAllLegs("email.send", EMAIL);
    assertParity(results);
    for (const result of Object.values(results)) {
      expect(result.errorCode).toBe("confirmation_required");
      expect(result.output).toBeUndefined();
    }
  });

  test("READ parity: messages.list returns the SAME output via execute · agent · cli · http · mcp", async () => {
    const results = await onAllLegs("messages.list", {});
    assertParity(results);
    const expected = {
      messages: [
        {
          id: "out_1",
          kind: "email",
          target: "ops@acme.example",
          summary: "Welcome aboard",
          provider: "memory",
          createdAt: FIXED,
        },
      ],
    };
    for (const result of Object.values(results)) expect(result.output).toEqual(expected);
  });
});
