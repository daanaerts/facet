import { beforeEach, describe, expect, test } from "bun:test";
import { type Context, execute, executeStream, type Ledger, ScopeError } from "@facet/core";
import { jwtAuthenticator, signHs256 } from "../auth";
import { MemoryLedger, scopedLedger } from "../ledger";
import { saasRegistry } from "../registry";
import { store } from "../store";

/**
 * THE HEADLESS PROOF for the multi-tenant domain. Every test runs a capability through the chokepoint with a
 * BARE context built by hand — no framework tenant, just the host-set `claims` the handlers read. It proves the
 * multi-tenant axis the single-tenant examples don't: isolation on reads, on writes (scoped idempotency), and
 * on the destructive path; the role-as-claim authorization gate; and the REAL JWT adapter, exercised
 * hermetically by minting and verifying a token.
 */

/** A bare Context with host-set `claims` — the same shape `buildContext` produces. */
function ctx(opts: {
  scopes: string[];
  claims?: Record<string, unknown>;
  confirm?: boolean;
  idempotencyKey?: string;
  ledger?: Ledger;
}): Context {
  const { scopes } = opts;
  return {
    actor: { kind: "user", id: "u_test", email: "test@acme.example" },
    surface: "agent",
    scopes,
    confirm: opts.confirm ?? false,
    idempotencyKey: opts.idempotencyKey,
    ledger: opts.ledger,
    claims: opts.claims,
    requireScope(scope: string): void {
      if (!scopes.includes(scope) && !scopes.includes("*")) throw new ScopeError(scope);
    },
    audit(): void {},
  };
}

const FIXED = "2026-06-24T00:00:00.000Z";
beforeEach(() => store.reset(() => FIXED));

const acme = (extra: Partial<Parameters<typeof ctx>[0]> = {}) =>
  ctx({
    scopes: ["projects:read", "projects:write"],
    claims: { workspace: "acme", role: "admin" },
    ...extra,
  });
const globex = (extra: Partial<Parameters<typeof ctx>[0]> = {}) =>
  ctx({
    scopes: ["projects:read", "projects:write"],
    claims: { workspace: "globex", role: "admin" },
    ...extra,
  });

