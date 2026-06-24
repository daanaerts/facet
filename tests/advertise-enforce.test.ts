import { describe, expect, test } from "bun:test";
import { defineCapability, type JsonSchema, Registry, toJsonSchema } from "@facet/core";
import { mcpTools, toolName } from "@facet/mcp";
import { CONFIRM_FIELD, IDEMPOTENCY_FIELD, mergeContextFields } from "@facet/surface-kit";
import { z } from "zod";

/**
 * ADVERTISE == ENFORCE — the central honesty property, mechanically proven (F11).
 *
 * Facet's whole safety claim is that the JSON Schema a surface ADVERTISES (an MCP tool's `inputSchema`, the
 * HTTP catalogue entry) is the SAME schema `execute()` ENFORCES. Until now that equivalence was asserted only
 * in prose (a comment on the projection seam). This test makes it a contract: for every capability we project
 * the advertised input schema, subtract ONLY the two Context-shaping fields a schema-advertising surface
 * injects (`confirm` / `idempotencyKey` — these are not part of the capability's own input; the core reads
 * them off the Context, not the validated payload), and assert what remains is byte-for-byte
 * `toJsonSchema(def.input)` — the exact projection of the schema `execute()` validates against.
 *
 * Why subtract rather than compare a read only: the injected fields are precisely the documented gap between
 * "what the surface shows" and "what the core validates" — they ride the advertised schema but are peeled back
 * off before `execute()` ever sees the input (see `splitContextFields`). Subtracting them is what isolates the
 * equivalence to the capability's own contract. We cover BOTH a read (where nothing is injected, so advertise
 * must equal enforce with no subtraction) and a write (where both fields ARE injected, the harder case).
 *
 * The advertised shape is taken from `@facet/mcp`'s real tool projection (`mcpTools`) — not re-derived here —
 * so this pins the SHIPPED surface output, not a private restatement of it. Deterministic: no I/O, no clock.
 */

/** A read: no `confirm`/`idempotencyKey` injected, so its advertised schema must already equal the enforced one. */
const read = defineCapability({
  id: "ae.read",
  summary: "Read a value.",
  input: z.object({
    source: z.string().describe("The source to read."),
    limit: z.number().int().positive().default(50).describe("How many."),
    mode: z.enum(["fast", "full"]).optional(),
  }),
  output: z.object({ value: z.number() }),
  scopes: ["ae:read"],
  handler: async () => ({ value: 1 }),
});

/** A write: `confirm` (required) and `idempotencyKey` (optional) ARE injected into the advertised schema. */
const write = defineCapability({
  id: "ae.write",
  summary: "Write a value.",
  input: z.object({
    name: z.string().describe("The name to write."),
    count: z.number().int().min(1).default(1),
  }),
  output: z.object({ id: z.string() }),
  scopes: ["ae:write"],
  risk: "write",
  handler: async (input) => ({ id: input.name }),
});

function registry(): Registry {
  const r = new Registry();
  r.register(read);
  r.register(write);
  return r;
}

/**
 * Strip ONLY the two injected Context fields from an advertised input schema, returning what the capability's
 * own input contributes. Removes them from `properties` AND from `required`, and deletes an emptied `required`
 * (matching how `mergeContextFields` omits `required` when the set is empty), so the result is directly
 * comparable to `toJsonSchema(def.input)`.
 */
function subtractInjectedFields(advertised: JsonSchema): JsonSchema {
  const out: JsonSchema = { ...advertised };

  const props = { ...((out.properties as Record<string, unknown> | undefined) ?? {}) };
  delete props[CONFIRM_FIELD];
  delete props[IDEMPOTENCY_FIELD];
  out.properties = props;

  if (Array.isArray(out.required)) {
    const required = (out.required as string[]).filter(
      (k) => k !== CONFIRM_FIELD && k !== IDEMPOTENCY_FIELD,
    );
    if (required.length > 0) out.required = required;
    else delete out.required;
  }
  return out;
}

/** The advertised input schema for a capability id, taken from @facet/mcp's REAL tool projection. */
function advertisedInputSchema(id: string): JsonSchema {
  const tool = mcpTools(registry()).find((t) => t.name === toolName(id));
  if (!tool) throw new Error(`no MCP tool projected for ${id}`);
  return tool.inputSchema as JsonSchema;
}

