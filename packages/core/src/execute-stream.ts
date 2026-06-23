import type { Context } from "./context";
import { FacetError, KillSwitchError, NotFoundError, ValidationError } from "./errors";
import type { Registry } from "./registry";
import { validateStandard } from "./standard-schema";

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
 *
 * MID-STREAM FAILURE CONTRACT (see `docs/STREAMING-CONTRACT.md`): once chunk 1 is out the read gates have all
 * passed, so any later failure is a TRUE mid-stream error — a chunk that fails its `chunk` schema, or the
 * handler throwing part-way through. The canonical behavior, which every surface renders, is: yield the K good
 * chunks, then THROW a `FacetError` (NEVER a silent truncation, never a "clean" early return). Step 5 below
 * guarantees the thrown thing is always a `FacetError`: a chunk-validation failure throws one directly, and a
 * handler throw is normalized — a `FacetError` passes through unchanged, a non-`FacetError` is wrapped as
 * `internal` (the exact mapping every surface already applies to a non-`FacetError` on the unary path).
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

  // 2. validate input against the capability's own schema — the surface never validates. Same Standard Schema
  //    contract as the unary path: a `.issues` result becomes the identical `validation` ValidationError.
  const parsed = await validateStandard(def.input, rawInput);
  if (parsed.issues) throw new ValidationError(id, parsed.issues);

  // 3. authz — declared scopes enforced BEFORE any chunk is produced (a missing scope is refused here, so
  //    no partial stream ever leaks past an authz failure).
  for (const scope of def.scopes) ctx.requireScope(scope);

  // 4. audit — one event per streamed invocation, same as a unary call.
  ctx.audit("capability.invoke", { id, risk: def.risk, surface: ctx.surface, stream: true });

  // 5. run + validate. Drive the generator; validate every chunk on the way out, then validate the final.
  //    `advance` normalizes a handler throw so the mid-stream contract holds: a `FacetError` the handler threw
  //    propagates unchanged (it keeps its own code), while any other thrown value becomes `internal` — so a
  //    surface downstream renders exactly ONE error vocabulary whether the failure was the engine's (a bad
  //    chunk) or the handler's. This is the streaming twin of how the unary surfaces map a non-`FacetError`.
  const gen = def.streamHandler(parsed.value, ctx);
  const advance = async (): Promise<IteratorResult<unknown, unknown>> => {
    try {
      return await gen.next();
    } catch (err) {
      if (err instanceof FacetError) throw err;
      throw new FacetError("internal", `capability ${id} failed mid-stream`, 500, {
        id,
        cause: err instanceof Error ? err.message : String(err),
      });
    }
  };

  let step = await advance();
  while (!step.done) {
    const checked = await validateStandard(def.chunk, step.value);
    if (checked.issues) {
      // A chunk that fails its schema — thrown AFTER the chunks already yielded, never a silent drop.
      throw new FacetError("internal", `capability ${id} produced an invalid chunk`, 500, {
        id,
        issues: checked.issues,
      });
    }
    yield checked.value as C;
    step = await advance();
  }

  const finalChecked = await validateStandard(def.output, step.value);
  if (finalChecked.issues) {
    throw new FacetError("internal", `capability ${id} produced invalid output`, 500, {
      id,
      issues: finalChecked.issues,
    });
  }
  return finalChecked.value as F;
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
