import { ConnectorUnavailableError, FacetError, NotFoundError } from "@facet/core";

/**
 * THE PORT this example demonstrates: a payment gateway with an in-memory DEFAULT (so the app runs with zero
 * setup and the test suite stays hermetic) and a REAL adapter alongside it — a genuine Stripe client over
 * `fetch`. Both satisfy one {@link PaymentGateway} interface; the capabilities are written against the
 * interface, never against Stripe. The active gateway is chosen ONCE, by env: set `STRIPE_SECRET_KEY` and the
 * same handlers hit Stripe; leave it unset and they hit the in-memory fake. That single switch is the whole
 * "library you call + adapters you mount" thesis, applied to money.
 *
 * Money is in integer CENTS throughout — never floats — so there is no rounding to reason about.
 */

export interface Payment {
  id: string;
  amountCents: number;
  currency: string;
  customer: string;
  status: "succeeded" | "partially_refunded" | "refunded";
  refundedCents: number;
  createdAt: string;
}

export interface ChargeInput {
  amountCents: number;
  currency?: string;
  customer: string;
}

/** The one interface every capability depends on. Methods may be sync (memory) or async (Stripe). */
export interface PaymentGateway {
  list(): Payment[] | Promise<Payment[]>;
  charge(input: ChargeInput): Payment | Promise<Payment>;
  /** Refund up to the refundable balance; omit `amountCents` for a full refund of what remains. */
  refund(paymentId: string, amountCents?: number): Payment | Promise<Payment>;
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────────────
// Adapter 1 — IN-MEMORY (the default). Deterministic ids (`pay_<n>`) and a swappable clock so the test suite
// can pin output. This is what every entrypoint and test uses unless `STRIPE_SECRET_KEY` is set.
// ──────────────────────────────────────────────────────────────────────────────────────────────────────────

class MemoryGateway implements PaymentGateway {
  #payments = new Map<string, Payment>();
  #seq = 0;
  #clock: () => string = () => new Date().toISOString();

  constructor() {
    this.#seed();
  }

