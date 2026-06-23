import { beforeEach, describe, expect, test } from "bun:test";
import { Registry } from "@facet/core";
import { createFetchHandler } from "@facet/http";
import logsBoom from "../../../examples/logs/capabilities/logs.boom.cap";
import logsFollow from "../../../examples/logs/capabilities/logs.follow.cap";
import logsTail from "../../../examples/logs/capabilities/logs.tail.cap";
import { store } from "../../../examples/logs/store";

/**
 * THE HTTP STREAMING PROOF.
 *
 * `logs.follow` — a streaming capability — projected onto HTTP via the PORTABLE Web fetch handler, driven
 * headlessly with `handler(new Request(...))` (no port, no real fetch, no web framework). WITH
 * `Accept: text/event-stream` the surface renders the core's `executeStream()` as Server-Sent Events: one
 * `data: <json>` frame per validated chunk, then a terminal `event: result` frame carrying the validated final.
 * WITHOUT that Accept header the same capability drains via `execute()` to its final JSON (back-compat). Every
 * invariant still lives in `@facet/core`; the surface — built on `ReadableStream` + `Response` alone — only
 * renders.
 */

/** A registry with the streaming `logs.follow`, its unary sibling `logs.tail`, and the mid-stream fixture. */
function registry(): Registry {
  const r = new Registry();
  for (const def of [logsFollow, logsTail, logsBoom]) r.register(def);
  return r;
}

/** A streaming logs fetch handler behind a dev authenticator that grants the scopes (default: logs:read). */
function makeApp(scopes: string[] = ["logs:read"]) {
  return createFetchHandler(registry(), {
    authenticate: () => ({ actor: { kind: "service" }, scopes }),
  });
}

/** One parsed SSE frame: its optional `event` name and the JSON-decoded `data` payload. */
interface SseFrame {
  event?: string;
  data: unknown;
}

/**
 * Parse an SSE response body into frames. Frames are separated by a blank line; within a frame we read the
 * `event:` line (if any) and JSON-parse the `data:` line — exactly what an EventSource client does.
 */
function parseSse(body: string): SseFrame[] {
  return body
    .split("\n\n")
    .filter((block) => block.trim().length > 0)
    .map((block) => {
      const frame: SseFrame = { data: undefined };
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) frame.event = line.slice("event:".length).trim();
        else if (line.startsWith("data:"))
          frame.data = JSON.parse(line.slice("data:".length).trim());
      }
      return frame;
    });
}

