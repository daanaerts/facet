import type { Actor } from "@facet/core";
import { FacetError } from "@facet/core";
import type { HeaderRecord } from "@facet/http";
import type { ToolContext } from "@facet/mcp";
import type { AuthParts } from "@facet/surface-kit";
import { type Authenticator, devAuthenticator, partsFor } from "./auth";

/**
 * The host seam — the multi-tenant app's ENTIRE contribution to the framework. Compared to the spine-free todo
 * host, exactly ONE thing is added: every surface resolves a bearer token to a {@link Principal} and folds the
 * tenant into the Context as `claims` (+ a workspace-scoped ledger), via `partsFor`. The framework still never
 * learns what a workspace is — it only ever sees `actor` / `scopes` / `claims` / `ledger`.
 *
 * Each seam is a FACTORY taking the {@link Authenticator} to use (default: the in-memory `devAuthenticator`) so
 * an entrypoint flips to the real JWT adapter in one place, and the parity test can pin a specific tenant.
 */

/** The token used when a transport carries none — so `bun run` and `curl` work with zero ceremony in dev. */
export const DEV_TOKEN = "tok_acme_admin";

/** Resolve a token to AuthParts via the active authenticator, or `null` for an unknown/invalid token. */
async function resolve(token: string | undefined, auth: Authenticator): Promise<AuthParts | null> {
  const principal = await auth(token);
  return principal ? partsFor(principal) : null;
}

/** Throw a translatable 401 when a non-HTTP surface (cli/mcp/agent) could not authenticate. */
function required(parts: AuthParts | null): AuthParts {
  if (!parts) throw new FacetError("unauthorized", "unknown or invalid token", 401);
  return parts;
}

function bearer(headers: HeaderRecord): string | undefined {
  const h = headers.authorization;
  return h?.startsWith("Bearer ") ? h.slice(7) : undefined;
}

/**
 * The HTTP seam: `authenticate(headers) → AuthParts | null` (null ⇒ 401). It reads the tenant from the
 * `Authorization: Bearer <token>` header — THIS is the multi-tenant entry: a different token yields a different
 * workspace, isolated end to end. With no header it falls back to {@link DEV_TOKEN} so the README curls need no
 * ceremony. Pass `fixedToken` to ignore the header entirely and always authenticate as one tenant (the parity
 * harness does this, since its HTTP driver sends no auth header).
 */
export function saasAuthenticate(
  opts: { auth?: Authenticator; fixedToken?: string } = {},
): (headers: HeaderRecord) => Promise<AuthParts | null> {
  const auth = opts.auth ?? devAuthenticator;
  return (headers) => resolve(opts.fixedToken ?? bearer(headers) ?? DEV_TOKEN, auth);
}

/**
 * The CLI seam: `contextFor(actor) → AuthParts`. The CLI carries no header, so the tenant comes from
 * `SAAS_TOKEN` (default {@link DEV_TOKEN}) — `SAAS_TOKEN=tok_globex_admin bun run cli.ts projects.list`. Pass an
 * explicit `token` to pin the tenant (parity does). The surface adds `surface: "cli"` + the parsed `--yes` / `--key`.
 */
export function saasCliContextFor(
  opts: { auth?: Authenticator; token?: string } = {},
): (actor: Actor) => Promise<AuthParts> {
  const auth = opts.auth ?? devAuthenticator;
  const token = opts.token ?? process.env.SAAS_TOKEN ?? DEV_TOKEN;
  return async (_actor) => required(await resolve(token, auth));
}

/** The MCP seam: `contextFor({ id }) → AuthParts`. Same token resolution as the CLI seam. */
export function saasMcpContextFor(
  opts: { auth?: Authenticator; token?: string } = {},
): (meta: ToolContext) => Promise<AuthParts> {
  const auth = opts.auth ?? devAuthenticator;
  const token = opts.token ?? process.env.SAAS_TOKEN ?? DEV_TOKEN;
  return async (_meta) => required(await resolve(token, auth));
}

/** The agent seam: `contextFor(id) → AuthParts`. The in-process copilot knows its user → derives the tenant. */
export function saasAgentContextFor(
  opts: { auth?: Authenticator; token?: string } = {},
): (id: string) => Promise<AuthParts> {
  const auth = opts.auth ?? devAuthenticator;
  const token = opts.token ?? process.env.SAAS_TOKEN ?? DEV_TOKEN;
  return async (_id) => required(await resolve(token, auth));
}
