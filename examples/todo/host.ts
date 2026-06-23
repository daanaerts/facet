import type { ContextParts } from "@facet/agent";
import type { CliContextSeam } from "@facet/cli";
import type { Actor, Context, Ledger } from "@facet/core";
import { buildContext } from "@facet/core";
import type { AuthResult, Headers } from "@facet/http";
import type { ToolContext } from "@facet/mcp";

/**
 * The host seam — the to-do app's ENTIRE contribution to the framework. Every surface needs the same two
 * things: "who is calling + what may they do" (an `actor` + `scopes`) and an optional idempotency `ledger`.
 * The framework asks for a Context; the host decides what authentication, scopes and tenancy mean. For an
 * in-memory demo that decision is tiny and identical on every surface — one trusted dev principal, a fixed
 * scope grant, one shared ledger — so the only thing that differs between the surfaces below is the SHAPE
 * each surface's seam expects (HTTP hands headers, CLI/MCP/agent hand a small struct), never the policy.
 *
 * CARVE NOTE: not one framework concept leaks in here. There is no tenant, no install, no appId and no db.
 * A multi-tenant host would fold its tenant into `scopes` and the idempotency key INSIDE these functions,
 * before calling `buildContext`; the framework never learns what a tenant is.
 */

/** The scopes the dev principal is granted — enough to read and write todos. The whole authz policy. */
export const DEV_SCOPES = ["todos:read", "todos:write"];

/**
 * The default actor. Facet's primary consumer is the agent, so the demo's default principal is an `agent`
 * (the HTTP/CLI/MCP seams below all authenticate as this same one). A real host would derive the actor from
 * a verified session / API key / the calling agent's identity; here every call is this trusted dev agent.
 */
export const DEV_ACTOR: Actor = { kind: "agent", agentId: "todo-demo" };

/**
 * An in-memory idempotency Ledger — the one port this host bothers to implement, so a retried `todos.add`
 * carrying the same key replays the first result instead of inserting a second todo. Keyed by
 * `(capabilityId, key)`; no tenant, no db. A real host swaps this for Redis / a table without touching a
 * capability or a surface.
 */
export class MemoryLedger implements Ledger {
  #store = new Map<string, unknown>();
  #key(key: string, capabilityId: string): string {
    return `${capabilityId}::${key}`;
  }
  async lookup(key: string, capabilityId: string): Promise<unknown> {
    return this.#store.get(this.#key(key, capabilityId));
  }
  async record(key: string, capabilityId: string, result: unknown): Promise<void> {
    const k = this.#key(key, capabilityId);
    if (!this.#store.has(k)) this.#store.set(k, result);
  }
}

/**
 * The HTTP surface's seam: `authenticate(headers) → { actor, scopes, ledger }`, or `null` for a 401. Every
 * request is the same trusted dev agent granted the todo scopes, sharing ONE ledger (closed over, created
 * once) so a retried `todos.add` carrying `x-facet-idempotency-key` actually dedupes against a shared store.
 * The ledger lives here, not per request. (An optional `x-facet-actor` override is deliberately NOT honoured
 * — a dev seam should not let a header assert identity.)
 */
export function devAuthenticate(): (headers: Headers) => AuthResult {
  const ledger = new MemoryLedger();
  return (_headers: Headers): AuthResult => ({
    actor: DEV_ACTOR,
    scopes: DEV_SCOPES,
    ledger,
  });
}

/**
 * The CLI surface's seam: turn `runCli`'s request struct (actor + confirm + key, parsed off `--actor` /
 * `--yes` / `--key`) into a Context with the todo scopes granted and one shared ledger, so a retried
 * `todos.add` carrying the same `--key` dedupes. The ledger is created once (closed over), not per call.
 */
export function devCliContextFor(): (seam: CliContextSeam) => Context {
  const ledger = new MemoryLedger();
  return (seam: CliContextSeam): Context =>
    buildContext({
      actor: seam.actor,
      scopes: DEV_SCOPES,
      surface: seam.surface,
      confirm: seam.confirm,
      idempotencyKey: seam.idempotencyKey,
      ledger,
    });
}

/**
 * The MCP surface's seam: every tool call is the same trusted dev agent granted the todo scopes. The surface
 * reads `confirm` / `idempotencyKey` off the tool arguments and hands them here; the host folds them into a
 * Context via `buildContext` with `surface: "mcp"`. One shared ledger (closed over) dedupes a retried write.
 */
export function devMcpContextFor(): (meta: ToolContext) => Context {
  const ledger = new MemoryLedger();
  return ({ confirm, idempotencyKey }: ToolContext): Context =>
    buildContext({
      actor: DEV_ACTOR,
      scopes: DEV_SCOPES,
      surface: "mcp",
      confirm,
      idempotencyKey,
      ledger,
    });
}

/**
 * The agent surface's seam: `contextFor(id) → { actor, scopes, ledger }`. The in-app copilot runs IN PROCESS,
 * so `dispatchToolCall` adds `surface: "agent"` and the per-call confirm/idempotency it split off the model's
 * arguments; the host returns only the spine-free parts. One shared ledger (closed over) dedupes a retry. The
 * `id` is handed in case a host varies scopes by capability — this demo ignores it and grants a fixed set.
 */
export function devAgentContextFor(): (id: string) => ContextParts {
  const ledger = new MemoryLedger();
  return (_id: string): ContextParts => ({
    actor: DEV_ACTOR,
    scopes: DEV_SCOPES,
    ledger,
  });
}
