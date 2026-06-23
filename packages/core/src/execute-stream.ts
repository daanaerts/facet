import type { Context } from "./context";
import { FacetError, KillSwitchError, NotFoundError, ValidationError } from "./errors";
import type { Registry } from "./registry";

/**
 * The streaming sibling of `execute()` — the SAME chokepoint, expressed as an async generator. Streaming is
 * agent-primary: the canonical model is "structured incremental chunks then a terminal final value", which a
 * human surface renders downstream (HTTP as SSE, CLI as printed lines, MCP as progress). The core's job is
 * unchanged — establish nothing, validate everything — only now it validates a STREAM, chunk by chunk.
 *
 * It runs the read-relevant gates of `execute()`'s pipeline, IN THE SAME ORDER, before a single chunk
 * escapes:
 *
 *   1. resolve   — look the capability up; refuse if unknown, kill-switched, or not actually streaming
 *   2. validate  — parse rawInput against the input schema (the one source of truth)
 *   3. authz     — enforce every declared scope, centrally, before the handler
 *   4. audit     — record actor + capability + surface for the invocation
 *   5. run + check — drive the generator, VALIDATING each yielded chunk against `chunk` and the returned
 *                    final against `output` before either leaves the core
 *
 * CARVE NOTE: a streaming capability is `risk:"read"` by construction (`defineStreamingCapability` pins it),
 * so the confirmation gate and the idempotency/ledger steps of the unary pipeline DO NOT APPLY here and are
 * deliberately absent — a read neither confirms nor records. This keeps the streaming path a strict, smaller
 * projection of the same invariants rather than a second, divergent engine.
 */
export async function* executeStream<C = unknown, F = unknown>(
  registry: Registry,
  id: string,
  rawInput: unknown,
  ctx: Context,
): AsyncGenerator<C, F, void> {
  // 1. resolve — refuse unknown / kill-switched, and refuse a non-streaming capability up front so a caller
  //    that asked for a stream never silently gets a one-shot value.
  const def = registry.get(id);
  if (!def) throw new NotFoundError(`capability not found: ${id}`, { id });
  if (!def.enabled) throw new KillSwitchError(id);
  if (!def.stream || !def.chunk || !def.streamHandler) {
    throw new FacetError("validation", `capability ${id} is not streaming`, 422, { id });
  }

  // 2. validate input against the capability's own schema — the surface never validates.
  const parsed = def.input.safeParse(rawInput);
  if (!parsed.success) throw new ValidationError(id, parsed.error.issues);

  // 3. authz — declared scopes enforced BEFORE any chunk is produced (a missing scope is refused here, so
  //    no partial stream ever leaks past an authz failure).
  for (const scope of def.scopes) ctx.requireScope(scope);

  // 4. audit — one event per streamed invocation, same as a unary call.
  ctx.audit("capability.invoke", { id, risk: def.risk, surface: ctx.surface, stream: true });

  // 5. run + validate. Drive the generator; validate every chunk on the way out, then validate the final.
  const gen = def.streamHandler(parsed.data, ctx);
  let step = await gen.next();
  while (!step.done) {
    const checked = def.chunk.safeParse(step.value);
    if (!checked.success) {
      throw new FacetError("internal", `capability ${id} produced an invalid chunk`, 500, {
        id,
        issues: checked.error.issues,
      });
    }
    yield checked.data as C;
    step = await gen.next();
  }

  const finalChecked = def.output.safeParse(step.value);
  if (!finalChecked.success) {
    throw new FacetError("internal", `capability ${id} produced invalid output`, 500, {
      id,
      issues: finalChecked.error.issues,
    });
  }
  return finalChecked.data as F;
}

/**
 * Drain a streaming capability to its validated final value — the bridge that lets the UNARY `execute()`
 * serve a streaming capability to a caller that does not stream. It re-uses `executeStream` verbatim (so the
 * gates and per-chunk/final validation are defined exactly once) and simply discards the chunks, returning
 * the terminal value. A surface that doesn't stream therefore still gets the same final an agent would after
 * consuming the whole stream.
 */
export async function drainStream<F = unknown>(
  registry: Registry,
  id: string,
  rawInput: unknown,
  ctx: Context,
): Promise<F> {
  const gen = executeStream<unknown, F>(registry, id, rawInput, ctx);
  let step = await gen.next();
  while (!step.done) step = await gen.next();
  return step.value;
}
