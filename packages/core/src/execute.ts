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

/**
 * The single chokepoint every surface flows through. GUI, CLI, MCP and the agent all call this exact
 * function, so the invariants live in one place and cannot be skipped:
 *
 *   1. resolve     — look the capability up; refuse if unknown or kill-switched
 *   2. validate    — parse rawInput against the capability's input schema (the one source of truth)
 *   3. authz       — enforce every declared scope, centrally, before the handler
 *   4. confirm     — gate write/destructive behind surface-supplied confirmation
 *   5. idempotency — replay a stored result for a repeated key instead of re-running
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

  // 2. validate input against the capability's own schema — the surface never validates
  const parsed = def.input.safeParse(rawInput);
  if (!parsed.success) throw new ValidationError(id, parsed.error.issues);

  // 3. authz — declared scopes enforced before the handler runs (handlers may add more)
  for (const scope of def.scopes) ctx.requireScope(scope);

  // 4. confirmation gate for writes / destructive operations
  if (def.risk !== "read" && !ctx.confirm) throw new ConfirmationRequiredError(id, def.risk);

  // 5. idempotency — only for a non-read carrying a key, when a ledger is present. A replay returns the
  //    stored result and does NOT re-run the handler. Reads never touch the ledger.
  const dedupe =
    ctx.ledger !== undefined && ctx.idempotencyKey !== undefined && def.risk !== "read";
  if (dedupe && ctx.ledger && ctx.idempotencyKey) {
    const replayed = await ctx.ledger.lookup(ctx.idempotencyKey, id);
    if (replayed !== undefined) {
      ctx.audit("capability.replay", { id, surface: ctx.surface });
      return replayed as O;
    }
  }

  // 6. audit
  ctx.audit("capability.invoke", { id, risk: def.risk, surface: ctx.surface });

  // 7. run + validate output before it leaves the core
  const out = await def.handler(parsed.data, ctx);
  const checked = def.output.safeParse(out);
  if (!checked.success) {
    throw new FacetError("internal", `capability ${id} produced invalid output`, 500, {
      id,
      issues: checked.error.issues,
    });
  }

  // First run of an idempotent write: record the result so the next identical key replays it.
  if (dedupe && ctx.ledger && ctx.idempotencyKey) {
    await ctx.ledger.record(ctx.idempotencyKey, id, checked.data);
  }

  return checked.data as O;
}
