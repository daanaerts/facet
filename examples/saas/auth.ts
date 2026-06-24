import type { Actor } from "@facet/core";
import type { AuthParts } from "@facet/surface-kit";
import { scopedLedger, sharedLedger } from "./ledger";

/**
 * THE PORT this example demonstrates: authentication is a seam with an in-memory DEFAULT (so the app runs with
 * zero setup and the test suite stays hermetic) and a REAL adapter alongside it (so the integration is honest).
 * Both adapters satisfy one tiny interface — resolve an opaque bearer token to a {@link Principal} — and the
 * rest of the app (the four surface seams in `host.ts`) is written against the interface, never a provider.
 * Flip from dev to real by changing one line in an entrypoint; nothing else moves. That is the "library you
 * call + adapters you mount" thesis, applied to auth.
 */

/** Who the caller is, in domain terms: their workspace (the tenant) and their role, plus the framework `Actor`. */
export interface Principal {
  workspace: string;
  role: "admin" | "member";
  actor: Actor;
}

/**
 * An authenticator resolves a bearer token to a {@link Principal}, or `null` when the token is unknown/invalid.
 * Sync or async — the in-memory adapter is sync, the JWT adapter awaits Web Crypto. This is the ONLY shape the
 * host seams depend on.
 */
export type Authenticator = (
  token: string | undefined,
) => Principal | null | Promise<Principal | null>;

/**
 * Turn a resolved {@link Principal} into the framework's {@link AuthParts}. This is where tenancy is folded into
 * the Context the sanctioned way:
 *   - `scopes` carry only the CAPABILITY authz (`projects:read` / `projects:write`) — NOT the tenant. Encoding
 *     the workspace as a `"workspace:acme"` scope and slicing it back out is the fragile, stringly-typed hack
 *     the claims API replaces.
 *   - `claims` carry the typed "who, and in what tenant/role" (`{ workspace, role }`) the handlers read via
 *     `requireClaim` / `claimOf`.
 *   - `ledger` is a per-workspace VIEW of the shared ledger, so two tenants' identical idempotency keys never
 *     collide (see `ledger.ts`).
 */
export function partsFor(principal: Principal): AuthParts {
  return {
    actor: principal.actor,
    scopes: ["projects:read", "projects:write"],
    claims: { workspace: principal.workspace, role: principal.role },
    ledger: scopedLedger(sharedLedger, principal.workspace),
  };
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────────────
// Adapter 1 — IN-MEMORY (the default). A token → principal map. Zero setup, fully hermetic; this is what every
// entrypoint and the test suite use unless told otherwise. The three tokens span two tenants and both roles so
// isolation and the admin gate are demonstrable out of the box.
// ──────────────────────────────────────────────────────────────────────────────────────────────────────────

const DEV_PRINCIPALS: Record<string, Principal> = {
  tok_acme_admin: {
    workspace: "acme",
    role: "admin",
    actor: { kind: "user", id: "u_alice", email: "alice@acme.example" },
  },
  tok_acme_member: {
    workspace: "acme",
    role: "member",
    actor: { kind: "user", id: "u_bob", email: "bob@acme.example" },
  },
  tok_globex_admin: {
    workspace: "globex",
    role: "admin",
    actor: { kind: "user", id: "u_carol", email: "carol@globex.example" },
  },
};

/** The default authenticator: an in-memory token map. A real host never ships this. */
export const devAuthenticator: Authenticator = (token) => (token && DEV_PRINCIPALS[token]) || null;

// ──────────────────────────────────────────────────────────────────────────────────────────────────────────
// Adapter 2 — REAL (HS256 JWT, verified with Web Crypto). This is a genuine, runnable adapter, not a mock: it
// verifies the signature and expiry of a bearer JWT and reads `workspace` / `role` from its claims. It uses
// only the Web Crypto + base64 globals, so it has NO dependency and runs identically on Bun, Node 22+ and Deno.
// A production host points `verify` at its provider instead (Clerk / Auth0 / WorkOS / a JWKS endpoint) — the
// shape, and everything downstream of it, is identical. We ship HS256-with-a-shared-secret because it is the
// one variant we can both run and TEST without a network (see tests/headless.test.ts, which mints a token).
// ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Build a JWT authenticator over a shared HS256 secret. Maps the verified token's claims onto a
 * {@link Principal}; returns `null` for any token that fails to verify or lacks a `workspace` claim.
 */
export function jwtAuthenticator(secret: string): Authenticator {
  return async (token) => {
    if (!token) return null;
    const claims = await verifyHs256(token, secret);
    if (!claims) return null;
    const workspace = typeof claims.workspace === "string" ? claims.workspace : undefined;
    if (!workspace) return null;
    const role = claims.role === "admin" ? "admin" : "member";
    const sub = typeof claims.sub === "string" ? claims.sub : "unknown";
    const email = typeof claims.email === "string" ? claims.email : `${sub}@${workspace}.example`;
    return { workspace, role, actor: { kind: "user", id: sub, email } };
  };
}

/** Sign an HS256 JWT — for the demo and the tests to mint tokens the {@link jwtAuthenticator} then verifies. */
export async function signHs256(payload: Record<string, unknown>, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const header = b64url(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const data = `${header}.${body}`;
  const key = await hmacKey(secret);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
  return `${data}.${b64url(sig)}`;
}

/** Verify an HS256 JWT's signature and expiry; return its claims, or `null` if anything is off. */
async function verifyHs256(token: string, secret: string): Promise<Record<string, unknown> | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts as [string, string, string];
  const enc = new TextEncoder();
  const key = await hmacKey(secret);
  const ok = await crypto.subtle.verify(
    "HMAC",
    key,
    b64urlDecode(sig),
    enc.encode(`${header}.${body}`),
  );
  if (!ok) return null;
  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(new TextDecoder().decode(b64urlDecode(body)));
  } catch {
    return null;
  }
  if (typeof claims.exp === "number" && claims.exp * 1000 < Date.now()) return null;
  return claims;
}

function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replaceAll("-", "+").replaceAll("_", "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}