describe("advertise == enforce — the advertised input schema is the schema execute() validates", () => {
  test("READ: nothing is injected, so the advertised schema already equals toJsonSchema(def.input)", () => {
    const advertised = advertisedInputSchema(read.id);

    // Pin the documented invariant directly: a read's projection injects neither field.
    const props = advertised.properties as Record<string, unknown>;
    expect(CONFIRM_FIELD in props).toBe(false);
    expect(IDEMPOTENCY_FIELD in props).toBe(false);

    // Advertised == enforced, with no subtraction needed.
    expect(subtractInjectedFields(advertised)).toEqual(toJsonSchema(read.input, "input"));
    expect(advertised).toEqual(toJsonSchema(read.input, "input"));
  });

  test("WRITE: advertised MINUS the injected confirm/idempotencyKey deep-equals toJsonSchema(def.input)", () => {
    const advertised = advertisedInputSchema(write.id);

    // The two fields really ARE injected on a write — confirm is required, idempotencyKey is optional.
    const props = advertised.properties as Record<string, unknown>;
    expect(CONFIRM_FIELD in props).toBe(true);
    expect(IDEMPOTENCY_FIELD in props).toBe(true);
    expect(advertised.required as string[]).toContain(CONFIRM_FIELD);
    expect(advertised.required as string[]).not.toContain(IDEMPOTENCY_FIELD);

    // The whole point: strip exactly those two surface-supplied fields and the remainder is, byte-for-byte,
    // the projection of the schema execute() enforces. No second dialect, no drift.
    expect(subtractInjectedFields(advertised)).toEqual(toJsonSchema(write.input, "input"));
  });

  test("the injected fields are the ONLY difference (the surface adds nothing else to a write's schema)", () => {
    // Compare the advertised write schema against the read's merge path applied to the same input: the only
    // keys present in the advertised properties beyond the base input are the two we subtract.
    const advertised = advertisedInputSchema(write.id);
    const base = toJsonSchema(write.input, "input");
    const baseKeys = new Set(Object.keys(base.properties as Record<string, unknown>));
    const advertisedKeys = Object.keys(advertised.properties as Record<string, unknown>);
    const extra = advertisedKeys.filter((k) => !baseKeys.has(k));
    expect(extra.sort()).toEqual([CONFIRM_FIELD, IDEMPOTENCY_FIELD].sort());

    // And the projection the surface-kit produces is exactly what the MCP surface ships (no per-surface fork).
    expect(advertised).toEqual(mergeContextFields(write));
  });
});

/**
 * THE AUDIBLE GAP — advertise != enforce where Zod cannot project a refinement (a passing test that PINS a
 * documented limitation rather than hiding it).
 *
 * Validation is full Zod: a `.refine()` predicate runs inside `~standard.validate`, so `execute()` ENFORCES it.
 * But `z.toJSONSchema()` cannot represent an arbitrary predicate, so the refinement does NOT survive into the
 * advertised JSON Schema. That is a real, known advertise>enforce asymmetry: the wire contract is WEAKER than
 * what the core enforces. This test asserts the asymmetry exists and is exactly "the predicate is absent from
 * the schema" — so the day Zod (or a custom adapter) starts emitting it, this test goes red and the team
 * RE-DECIDES deliberately, instead of the gap silently widening or silently closing.
 */
describe("advertise != enforce — a .refine() predicate is enforced but is NOT advertised (a known, pinned gap)", () => {
  const refined = defineCapability({
    id: "ae.refined",
    summary: "Set a 4-digit PIN.",
    // The refinement ("exactly 4 digits") is ENFORCED by execute() — it is a real validation rule…
    input: z
      .object({ pin: z.string().describe("A 4-digit PIN.") })
      .refine((v) => /^\d{4}$/.test(v.pin), { message: "pin must be exactly 4 digits" }),
    output: z.object({ ok: z.boolean() }),
    scopes: ["ae:write"],
    risk: "write",
    handler: async () => ({ ok: true }),
  });

  test("the advertised schema is the plain object shape — the refinement predicate is absent", () => {
    const advertised = mergeContextFields(refined);
    const pin = (advertised.properties as Record<string, unknown>).pin as Record<string, unknown>;

    // The base field is advertised (type + description survive)…
    expect(pin).toMatchObject({ type: "string", description: "A 4-digit PIN." });

    // …but NOTHING in the advertised schema expresses "exactly 4 digits": no pattern, no length bounds, and no
    // JSON-Schema combinator a refinement might have lowered to. The wire contract is strictly weaker.
    const advertisedJson = JSON.stringify(advertised);
    expect(advertisedJson).not.toContain("pattern");
    expect(advertisedJson).not.toContain("\\\\d{4}"); // the predicate's regex never reaches the schema
    expect(pin.pattern).toBeUndefined();
    expect(pin.minLength).toBeUndefined();
    expect(pin.maxLength).toBeUndefined();
    expect(advertised.allOf).toBeUndefined();
    expect(advertised.not).toBeUndefined();
  });

  test("yet execute() DOES enforce the refinement — proving the gap is advertise<enforce, not a missing rule", async () => {
    const r = new Registry();
    r.register(refined);
    const { buildContext, execute } = await import("@facet/core");
    const ctx = buildContext({
      actor: { kind: "service" },
      scopes: ["ae:write"],
      surface: "agent",
      confirm: true,
    });

    // A value the ADVERTISED schema would accept (it is a string) but the ENFORCED refinement rejects.
    await expect(execute(r, refined.id, { pin: "abc" }, ctx)).rejects.toMatchObject({
      code: "validation",
    });
    // The valid case still runs, so the rule is a genuine refinement, not a broken schema.
    await expect(execute(r, refined.id, { pin: "1234" }, ctx)).resolves.toEqual({ ok: true });
  });
});
