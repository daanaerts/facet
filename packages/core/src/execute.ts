import type { Context } from "./context";
import {
  ConfirmationRequiredError,
  FacetError,
  KillSwitchError,
  NotFoundError,
  ValidationError,
} from "./errors";
import { drainStream } from "./execute-stream";
import type { Registry } from "./registry";
import { validateStandard } from "./standard-schema";

/**
 * Dedupe set for the idempotency-without-a-ledger warning (S3). A given capability id is warned about at most
 * once per process, so a hot loop of the same misconfigured call does not spam STDERR. Module-level, reset
 * never — the warning is a one-time wake-up that the host forgot to wire a ledger, not a per-call diagnostic.
 */
const warnedInertIdempotency = new Set<string>();

/**
 * Warn — exactly ONCE per capability id, to STDERR — that an idempotent, key-carrying call is running WITHOUT
 * a ledger, so its dedup is silently inert. This caught real latent bugs in the dogfood study: smokes "passed"
 * only because dedup never ran. It changes NO control flow (the call proceeds exactly as before); it only makes
 * the silent degradation audible. Muted wholesale by `FACET_SILENCE_WARNINGS` for hosts that have seen it.
 */
function warnInertIdempotency(id: string): void {
  if (typeof process !== "undefined" && process.env && process.env.FACET_SILENCE_WARNINGS) return;
  if (warnedInertIdempotency.has(id)) return;
  warnedInertIdempotency.add(id);
  console.warn(
    `[facet] capability "${id}" is idempotent and was called with an idempotencyKey, but ctx.ledger is ` +
      `undefined — idempotency is INERT (no dedup will happen). Wire a Ledger into the Context, or drop the ` +
      `idempotencyKey. Silence with FACET_SILENCE_WARNINGS=1.`,
  );
}

/**
 * The single chokepoint every surface flows through. GUI, CLI, MCP and the agent all call this exact
 * function, so the invariants live in one place and cannot be skipped:
 *
 *   1. resolve     — look the capability up; refuse if unknown or kill-switched
 *   2. validate    — parse rawInput against the input schema via Standard Schema (the one source of truth)
 *   3. authz       — enforce every declared scope, centrally, before the handler
 *   4. confirm     — gate write/destructive behind surface-supplied confirmation
 *   5. idempotency — atomically claim a repeated key; the loser replays the stored result, never re-runs
 *   6. audit       — record actor + capability + surface for every invocation
 *   7. run + check — execute the handler, then validate its output before it leaves the core
 *
 * CARVE NOTE: this is `facet.md`'s 7-step pipeline VERBATIM. Moral Fabric's `execute()` had a hidden 8th
 * step in front — install-gating against `ctx.installs`/`ctx.tenant`/`def.appId` — and threaded `tenant`
 * through audit and the ledger. All of that was a specific product's platform model, not the capability
 * engine. Removing it is the carve. The doc was already describing the generic version; the code had drifted.
 */
export async function execute<O = unknown>(
  registry: Registry,
  id: string,
  rawInput: unknown,
  ctx: Context,
): Promise<O> {
  // 1. resolve
  const def = registry.get(id);
  if (!def) throw new NotFoundError(`capability not found: ${id}`, { id });
  if (!def.enabled) throw new KillSwitchError(id);

  // 1a. STREAMING (additive): a streaming capability has an async-generator handler, not a unary one. A
  //     caller that does not stream still gets its terminal value here — `drainStream` runs the very same
  //     gates (resolve, validate, authz, audit) and per-chunk/final validation as `executeStream`, then
  //     discards the chunks and returns the validated final. Streaming caps are reads, so none of the
  //     confirmation / idempotency steps below apply, which is exactly why we delegate before reaching them.
  if (def.stream) return drainStream<O>(registry, id, rawInput, ctx);

  // 2. validate input against the capability's own schema — the surface never validates. Validation goes
  //    through the Standard Schema contract (`['~standard'].validate`), so the engine accepts any compatible
  //    validator; a `.issues` result maps to the same `ValidationError` (`validation` code) every surface
  //    already renders, keeping the parity matrix intact.
  const parsed = await validateStandard(def.input, rawInput);
  if (parsed.issues) throw new ValidationError(id, parsed.issues);

  // 3. authz — declared scopes enforced before the handler runs (handlers may add more)
  for (const scope of def.scopes) ctx.requireScope(scope);

  // 4. confirmation gate for writes / destructive operations
  if (def.risk !== "read" && !ctx.confirm) throw new ConfirmationRequiredError(id, def.risk);

  // 5. idempotency — only for a non-read carrying a key, when a ledger is present. Reads never touch the
  //    ledger. The dedup is now ATOMIC INSERT-ONCE: the call CLAIMS the key before running anything, and
  //    exactly one caller can win that claim (the port backs it with a DB unique constraint / Redis SET NX).
  //    This closes the concurrent double-submit hole the old `lookup → handler → record` had: two calls with
  //    the same key could both miss the lookup and both run the handler. Now the loser never runs the handler.
  const dedupe =
    ctx.ledger !== undefined && ctx.idempotencyKey !== undefined && def.risk !== "read";
  // S3: a non-read that is idempotent AND carries a key but has NO ledger degrades SILENTLY to non-idempotent.
  // The control flow below is unchanged (no ledger ⇒ `dedupe` is false ⇒ the handler just runs); we only make
  // the silent no-op audible, once per id, so a host notices the missing ledger instead of shipping a smoke
  // that "passed" because dedup never ran. Reads never dedupe, so they are never warned.
  if (
    def.risk !== "read" &&
    def.idempotent &&
    ctx.idempotencyKey !== undefined &&
    ctx.ledger === undefined
  ) {
    warnInertIdempotency(id);
  }
  if (dedupe && ctx.ledger && ctx.idempotencyKey) {
    const claim = await ctx.ledger.claim(ctx.idempotencyKey, id);
    if (claim === "lost") {
      // A loser (a concurrent twin, or a later retry) does NOT run the handler. It reads the winner's
      // committed result ONCE. If committed, that read IS the replay — return it. If the winner is still
      // mid-flight (claimed but not yet committed), there is nothing to replay yet: surface `conflict`
      // (HTTP 409) so the caller retries the same key, rather than blocking the engine on the winner.
      const replayed = await ctx.ledger.read(ctx.idempotencyKey, id);
      if (replayed !== undefined) {
        ctx.audit("capability.replay", { id, surface: ctx.surface });
        return replayed as O;
      }
      throw new FacetError(
        "conflict",
        `capability ${id} is already in flight for this idempotency key; retry`,
        409,
        { id, idempotencyKey: ctx.idempotencyKey },
      );
    }
  }

  // 6. audit
  ctx.audit("capability.invoke", { id, risk: def.risk, surface: ctx.surface });

  // 7. run + validate output before it leaves the core (same Standard Schema path as the input)
  const out = await def.handler(parsed.value, ctx);
  const checked = await validateStandard(def.output, out);
  if (checked.issues) {
    throw new FacetError("internal", `capability ${id} produced invalid output`, 500, {
      id,
      issues: checked.issues,
    });
  }

  // Winner of the claim: commit the validated result so every later caller with this key replays it.
  if (dedupe && ctx.ledger && ctx.idempotencyKey) {
    await ctx.ledger.commit(ctx.idempotencyKey, id, checked.value);
  }

  return checked.value as O;
}
