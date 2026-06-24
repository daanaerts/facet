import { describe, expect, test } from "bun:test";
import { defineCapability, defineStreamingCapability, describeCapability } from "@facet/core";
import { z } from "zod";

/**
 * THE HELP-PROJECTION PROOF.
 *
 * `describeCapability` is the surface-agnostic doc model — the single source every surface's help renders. It
 * re-derives nothing: the field rows, defaults, requiredness and descriptions all come out of the SAME schema
 * `execute()` validates against (via the projection adapter), so the docs cannot drift from the contract any
 * more than the advertised JSON Schema can. These tests pin the flattening and the spec passthrough.
 */

const placeOrder = defineCapability({
  id: "orders.place",
  summary: "Place an order.",
  description: "Long-form body.",
  examples: [
    { input: { sku: "WIDGET", qty: 3 }, note: "Three widgets." },
    { input: { sku: "GIZMO", qty: 1 } },
  ],
  input: z.object({
    sku: z.string().describe("The product SKU."),
    qty: z.number().int().positive().default(1).describe("How many."),
    rush: z.enum(["standard", "express"]).optional(),
  }),
  output: z.object({ id: z.string(), status: z.enum(["pending", "paid"]) }),
  scopes: ["orders:write"],
  risk: "write",
  reversible: false,
  idempotent: true,
  handler: async () => ({ id: "ord_1", status: "pending" as const }),
});

describe("describeCapability — the shared help model", () => {
  test("carries the contract a reader needs, verbatim from the def", () => {
    const doc = describeCapability(placeOrder);
    expect(doc.id).toBe("orders.place");
    expect(doc.summary).toBe("Place an order.");
    expect(doc.description).toBe("Long-form body.");
    expect(doc.risk).toBe("write");
    expect(doc.reversible).toBe(false);
    expect(doc.idempotent).toBe(true);
    expect(doc.stream).toBe(false);
    expect(doc.scopes).toEqual(["orders:write"]);
    expect(doc.surfaces).toEqual(["agent", "http", "mcp", "cli"]);
  });

  test("flattens input fields with type, requiredness, default and description from the schema", () => {
    const doc = describeCapability(placeOrder);
    const byName = Object.fromEntries(doc.input.map((f) => [f.name, f]));

    expect(byName.sku).toMatchObject({
      type: "string",
      required: true,
      description: "The product SKU.",
    });
    // a field with a default is optional on the input (pre-parse) side and carries the default value
    expect(byName.qty).toMatchObject({
      type: "integer",
      required: false,
      default: 1,
      description: "How many.",
    });
    // an enum renders its allowed values rather than the base type
    expect(byName.rush).toMatchObject({ type: '"standard"|"express"', required: false });
  });

  test("flattens output fields too, including enums", () => {
    const doc = describeCapability(placeOrder);
    const status = doc.output.find((f) => f.name === "status");
    expect(status?.type).toBe('"pending"|"paid"');
  });

  test("passes examples through untouched (documentation, never executed)", () => {
    const doc = describeCapability(placeOrder);
    expect(doc.examples).toEqual([
      { input: { sku: "WIDGET", qty: 3 }, note: "Three widgets." },
      { input: { sku: "GIZMO", qty: 1 } },
    ]);
  });

  test("a capability with no description/examples yields an absent description and an empty examples list", () => {
    const bare = defineCapability({
      id: "orders.get",
      summary: "Get an order.",
      input: z.object({ id: z.string() }),
      output: z.object({ id: z.string() }),
      handler: async (i) => ({ id: i.id }),
    });
    const doc = describeCapability(bare);
    expect(doc.description).toBeUndefined();
    expect(doc.examples).toEqual([]);
  });

  test("a streaming capability is marked stream:true and describes its final output", () => {
    const watch = defineStreamingCapability({
      id: "orders.watch",
      summary: "Stream orders.",
      input: z.object({}),
      chunk: z.object({ id: z.string() }),
      output: z.object({ count: z.number().int() }),
      async *handler() {
        yield { id: "ord_1" };
        return { count: 1 };
      },
    });
    const doc = describeCapability(watch);
    expect(doc.stream).toBe(true);
    expect(doc.risk).toBe("read");
    expect(doc.output.find((f) => f.name === "count")?.type).toBe("integer");
  });
});
