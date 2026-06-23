import { beforeEach, describe, expect, test } from "bun:test";
import { createLogsHttpApp } from "../../../examples/logs/http";
import { store } from "../../../examples/logs/store";

/**
 * THE HTTP PROOF.
 *
 * The `logs` registry projected onto HTTP, driven entirely headlessly — every request is
 * `app.handle(new Request("http://localhost/…"))`, with NO port bound and NO real fetch. If the carved
 * surface had reached back for an MF spine concept (a tenant header, a db, an install gate) these would not
 * pass with the bare dev authenticator the example supplies. They do: the same generic `POST /cap/:id`
 * serves a read, a confirmation-gated write, a validation failure and an unknown id, and `GET /cap` lists
 * exactly the http capabilities.
 */

/** A fresh app per test so the closed-over idempotency ledger does not leak across cases. */
function makeApp() {
  return createLogsHttpApp();
}

/** POST a capability id with an optional JSON body and headers; returns the parsed JSON + status. */
async function post(
  app: ReturnType<typeof makeApp>,
  id: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: unknown }> {
  const init: RequestInit = {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await app.handle(new Request(`http://localhost/cap/${id}`, init));
  return { status: res.status, json: await res.json() };
}

beforeEach(() => store.reset());

describe("the logs registry over HTTP — one generic POST /cap/:id", () => {
  test("GET /health → { ok: true }", async () => {
    const res = await makeApp().handle(new Request("http://localhost/health"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("a read (logs.tail) returns 200 + the correct lines", async () => {
    const { status, json } = await post(makeApp(), "logs.tail", { source: "build" });
    expect(status).toBe(200);
    expect(json).toEqual({
      source: "build",
      lines: ["build started", "compiling", "build ok"],
    });
  });

  test("a write (jobs.start) WITHOUT x-facet-confirm → 409 confirmation_required", async () => {
    const { status, json } = await post(makeApp(), "jobs.start", { name: "nightly" });
    expect(status).toBe(409);
    expect(json).toMatchObject({ code: "confirmation_required" });
    expect(store.listJobs()).toHaveLength(0); // the handler never ran
  });

  test("a write (jobs.start) WITH x-facet-confirm: true → 200 and the job runs", async () => {
    const { status, json } = await post(
      makeApp(),
      "jobs.start",
      { name: "nightly" },
      { "x-facet-confirm": "true" },
    );
    expect(status).toBe(200);
    expect(json).toMatchObject({ name: "nightly", status: "running" });
    expect((json as { id: string }).id).toMatch(/^job_/);
    expect(store.listJobs()).toHaveLength(1);
  });

  test("bad input → 422 validation (the capability's own schema, not the surface)", async () => {
    const { status, json } = await post(makeApp(), "logs.tail", { source: "" });
    expect(status).toBe(422);
    expect(json).toMatchObject({ code: "validation" });
  });

  test("an unknown capability id → 404 not_found", async () => {
    const { status, json } = await post(makeApp(), "logs.nope", {});
    expect(status).toBe(404);
    expect(json).toMatchObject({ code: "not_found" });
  });

  test("GET /cap lists exactly the http capabilities, each with id/risk/surfaces/schema", async () => {
    const res = await makeApp().handle(new Request("http://localhost/cap"));
    expect(res.status).toBe(200);
    const { capabilities } = (await res.json()) as {
      capabilities: Array<{
        id: string;
        risk: string;
        surfaces: string[];
        input: Record<string, unknown>;
        output: Record<string, unknown>;
      }>;
    };

    const ids = capabilities.map((c) => c.id).sort();
    // The logs registry projects the jobs trio + the unary `logs.tail` AND the two streaming reads
    // (`logs.follow` and the mid-stream-failure fixture `logs.boom`) — all declare http, so all appear.
    expect(ids).toEqual([
      "jobs.cancel",
      "jobs.list",
      "jobs.start",
      "logs.boom",
      "logs.follow",
      "logs.tail",
    ]);

    for (const entry of capabilities) {
      expect(entry.surfaces).toContain("http");
      expect(entry.input).toMatchObject({ type: "object" });
      expect(entry.output).toMatchObject({ type: "object" });
    }

    const tail = capabilities.find((c) => c.id === "logs.tail");
    expect(tail?.risk).toBe("read");
    const cancel = capabilities.find((c) => c.id === "jobs.cancel");
    expect(cancel?.risk).toBe("destructive");
  });

  test("GET /cap/:id returns one entry, 404 for an unknown id", async () => {
    const app = makeApp();
    const ok = await app.handle(new Request("http://localhost/cap/logs.tail"));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ id: "logs.tail", risk: "read" });

    const missing = await app.handle(new Request("http://localhost/cap/logs.nope"));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: "not_found" });
  });

  test("a destructive write (jobs.cancel) is confirmation-gated, then runs and 404s a missing target", async () => {
    const app = makeApp();
    const started = await post(
      app,
      "jobs.start",
      { name: "nightly" },
      { "x-facet-confirm": "true" },
    );
    const id = (started.json as { id: string }).id;

    // unconfirmed cancel → 409
    const unconfirmed = await post(app, "jobs.cancel", { id });
    expect(unconfirmed.status).toBe(409);
    expect(unconfirmed.json).toMatchObject({ code: "confirmation_required" });

    // confirmed cancel → 200
    const cancelled = await post(app, "jobs.cancel", { id }, { "x-facet-confirm": "true" });
    expect(cancelled.status).toBe(200);
    expect(cancelled.json).toEqual({ id, status: "cancelled" });

    // confirmed cancel of a missing target → 404
    const missing = await post(
      app,
      "jobs.cancel",
      { id: "job_999" },
      { "x-facet-confirm": "true" },
    );
    expect(missing.status).toBe(404);
    expect(missing.json).toMatchObject({ code: "not_found" });
  });

  test("idempotency: a retried jobs.start with the same key replays the first job", async () => {
    const app = makeApp();
    const headers = { "x-facet-confirm": "true", "x-facet-idempotency-key": "k1" };

    const first = await post(app, "jobs.start", { name: "nightly" }, headers);
    const second = await post(app, "jobs.start", { name: "nightly" }, headers);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.json).toEqual(first.json); // same job replayed
    expect(store.listJobs()).toHaveLength(1); // the handler ran exactly once
  });

  test("a missing scope is refused centrally → 403 forbidden", async () => {
    // The dev authenticator grants logs:read + jobs:*; assert the surface forwards a ScopeError unchanged
    // by driving a registry whose authenticator grants nothing. Built inline so the example stays a happy
    // path while the surface's error mapping is still proven.
    const { createHttpApp } = await import("@facet/http");
    const { logsRegistry } = await import("../../../examples/logs/http");
    const app = createHttpApp(logsRegistry(), {
      authenticate: () => ({ actor: { kind: "service" }, scopes: [] }),
    });
    const res = await app.handle(
      new Request("http://localhost/cap/jobs.list", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "forbidden" });
  });

  test("an unauthenticated request (authenticate → null) → 401 unauthorized", async () => {
    const { createHttpApp } = await import("@facet/http");
    const { logsRegistry } = await import("../../../examples/logs/http");
    const app = createHttpApp(logsRegistry(), { authenticate: () => null });
    const res = await app.handle(
      new Request("http://localhost/cap/logs.tail", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: "build" }),
      }),
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: "unauthorized" });
  });
});
