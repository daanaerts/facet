import type { Actor, Ledger } from "@facet/core";
import type { Headers } from "@facet/http";
import type { ToolContext } from "@facet/mcp";
import type { AuthParts } from "@facet/surface-kit";

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
 *
 * Atomic insert-once comes free from the single-threaded event loop: `claim` checks-and-sets with no `await`
 * between the read and the write, so a concurrent second `claim` for the same key cannot interleave and
 * always loses. A real adapter gets the same atomicity from a DB `UNIQUE(key, capability_id)` constraint or
 * Redis `SET key val NX`. `#claimed` records who won the race; `#results` holds committed values for `read`.
 */
export class MemoryLedger implements Ledger {
  #claimed = new Set<string>();
  #results = new Map<string, unknown>();
  #key(key: string, capabilityId: string): string {
    return `${capabilityId}::${key}`;
  }
  async claim(key: string, capabilityId: string): Promise<"won" | "lost"> {
    const k = this.#key(key, capabilityId);
    if (this.#claimed.has(k)) return "lost";
    this.#claimed.add(k);
    return "won";
  }
  async commit(key: string, capabilityId: string, result: unknown): Promise<void> {
    this.#results.set(this.#key(key, capabilityId), result);
  }
  async read(key: string, capabilityId: string): Promise<unknown> {
    return this.#results.get(this.#key(key, capabilityId));
  }
}

/**
 * The HTTP surface's seam: `authenticate(headers) → { actor, scopes, ledger }`, or `null` for a 401. Every
 * request is the same trusted dev agent granted the todo scopes, sharing ONE ledger (closed over, created
 * once) so a retried `todos.add` carrying `x-facet-idempotency-key` actually dedupes against a shared store.
 * The ledger lives here, not per request. (An optional `x-facet-actor` override is deliberately NOT honoured
 * — a dev seam should not let a header assert identity.)
 */
export function devAuthenticate(): (headers: Headers) => AuthParts {
  const ledger = new MemoryLedger();
  return (_headers: Headers): AuthParts => ({
    actor: DEV_ACTOR,
    scopes: DEV_SCOPES,
    ledger,
  });
}

/**
 * The CLI surface's seam — the shared {@link AuthParts}. `runCli` hands it the calling `actor` (from
 * `--actor`); it returns the todo scopes + one shared ledger (so a retried `todos.add` carrying the same
 * `--key` dedupes). The SURFACE builds the Context, adding `surface: "cli"` + the parsed `--yes` / `--key`.
 */
export function devCliContextFor(): (actor: Actor) => AuthParts {
  const ledger = new MemoryLedger();
  return (actor: Actor): AuthParts => ({ actor, scopes: DEV_SCOPES, ledger });
}

/**
 * The MCP surface's seam — the shared {@link AuthParts}. Every tool call is the same trusted dev agent granted
 * the todo scopes, with one shared ledger (closed over) so a retried write dedupes. The SURFACE reads
 * `confirm` / `idempotencyKey` off the tool arguments and builds the Context (`surface: "mcp"`); the host
 * returns only "who + what may they do". (`meta.id` is available if a host wants to vary scopes by capability.)
 */
export function devMcpContextFor(): (meta: ToolContext) => AuthParts {
  const ledger = new MemoryLedger();
  return (_meta: ToolContext): AuthParts => ({ actor: DEV_ACTOR, scopes: DEV_SCOPES, ledger });
}

/**
 * The agent surface's seam: `contextFor(id) → { actor, scopes, ledger }`. The in-app copilot runs IN PROCESS,
 * so `dispatchToolCall` adds `surface: "agent"` and the per-call confirm/idempotency it split off the model's
 * arguments; the host returns only the spine-free parts. One shared ledger (closed over) dedupes a retry. The
 * `id` is handed in case a host varies scopes by capability — this demo ignores it and grants a fixed set.
 */
export function devAgentContextFor(): (id: string) => AuthParts {
  const ledger = new MemoryLedger();
  return (_id: string): AuthParts => ({
    actor: DEV_ACTOR,
    scopes: DEV_SCOPES,
    ledger,
  });
}
