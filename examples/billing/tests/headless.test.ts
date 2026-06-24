import { beforeEach, describe, expect, test } from "bun:test";
import { type Context, execute, executeStream, type Ledger, ScopeError } from "@facet/core";
import { gateway, resetGateway } from "../gateway";
import { MemoryLedger } from "../host";
import { billingRegistry } from "../registry";

/**
 * THE HEADLESS PROOF for the billing domain. Every test runs a capability through the chokepoint with a BARE
 * context. It proves the money axis the other examples don't: the `reversible` dimension declared distinctly
 * from `risk`, the destructive-refund confirmation wedge, and — the one that matters most for money —
 * idempotency as a SAFETY property: a double-submitted refund replays instead of refunding twice.
 */

type Payment = {
  id: string;
  amountCents: number;
  currency: string;
  customer: string;
  status: "succeeded" | "partially_refunded" | "refunded";
  refundedCents: number;
  createdAt: string;
};

function ctx(opts: {
  scopes: string[];
  confirm?: boolean;
  idempotencyKey?: string;
  ledger?: Ledger;
}): Context {
  const { scopes } = opts;
  return {
    actor: { kind: "agent" as const, agentId: "test" },
    surface: "agent" as const,
    scopes,
    confirm: opts.confirm ?? false,
    idempotencyKey: opts.idempotencyKey,
    ledger: opts.ledger,
    requireScope(scope: string): void {
      if (!scopes.includes(scope) && !scopes.includes("*")) throw new ScopeError(scope);
    },
    audit(): void {},
  };
}

const FIXED = "2026-06-24T00:00:00.000Z";
beforeEach(() => resetGateway(() => FIXED));

const write = (extra: Partial<Parameters<typeof ctx>[0]> = {}) =>
  ctx({ scopes: ["payments:read", "payments:write"], ...extra });

describe("money on the chokepoint — reversible, the destructive wedge, and idempotency-as-safety", () => {
  test("a read lists the seeded payments through the gateway port", async () => {
    const out = await execute(billingRegistry(), "payments.list", {}, write());
    expect(out).toEqual({
      payments: [
        {
          id: "pay_1",
          amountCents: 4999,
          currency: "usd",
          customer: "cus_alice",
          status: "succeeded",
          refundedCents: 0,
          createdAt: FIXED,
        },
        {
          id: "pay_2",
          amountCents: 500000,
          currency: "usd",
          customer: "cus_bob",
          status: "succeeded",
          refundedCents: 0,
          createdAt: FIXED,
        },
      ],
    });
  });

  test("risk + reversible are declared so a surface can calibrate confirmation copy", () => {
    const reg = billingRegistry();
    expect(reg.get("payments.charge")).toMatchObject({ risk: "write", reversible: true });
    expect(reg.get("payments.refund")).toMatchObject({ risk: "destructive", reversible: false });
  });

  test("a charge is confirmation-gated, then succeeds (and is reversible)", async () => {
    const reg = billingRegistry();
    const unconfirmed = execute(
      reg,
      "payments.charge",
      { amountCents: 2500, customer: "cus_x" },
      write(),
    );
    await expect(unconfirmed).rejects.toMatchObject({ code: "confirmation_required" });

    const charged = await execute<Payment>(
      reg,
      "payments.charge",
      { amountCents: 2500, customer: "cus_x" },
      write({ confirm: true }),
    );
    expect(charged).toMatchObject({
      id: "pay_3",
      amountCents: 2500,
      status: "succeeded",
      refundedCents: 0,
    });
  });

  test("charge idempotency replays the first charge — never a double charge", async () => {
    const reg = billingRegistry();
    const ledger = new MemoryLedger();
    const make = () => write({ confirm: true, idempotencyKey: "c1", ledger });
    const before = (await gateway.list()).length;

    const first = await execute<Payment>(
      reg,
      "payments.charge",
      { amountCents: 700, customer: "cus_x" },
      make(),
    );
    const second = await execute<Payment>(
      reg,
      "payments.charge",
      { amountCents: 700, customer: "cus_x" },
      make(),
    );

    expect(second).toEqual(first);
    expect((await gateway.list()).length).toBe(before + 1); // exactly one new payment
  });

  test("a refund is destructive — refused without confirm, then moves the money", async () => {
    const reg = billingRegistry();
    const unconfirmed = execute(reg, "payments.refund", { paymentId: "pay_2" }, write());
    await expect(unconfirmed).rejects.toMatchObject({ code: "confirmation_required" });

    const refunded = await execute<Payment>(
      reg,
      "payments.refund",
      { paymentId: "pay_2" },
      write({ confirm: true }),
    );
    expect(refunded).toMatchObject({ id: "pay_2", status: "refunded", refundedCents: 500000 });
  });

  test("a partial refund leaves the payment partially_refunded", async () => {
    const refunded = await execute<Payment>(
      billingRegistry(),
      "payments.refund",
      { paymentId: "pay_2", amountCents: 100000 },
      write({ confirm: true }),
    );
    expect(refunded).toMatchObject({ status: "partially_refunded", refundedCents: 100000 });
  });

  test("refund idempotency replays the first refund — the money-safety guarantee under a double submit", async () => {
    const reg = billingRegistry();
    const ledger = new MemoryLedger();
    const make = () => write({ confirm: true, idempotencyKey: "r1", ledger });

    const first = await execute<Payment>(reg, "payments.refund", { paymentId: "pay_1" }, make());
    const second = await execute<Payment>(reg, "payments.refund", { paymentId: "pay_1" }, make());

    expect(second).toEqual(first); // replayed, NOT a second refund
    // pay_1 was refunded exactly once: refundedCents is its full amount, not double (which would have thrown).
    const pay1 = (await gateway.list()).find((p) => p.id === "pay_1");
    expect(pay1).toMatchObject({ refundedCents: 4999, status: "refunded" });
  });

  test("refunding more than the refundable balance is a conflict", async () => {
    const run = execute(
      billingRegistry(),
      "payments.refund",
      { paymentId: "pay_1", amountCents: 999999 },
      write({ confirm: true }),
    );
    await expect(run).rejects.toMatchObject({ code: "conflict" });
  });

  test("refunding an unknown payment 404s with the shared not_found taxonomy", async () => {
    const run = execute(
      billingRegistry(),
      "payments.refund",
      { paymentId: "pay_999" },
      write({ confirm: true }),
    );
    await expect(run).rejects.toMatchObject({ code: "not_found" });
  });

  test("export streams one row per payment with a running net, then a final total", async () => {
    const chunks: unknown[] = [];
    const gen = executeStream(billingRegistry(), "payments.export", {}, write());
    let step = await gen.next();
    while (!step.done) {
      chunks.push(step.value);
      step = await gen.next();
    }
    expect(chunks).toEqual([
      {
        payment: {
          id: "pay_1",
          amountCents: 4999,
          currency: "usd",
          customer: "cus_alice",
          status: "succeeded",
          refundedCents: 0,
          createdAt: FIXED,
        },
        runningNetCents: 4999,
      },
      {
        payment: {
          id: "pay_2",
          amountCents: 500000,
          currency: "usd",
          customer: "cus_bob",
          status: "succeeded",
          refundedCents: 0,
          createdAt: FIXED,
        },
        runningNetCents: 504999,
      },
    ]);
    expect(step.value).toEqual({ count: 2, netCents: 504999 });
  });
});