/** POST a capability id with a JSON body + headers; returns status, content-type, and the raw text body. */
async function post(
  app: ReturnType<typeof makeApp>,
  id: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; contentType: string; text: string }> {
  const res = await app(
    new Request(`http://localhost/cap/${id}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );
  return {
    status: res.status,
    contentType: res.headers.get("content-type") ?? "",
    text: await res.text(),
  };
}

beforeEach(() => store.reset());

describe("a streaming capability over HTTP — SSE with Accept: text/event-stream", () => {
  test("yields N data frames then a terminal result frame", async () => {
    const { status, contentType, text } = await post(
      makeApp(),
      "logs.follow",
      { source: "build" },
      { accept: "text/event-stream" },
    );
    expect(status).toBe(200);
    expect(contentType).toContain("text/event-stream");

    const frames = parseSse(text);
    // "build" has three lines → three chunk data frames + one terminal result frame.
    expect(frames).toHaveLength(4);

    // The first three are plain `data:` chunk frames, in order, with no event name.
    expect(frames.slice(0, 3)).toEqual([
      { event: undefined, data: { line: "build started", n: 1 } },
      { event: undefined, data: { line: "compiling", n: 2 } },
      { event: undefined, data: { line: "build ok", n: 3 } },
    ]);
    // The last frame is the `result` event carrying the validated final value.
    expect(frames[3]).toEqual({ event: "result", data: { source: "build", lineCount: 3 } });
  });

  test("an unknown source yields zero chunk frames and just the terminal result frame", async () => {
    const { status, text } = await post(
      makeApp(),
      "logs.follow",
      { source: "nope" },
      { accept: "text/event-stream" },
    );
    expect(status).toBe(200);
    const frames = parseSse(text);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual({ event: "result", data: { source: "nope", lineCount: 0 } });
  });

  test("WITHOUT the SSE Accept header, the same capability drains to final JSON (back-compat)", async () => {
    const { status, contentType, text } = await post(makeApp(), "logs.follow", { source: "build" });
    expect(status).toBe(200);
    expect(contentType).toContain("application/json");
    // A plain client gets the terminal value, exactly as a non-streaming read would — no SSE framing.
    expect(JSON.parse(text)).toEqual({ source: "build", lineCount: 3 });
  });

  test("a pre-stream failure (bad input) is a normal JSON error, NOT a half-open SSE stream", async () => {
    const { status, contentType, text } = await post(
      makeApp(),
      "logs.follow",
      { source: "" },
      { accept: "text/event-stream" },
    );
    expect(status).toBe(422);
    // The error mapped to a JSON body because the first pull (which runs validation) was primed before the
    // SSE response committed — the client never sees a 200 stream that then breaks.
    expect(contentType).not.toContain("text/event-stream");
    expect(JSON.parse(text)).toMatchObject({ code: "validation" });
  });

  test("a missing scope is refused before any frame → 403 JSON, not a stream", async () => {
    const { status, contentType, text } = await post(
      makeApp([]),
      "logs.follow",
      { source: "build" },
      { accept: "text/event-stream" },
    );
    expect(status).toBe(403);
    expect(contentType).not.toContain("text/event-stream");
    expect(JSON.parse(text)).toMatchObject({ code: "forbidden" });
  });
});

/**
 * MID-STREAM FAILURE over HTTP SSE (see `docs/STREAMING-CONTRACT.md`). The 200 + `text/event-stream` status is
 * already committed once the first frame is out, so a failure AFTER chunk K cannot be a status. Instead the
 * surface emits the K `data:` chunk frames, then a TERMINAL `event: error` frame carrying `{ code, message }`,
 * and ends — NOT an `event: result` frame. The status stays 200 (the stream opened successfully); the failure
 * lives in-band. Both triggers — a handler throw and a bad chunk — render identically (only the code differs).
 */
describe("mid-stream failure over SSE: K data frames, then a terminal event: error frame", () => {
  const TWO_DATA_FRAMES = [
    { event: undefined, data: { line: "boom started", n: 1 } },
    { event: undefined, data: { line: "still fine", n: 2 } },
  ];

  test("a handler throw → two data frames, then event: error carrying the typed code (200, no result frame)", async () => {
    const { status, contentType, text } = await post(
      makeApp(),
      "logs.boom",
      { mode: "throw" },
      { accept: "text/event-stream" },
    );
    // The stream OPENED fine — status is the already-committed 200 SSE, never the FacetError's 501.
    expect(status).toBe(200);
    expect(contentType).toContain("text/event-stream");

    const frames = parseSse(text);
    expect(frames).toHaveLength(3);
    // The two valid chunks arrived in order as plain data frames …
    expect(frames.slice(0, 2)).toEqual(TWO_DATA_FRAMES);
    // … then the terminal frame is `event: error` with the FacetError's own code/message — NOT a result frame.
    expect(frames[2]).toEqual({
      event: "error",
      data: { code: "connector_unavailable", message: "log source went away mid-stream" },
    });
    // A failed stream emits NO result frame — the terminal event name is how a client tells failure from done.
    expect(frames.some((f) => f.event === "result")).toBe(false);
  });

  test("a bad chunk → two data frames, then event: error with code internal (200, no result frame)", async () => {
    const { status, contentType, text } = await post(
      makeApp(),
      "logs.boom",
      { mode: "bad-chunk" },
      { accept: "text/event-stream" },
    );
    expect(status).toBe(200);
    expect(contentType).toContain("text/event-stream");

    const frames = parseSse(text);
    expect(frames).toHaveLength(3);
    expect(frames.slice(0, 2)).toEqual(TWO_DATA_FRAMES);
    expect(frames[2]).toMatchObject({ event: "error", data: { code: "internal" } });
    expect(frames.some((f) => f.event === "result")).toBe(false);
  });
});
