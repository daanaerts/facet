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
import { resetGateway } from "../gateway";
import {
  DEV_ACTOR,
  DEV_SCOPES,
  devAgentContextFor,
  devAuthenticate,
  devCliContextFor,
  devMcpContextFor,
} from "../host";
import { billingRegistry } from "../registry";

/**
 * THE MONEY TEST (literally) for the billing app — cross-surface parity over the raw `execute()` baseline plus
 * HTTP, CLI, MCP and the agent. A charge returns the SAME payment on every leg, and every leg refuses an
 * unconfirmed write with the SAME `confirmation_required` code — the wedge is identical no matter who is asking,
 * which is the whole safety claim: an agent cannot move money the GUI couldn't, and a confirmed charge is
 * byte-identical across surfaces because each only establishes a Context and calls the one chokepoint.
 */

const FIXED = "2026-06-24T12:00:00.000Z";

function freshWorld(): void {
  resetGateway(() => FIXED);
}
beforeEach(freshWorld);

const hosts: ParityHosts = {
  registry: billingRegistry,
  executeContextFor: ({ confirm, idempotencyKey }: CallOpts): Context =>
    buildContext({
      actor: DEV_ACTOR,
      scopes: DEV_SCOPES,
      surface: "agent",
      confirm,
      idempotencyKey,
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

describe("four-surface parity — money moves identically on every surface, or not at all", () => {
  const CHARGE = { amountCents: 2500, currency: "usd", customer: "cus_x" };

  test("WRITE parity: payments.charge returns the SAME payment via execute · agent · cli · http · mcp", async () => {
    const results = await onAllLegs("payments.charge", CHARGE, { confirm: true });
    assertParity(results);
    const expected = {
      id: "pay_3",
      amountCents: 2500,
      currency: "usd",
      customer: "cus_x",
      status: "succeeded",
      refundedCents: 0,
      createdAt: FIXED,
    };
    for (const result of Object.values(results)) expect(result.output).toEqual(expected);
  });

  test("WRITE confirmation parity: every leg REFUSES an unconfirmed charge with confirmation_required", async () => {
    const results = await onAllLegs("payments.charge", CHARGE);
    assertParity(results);
    for (const result of Object.values(results)) {
      expect(result.errorCode).toBe("confirmation_required");
      expect(result.output).toBeUndefined();
    }
  });

  test("READ parity: payments.list returns the SAME output via execute · agent · cli · http · mcp", async () => {
    const results = await onAllLegs("payments.list", {});
    assertParity(results);
    const expected = {
      payments: [
        {
          id: "pay_1",
          amountCents: 4999,
          currency: "usd",
          customer: "cus_alice",
          status: "succeeded",
          refundedCents: 0,
          createdAt: FIXED,
        },
        {
          id: "pay_2",
          amountCents: 500000,
          currency: "usd",
          customer: "cus_bob",
          status: "succeeded",
          refundedCents: 0,
          createdAt: FIXED,
        },
      ],
    };
    for (const result of Object.values(results)) expect(result.output).toEqual(expected);
  });
});