describe("multi-tenancy is the host's claim, enforced once in the handler — the engine stays tenant-blind", () => {
  test("a read is isolated to the caller's workspace — two tenants, two disjoint result sets", async () => {
    const acmeProjects = await execute(saasRegistry(), "projects.list", {}, acme());
    const globexProjects = await execute(saasRegistry(), "projects.list", {}, globex());
    expect(acmeProjects).toEqual({
      projects: [
        { id: "proj_1", name: "Website Redesign", workspace: "acme", createdAt: FIXED },
        { id: "proj_2", name: "Q3 Roadmap", workspace: "acme", createdAt: FIXED },
      ],
    });
    expect(globexProjects).toEqual({
      projects: [{ id: "proj_3", name: "Launch Plan", workspace: "globex", createdAt: FIXED }],
    });
  });

  test("a missing workspace claim fails loudly as unauthorized (requireClaim), never a silent empty list", async () => {
    const run = execute(saasRegistry(), "projects.list", {}, ctx({ scopes: ["projects:read"] }));
    await expect(run).rejects.toMatchObject({ code: "unauthorized" });
  });

  test("a create stamps the caller's workspace and is confirmation-gated", async () => {
    const reg = saasRegistry();
    const unconfirmed = execute(
      reg,
      "projects.create",
      { name: "New thing" },
      acme({ confirm: false }),
    );
    await expect(unconfirmed).rejects.toMatchObject({ code: "confirmation_required" });

    const created = await execute(
      reg,
      "projects.create",
      { name: "New thing" },
      acme({ confirm: true }),
    );
    expect(created).toEqual({
      id: "proj_4",
      name: "New thing",
      workspace: "acme",
      createdAt: FIXED,
    });
  });

  test("idempotency is workspace-scoped — the SAME key in two tenants does NOT replay across the boundary", async () => {
    const reg = saasRegistry();
    const base = new MemoryLedger();
    const acmeKeyed = () =>
      acme({ confirm: true, idempotencyKey: "k1", ledger: scopedLedger(base, "acme") });
    const globexKeyed = () =>
      globex({ confirm: true, idempotencyKey: "k1", ledger: scopedLedger(base, "globex") });

    type Created = { id: string; name: string; workspace: string; createdAt: string };
    const first = await execute<Created>(
      reg,
      "projects.create",
      { name: "Acme thing" },
      acmeKeyed(),
    );
    const replay = await execute<Created>(
      reg,
      "projects.create",
      { name: "ignored-on-replay" },
      acmeKeyed(),
    );
    expect(replay).toEqual(first); // same tenant + same key → replayed

    const otherTenant = await execute<Created>(
      reg,
      "projects.create",
      { name: "Globex thing" },
      globexKeyed(),
    );
    expect(otherTenant.id).not.toBe(first.id); // different tenant, same key → a DISTINCT project
    expect(otherTenant.workspace).toBe("globex");
  });

  test("delete is admin-only — a member is refused by the role claim, not the scope", async () => {
    const member = acme({ confirm: true, claims: { workspace: "acme", role: "member" } });
    const run = execute(saasRegistry(), "projects.delete", { id: "proj_1" }, member);
    await expect(run).rejects.toMatchObject({ code: "forbidden" });
  });

  test("delete cannot cross the tenant boundary — a valid id from another workspace reads as not_found", async () => {
    // proj_3 is real, but it belongs to globex; an acme admin must never be able to delete it.
    const run = execute(
      saasRegistry(),
      "projects.delete",
      { id: "proj_3" },
      acme({ confirm: true }),
    );
    await expect(run).rejects.toMatchObject({ code: "not_found" });
    // And it is still there for its actual owner.
    const stillThere = await execute(saasRegistry(), "projects.list", {}, globex());
    expect(stillThere).toEqual({
      projects: [{ id: "proj_3", name: "Launch Plan", workspace: "globex", createdAt: FIXED }],
    });
  });

  test("delete is destructive — it runs only when confirmed, then removes the project", async () => {
    const reg = saasRegistry();
    const unconfirmed = execute(reg, "projects.delete", { id: "proj_1" }, acme({ confirm: false }));
    await expect(unconfirmed).rejects.toMatchObject({ code: "confirmation_required" });

    const deleted = await execute(
      reg,
      "projects.delete",
      { id: "proj_1" },
      acme({ confirm: true }),
    );
    expect(deleted).toEqual({ id: "proj_1", deleted: true });
  });

  test("watch streams only the caller's workspace, then a final count", async () => {
    const chunks: unknown[] = [];
    const gen = executeStream(saasRegistry(), "projects.watch", {}, globex());
    let step = await gen.next();
    while (!step.done) {
      chunks.push(step.value);
      step = await gen.next();
    }
    expect(chunks).toEqual([
      {
        project: { id: "proj_3", name: "Launch Plan", workspace: "globex", createdAt: FIXED },
        n: 1,
      },
    ]);
    expect(step.value).toEqual({ count: 1 });
  });
});

describe("the real adapter — jwtAuthenticator verifies a genuine HS256 token, no network, no deps", () => {
  const secret = "test-secret-do-not-ship";

  test("a token signed with the secret resolves to the right principal", async () => {
    const auth = jwtAuthenticator(secret);
    const token = await signHs256(
      { sub: "u_dana", workspace: "acme", role: "admin", email: "dana@acme.example" },
      secret,
    );
    expect(await auth(token)).toEqual({
      workspace: "acme",
      role: "admin",
      actor: { kind: "user", id: "u_dana", email: "dana@acme.example" },
    });
  });

  test("a forged, wrong-secret, or workspace-less token is rejected", async () => {
    const auth = jwtAuthenticator(secret);
    expect(await auth("not.a.jwt")).toBeNull();
    expect(await auth(await signHs256({ workspace: "acme" }, "WRONG-secret"))).toBeNull();
    expect(await auth(await signHs256({ sub: "u_x", role: "admin" }, secret))).toBeNull();
    expect(await auth(undefined)).toBeNull();
  });
});