  list(): Payment[] {
    return [...this.#payments.values()];
  }

  charge(input: ChargeInput): Payment {
    this.#seq += 1;
    const payment: Payment = {
      id: `pay_${this.#seq}`,
      amountCents: input.amountCents,
      currency: input.currency ?? "usd",
      customer: input.customer,
      status: "succeeded",
      refundedCents: 0,
      createdAt: this.#clock(),
    };
    this.#payments.set(payment.id, payment);
    return payment;
  }

  refund(paymentId: string, amountCents?: number): Payment {
    const payment = this.#payments.get(paymentId);
    if (!payment) throw new NotFoundError(`payment not found: ${paymentId}`, { paymentId });
    const refundable = payment.amountCents - payment.refundedCents;
    const amount = amountCents ?? refundable;
    if (amount <= 0 || amount > refundable) {
      throw new FacetError(
        "conflict",
        `refund of ${amount} exceeds refundable balance ${refundable} on ${paymentId}`,
        409,
        { paymentId, refundable },
      );
    }
    const refundedCents = payment.refundedCents + amount;
    const updated: Payment = {
      ...payment,
      refundedCents,
      status: refundedCents === payment.amountCents ? "refunded" : "partially_refunded",
    };
    this.#payments.set(paymentId, updated);
    return updated;
  }

  /** Test helper — reset to seed state, optionally pinning the clock so `createdAt` is reproducible. */
  reset(clock?: () => string): void {
    this.#clock = clock ?? (() => new Date().toISOString());
    this.#payments.clear();
    this.#seq = 0;
    this.#seed();
  }

  #seed(): void {
    // Two payments so a refund has something to act on — one small, one large (so "refund $5000" is dramatic).
    this.charge({ amountCents: 4999, currency: "usd", customer: "cus_alice" });
    this.charge({ amountCents: 500000, currency: "usd", customer: "cus_bob" });
  }
}

const memory = new MemoryGateway();

/** Reset the in-memory gateway — a test helper, only meaningful when `STRIPE_SECRET_KEY` is unset. */
export function resetGateway(clock?: () => string): void {
  memory.reset(clock);
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────────────
// Adapter 2 — REAL (Stripe over fetch). A genuine client: it talks to Stripe's REST API with the secret key,
// passes an Idempotency-Key on writes, and maps Stripe's objects onto our {@link Payment}. It requires
// `STRIPE_SECRET_KEY` (use a TEST-mode key) and a network, so — unlike the in-memory adapter — it is NOT run by
// the test suite; it is the real adapter that ships ALONGSIDE the default. A network failure becomes a
// `ConnectorUnavailableError`; a Stripe 4xx becomes the matching FacetError. Field mapping is illustrative.
// ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export function stripeGateway(secretKey: string): PaymentGateway {
  const base = "https://api.stripe.com/v1";

  async function call(
    path: string,
    method: "GET" | "POST",
    body?: Record<string, string | number>,
    idempotencyKey?: string,
  ): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${secretKey}`,
      "content-type": "application/x-www-form-urlencoded",
    };
    if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
    let res: Response;
    try {
      res = await fetch(`${base}${path}`, { method, headers, body: body ? form(body) : undefined });
    } catch (err) {
      throw new ConnectorUnavailableError(
        "stripe",
        err instanceof Error ? err.message : "network error",
      );
    }
    const json = (await res.json()) as Record<string, unknown>;
    if (!res.ok) {
      const message = (json.error as { message?: string } | undefined)?.message ?? "stripe error";
      throw new FacetError(res.status === 404 ? "not_found" : "conflict", message, res.status);
    }
    return json;
  }

  return {
    async list(): Promise<Payment[]> {
      const r = await call("/payment_intents?limit=100", "GET");
      return ((r.data as Record<string, unknown>[]) ?? []).map(toPayment);
    },
    async charge(input: ChargeInput): Promise<Payment> {
      const r = await call("/payment_intents", "POST", {
        amount: input.amountCents,
        currency: input.currency ?? "usd",
        customer: input.customer,
        confirm: "true",
      });
      return toPayment(r);
    },
    async refund(paymentId: string, amountCents?: number): Promise<Payment> {
      await call(
        "/refunds",
        "POST",
        amountCents
          ? { payment_intent: paymentId, amount: amountCents }
          : { payment_intent: paymentId },
      );
      // Re-fetch the payment intent so we return the same {@link Payment} shape the in-memory adapter does.
      return toPayment(await call(`/payment_intents/${paymentId}`, "GET"));
    },
  };
}

/** Map a Stripe PaymentIntent onto our {@link Payment}. Illustrative — a real adapter would map more fields. */
function toPayment(pi: Record<string, unknown>): Payment {
  const amountCents = typeof pi.amount === "number" ? pi.amount : 0;
  const refundedCents = typeof pi.amount_refunded === "number" ? pi.amount_refunded : 0;
  return {
    id: String(pi.id),
    amountCents,
    currency: String(pi.currency ?? "usd"),
    customer: String(pi.customer ?? ""),
    refundedCents,
    status:
      refundedCents === 0
        ? "succeeded"
        : refundedCents >= amountCents
          ? "refunded"
          : "partially_refunded",
    createdAt:
      typeof pi.created === "number"
        ? new Date(pi.created * 1000).toISOString()
        : new Date().toISOString(),
  };
}

function form(body: Record<string, string | number>): string {
  return Object.entries(body)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
}

/**
 * The active gateway, chosen once at module load. The capabilities import THIS — a single `PaymentGateway` —
 * and never learn which adapter backs it. Flip to real Stripe by exporting `STRIPE_SECRET_KEY` in the env.
 */
export const gateway: PaymentGateway = process.env.STRIPE_SECRET_KEY
  ? stripeGateway(process.env.STRIPE_SECRET_KEY)
  : memory;
