import { expect, test } from "bun:test";
import { buildContext, defineCapability, execute, Registry } from "@facet/core";
import { z } from "zod";

/**
 * F1/F4 from the implementation review: the engine stays tenant-agnostic (there is no `ctx.tenant`), but a
 * host can now attach TYPED claims (workspace, role, …) at `buildContext` time, and a handler reads them off
 * `ctx.claims` — instead of smuggling them through stringly-typed scope prefixes. The chokepoint NEVER reads
 * `claims`; this proves it threads host → Context → handler untouched, so "who, and in what tenant/role" is a
 * typed first-class thing without re-coupling the engine to a tenant.
 */
test("a host's typed claims reach the handler via ctx.claims (the engine never reads them)", async () => {
  const whoami = defineCapability({
    id: "demo.whoami",
    summary: "Echo the caller's workspace + role from ctx.claims.",
    input: z.object({}),
    output: z.object({ workspace: z.string(), role: z.string() }),
    scopes: ["demo:read"],
    handler: async (_input, ctx) => {
      const claims = (ctx.claims ?? {}) as { workspaceId?: string; role?: string };
      return { workspace: claims.workspaceId ?? "(none)", role: claims.role ?? "(none)" };
    },
  });
  const registry = new Registry();
  registry.register(whoami);

  const ctx = buildContext({
    actor: { kind: "user", id: "u1", email: "u1@acme.test" },
    scopes: ["demo:read"],
    surface: "agent",
    claims: { workspaceId: "acme", role: "admin" },
  });

  const result = await execute<{ workspace: string; role: string }>(
    registry,
    "demo.whoami",
    {},
    ctx,
  );
  expect(result).toEqual({ workspace: "acme", role: "admin" });
});
