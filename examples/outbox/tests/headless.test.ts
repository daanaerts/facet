import { beforeEach, describe, expect, test } from "bun:test";
import {
  ConnectorUnavailableError,
  type Context,
  execute,
  executeStream,
  type Ledger,
  ScopeError,
} from "@facet/core";
import { devConnectors, memoryGithub } from "../connectors";
import { MemoryLedger } from "../host";
import { outbox } from "../outbox";
import { outboxRegistry } from "../registry";

/**
 * THE HEADLESS PROOF for the outbox domain. It proves the connector axis the other examples don't: handlers
 * reach external systems through `ctx.connector`, and a connector that isn't wired fails loudly as
 * `connector_unavailable` — never a silent no-op. The default in-memory connectors keep it hermetic.
 */

type Entry = {
  id: string;
  kind: string;
  target: string;
  summary: string;
  provider: string;
  createdAt: string;
};

function ctx(opts: {
  scopes: string[];
  confirm?: boolean;
  idempotencyKey?: string;
  ledger?: Ledger;
  connector?: <T>(id: string) => T;
}): Context {
  const { scopes } = opts;
  return {
    actor: { kind: "agent" as const, agentId: "test" },
    surface: "agent" as const,
    scopes,
    confirm: opts.confirm ?? false,
    idempotencyKey: opts.idempotencyKey,
    ledger: opts.ledger,
    connector: opts.connector,
    requireScope(scope: string): void {
      if (!scopes.includes(scope) && !scopes.includes("*")) throw new ScopeError(scope);
    },
    audit(): void {},
  };
}

const FIXED = "2026-06-24T00:00:00.000Z";
beforeEach(() => outbox.reset(() => FIXED));

/** A context with the dev connectors wired — the common case. */
const wired = (extra: Partial<Parameters<typeof ctx>[0]> = {}) =>
  ctx({ scopes: ["outbox:read", "outbox:send"], connector: devConnectors(), ...extra });

describe("the connector port — external effects through ctx.connector, with loud connector_unavailable", () => {
  test("a read lists the seeded outbox", async () => {
    const out = await execute(outboxRegistry(), "messages.list", {}, wired());
    expect(out).toEqual({
      messages: [
        {
          id: "out_1",
          kind: "email",
          target: "ops@acme.example",
          summary: "Welcome aboard",
          provider: "memory",
          createdAt: FIXED,
        },
      ],
    });
  });

  test("risk + reversible differ per capability: send is irreversible, open is reversible", () => {
    const reg = outboxRegistry();
    expect(reg.get("email.send")).toMatchObject({ risk: "write", reversible: false });
    expect(reg.get("issues.open")).toMatchObject({ risk: "write", reversible: true });
  });

  test("email.send is confirmation-gated, then delivers through the wired connector", async () => {
    const reg = outboxRegistry();
    const input = { to: "cust@acme.example", subject: "Hi", body: "Hello" };
    await expect(execute(reg, "email.send", input, wired())).rejects.toMatchObject({
      code: "confirmation_required",
    });

    const sent = await execute<Entry>(reg, "email.send", input, wired({ confirm: true }));
    expect(sent).toEqual({
      id: "out_2",
      kind: "email",
      target: "cust@acme.example",
      summary: "Hi",
      provider: "memory",
      createdAt: FIXED,
    });
  });

  test("email.send with NO connector port fails loudly as connector_unavailable", async () => {
    const noConnector = ctx({ scopes: ["outbox:send"], confirm: true }); // connector omitted
    const run = execute(
      outboxRegistry(),
      "email.send",
      { to: "a@b.c", subject: "s", body: "b" },
      noConnector,
    );
    await expect(run).rejects.toBeInstanceOf(ConnectorUnavailableError);
    await expect(run).rejects.toMatchObject({ code: "connector_unavailable" });
  });

  test("asking for a connector the host never registered is the same typed failure", async () => {
    // A resolver that only knows "github" — email.send asks for "email" and gets connector_unavailable.
    const githubOnly = <T>(id: string): T => {
      if (id === "github") return memoryGithub() as T;
      throw new ConnectorUnavailableError(id, `no connector registered for "${id}"`);
    };
    const run = execute(
      outboxRegistry(),
      "email.send",
      { to: "a@b.c", subject: "s", body: "b" },
      ctx({ scopes: ["outbox:send"], confirm: true, connector: githubOnly }),
    );
    await expect(run).rejects.toMatchObject({ code: "connector_unavailable" });
  });

  test("issues.open uses a DIFFERENT connector through the same port", async () => {
    const opened = await execute<Entry>(
      outboxRegistry(),
      "issues.open",
      { repo: "acme/app", title: "Bug", body: "It broke" },
      wired({ confirm: true }),
    );
    expect(opened).toMatchObject({
      kind: "issue",
      target: "acme/app",
      summary: "Bug",
      provider: "memory",
    });
  });

  test("idempotency replays the first send — never a double send", async () => {
    const reg = outboxRegistry();
    const ledger = new MemoryLedger();
    const make = () => wired({ confirm: true, idempotencyKey: "s1", ledger });
    const before = outbox.list().length;

    const first = await execute<Entry>(
      reg,
      "email.send",
      { to: "a@b.c", subject: "s", body: "b" },
      make(),
    );
    const second = await execute<Entry>(
      reg,
      "email.send",
      { to: "a@b.c", subject: "s", body: "b" },
      make(),
    );

    expect(second).toEqual(first);
    expect(outbox.list().length).toBe(before + 1); // exactly one row appended
  });

  test("outbox.tail streams each entry, then a final count", async () => {
    // Send one so there are two entries (seed + this).
    await execute(
      outboxRegistry(),
      "email.send",
      { to: "a@b.c", subject: "s", body: "b" },
      wired({ confirm: true }),
    );
    const chunks: unknown[] = [];
    const gen = executeStream(outboxRegistry(), "outbox.tail", {}, wired());
    let step = await gen.next();
    while (!step.done) {
      chunks.push(step.value);
      step = await gen.next();
    }
    expect(chunks.length).toBe(2);
    expect(step.value).toEqual({ count: 2 });
  });
});
