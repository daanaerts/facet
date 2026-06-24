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
import {
  saasAgentContextFor,
  saasAuthenticate,
  saasCliContextFor,
  saasMcpContextFor,
} from "../host";
import { saasRegistry } from "../registry";
import { store } from "../store";

/**
 * THE MONEY TEST for the multi-tenant app — cross-surface parity, with a TENANT threaded through every leg. It
 * proves the thesis holds when the host folds a workspace into the Context: one capability lights up on the raw
 * `execute()` baseline and on HTTP, CLI, MCP and the agent with zero per-surface code, every leg AGREES, and
 * every leg refuses an unconfirmed write with the SAME `confirmation_required` code — all while each leg's seam
 * authenticates as the same tenant (`acme` admin) and carries the same `claims`.
 *
 * Every leg's seam is pinned to one tenant: the four surface seams to the `tok_acme_admin` token, and the
 * baseline's `executeContextFor` to the matching `{ workspace: "acme", role: "admin" }` claims + scopes — parity
 * is only meaningful when every leg has identical authority. (The HTTP parity driver sends no auth header, so
 * `saasAuthenticate` is given a `fixedToken` to ignore the header and always resolve to acme.)
 */

const FIXED = "2026-06-24T12:00:00.000Z";
const TOKEN = "tok_acme_admin";

function freshWorld(): void {
  store.reset(() => FIXED);
}
beforeEach(freshWorld);

const hosts: ParityHosts = {
  registry: saasRegistry,
  executeContextFor: ({ confirm, idempotencyKey }: CallOpts): Context =>
    buildContext({
      actor: { kind: "user", id: "u_alice", email: "alice@acme.example" },
      scopes: ["projects:read", "projects:write"],
      claims: { workspace: "acme", role: "admin" },
      surface: "agent",
      confirm,
      idempotencyKey,
    }),
  authenticate: saasAuthenticate({ fixedToken: TOKEN }),
  cliContextFor: saasCliContextFor({ token: TOKEN }),
  mcpContextFor: saasMcpContextFor({ token: TOKEN }),
  agentContextFor: saasAgentContextFor({ token: TOKEN }),
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

describe("four-surface parity — one tenant-scoped capability, the baseline + four entry points, one chokepoint", () => {
  test("WRITE parity: projects.create returns the SAME tenant-stamped output on every leg", async () => {
    const results = await onAllLegs("projects.create", { name: "Roadmap v2" }, { confirm: true });
    assertParity(results);
    const expected = { id: "proj_4", name: "Roadmap v2", workspace: "acme", createdAt: FIXED };
    for (const result of Object.values(results)) expect(result.output).toEqual(expected);
  });

  test("WRITE confirmation parity: every leg REFUSES an unconfirmed create with confirmation_required", async () => {
    const results = await onAllLegs("projects.create", { name: "Roadmap v2" });
    assertParity(results);
    for (const result of Object.values(results)) {
      expect(result.errorCode).toBe("confirmation_required");
      expect(result.output).toBeUndefined();
    }
  });

  test("READ parity: projects.list returns the SAME workspace-scoped output on every leg", async () => {
    const results = await onAllLegs("projects.list", {});
    assertParity(results);
    const expected = {
      projects: [
        { id: "proj_1", name: "Website Redesign", workspace: "acme", createdAt: FIXED },
        { id: "proj_2", name: "Q3 Roadmap", workspace: "acme", createdAt: FIXED },
      ],
    };
    for (const result of Object.values(results)) expect(result.output).toEqual(expected);
  });
});
