import { ConnectorUnavailableError, type Context, FacetError } from "@facet/core";

/**
 * THE PORT this example demonstrates: external systems reached through `ctx.connector` — Facet's host-supplied
 * port for "reaching external systems (a vault-backed client, …)". Each connector has an in-memory DEFAULT
 * (so the app runs with zero setup and the test suite is hermetic) and a REAL adapter alongside it (Resend for
 * email, GitHub for issues, over `fetch`). The handlers depend on the INTERFACES (`EmailConnector` /
 * `IssueConnector`) and resolve them off the Context — never importing a provider — so the host can hand each
 * caller a connector bound to its identity, and a missing one fails loudly as `ConnectorUnavailableError`.
 */

export interface EmailConnector {
  send(msg: { to: string; subject: string; body: string }): Sent | Promise<Sent>;
}
export interface IssueConnector {
  open(issue: { repo: string; title: string; body: string }): Sent | Promise<Sent>;
}
/** What a connector returns: the provider's id for the thing it created, and which provider it was. */
export interface Sent {
  id: string;
  provider: string;
}

/**
 * Resolve a connector off the Context, failing loudly if it isn't wired. Demonstrates the two ways a connector
 * can be unavailable — the port itself absent, or the host not knowing that id — both as one typed error a
 * surface translates (HTTP 501, an MCP `isError`, a CLI `✗ connector_unavailable`).
 */
export function useConnector<T>(ctx: Context, id: string): T {
  if (!ctx.connector) {
    throw new ConnectorUnavailableError(id, "no connector port wired into the context");
  }
  return ctx.connector<T>(id);
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────────────
// Adapter 1 — IN-MEMORY (the default). The connectors don't deliver anything; they just report a provider so
// the handler can log the send. State lives in `outbox.ts`, so these are stateless. Used by every entrypoint
// and the test suite unless real credentials are wired.
// ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export function memoryEmail(): EmailConnector {
  return { send: () => ({ id: "memory", provider: "memory" }) };
}
export function memoryGithub(): IssueConnector {
  return { open: () => ({ id: "memory", provider: "memory" }) };
}

/**
 * The connector resolver a host wires into the Context (see `host.ts`). Maps an id to a connector and throws
 * `ConnectorUnavailableError` for an id it doesn't know — so asking for a connector the host never registered
 * is the same typed failure as the port being absent.
 */
export function devConnectors(): <T>(id: string) => T {
  const email = memoryEmail();
  const github = memoryGithub();
  return <T>(id: string): T => {
    if (id === "email") return email as T;
    if (id === "github") return github as T;
    throw new ConnectorUnavailableError(id, `no connector registered for "${id}"`);
  };
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────────────
// Adapter 2 — REAL (Resend + GitHub over fetch). Genuine clients; they require API keys and a network, so —
// like the other examples' real adapters — they are NOT run by the test suite, they ship ALONGSIDE the default.
// A network failure becomes `ConnectorUnavailableError`; a provider 4xx becomes the matching FacetError.
// ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export function resendEmail(apiKey: string, from: string): EmailConnector {
  return {
    async send(msg) {
      let res: Response;
      try {
        res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({ from, to: msg.to, subject: msg.subject, html: msg.body }),
        });
      } catch (err) {
        throw new ConnectorUnavailableError(
          "email",
          err instanceof Error ? err.message : "network error",
        );
      }
      const json = (await res.json()) as { id?: string; message?: string };
      if (!res.ok) throw new FacetError("conflict", json.message ?? "resend error", res.status);
      return { id: String(json.id), provider: "resend" };
    },
  };
}

export function githubIssues(token: string): IssueConnector {
  return {
    async open(issue) {
      let res: Response;
      try {
        res = await fetch(`https://api.github.com/repos/${issue.repo}/issues`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            accept: "application/vnd.github+json",
            "content-type": "application/json",
          },
          body: JSON.stringify({ title: issue.title, body: issue.body }),
        });
      } catch (err) {
        throw new ConnectorUnavailableError(
          "github",
          err instanceof Error ? err.message : "network error",
        );
      }
      const json = (await res.json()) as { number?: number; message?: string };
      if (!res.ok) throw new FacetError("conflict", json.message ?? "github error", res.status);
      return { id: String(json.number), provider: "github" };
    },
  };
}
