import { describe, expect, test } from "bun:test";
import { assertParity, type StreamResult, type SurfaceResult } from "@facet/parity";

/**
 * `assertParity` unit guard — the harness's one assertion must itself behave, since every parity test leans on
 * it. We check the three things that matter: agreeing legs pass silently, a single diverging leg fails with a
 * diff that NAMES it against the baseline reference, and the helper refuses a degenerate single-leg call (which
 * would otherwise "pass" vacuously and hide a wiring mistake). Both normalized shapes are exercised.
 */

describe("assertParity", () => {
  test("passes silently when every leg agrees (unary)", () => {
    const agree: Record<string, SurfaceResult> = {
      execute: { output: { value: 1 } },
      http: { output: { value: 1 } },
      mcp: { output: { value: 1 } },
    };
    expect(() => assertParity(agree)).not.toThrow();
  });

  test("key order does not matter — canonical comparison is order-independent", () => {
    const agree: Record<string, SurfaceResult> = {
      execute: { output: { a: 1, b: 2 } },
      http: { output: { b: 2, a: 1 } },
    };
    expect(() => assertParity(agree)).not.toThrow();
  });

  test("an absent output and an absent errorCode compare equal (the unset half drops out)", () => {
    // `viaExecute` returns `{ output }`; a surface that returned `{ output, errorCode: undefined }` must still
    // be in parity — `undefined` fields drop out of canonical JSON, so the two are equal.
    const agree: Record<string, SurfaceResult> = {
      execute: { output: { ok: true } },
      http: { output: { ok: true }, errorCode: undefined },
    };
    expect(() => assertParity(agree)).not.toThrow();
  });

  test("fails with a diff naming the diverging leg against the reference", () => {
    const disagree: Record<string, SurfaceResult> = {
      execute: { errorCode: "not_found" },
      http: { errorCode: "not_found" },
      cli: { errorCode: "validation" }, // the drifter
    };
    expect(() => assertParity(disagree)).toThrow(/parity FAILED/);
    expect(() => assertParity(disagree)).toThrow(/cli/);
    // The reference is the baseline leg, not merely the first key.
    expect(() => assertParity(disagree)).toThrow(/reference "execute"/);
  });

  test("streaming: a leg with a different chunk sequence fails", () => {
    const disagree: Record<string, StreamResult> = {
      executeStream: { chunks: [{ n: 1 }, { n: 2 }], result: { count: 2 } },
      http: { chunks: [{ n: 1 }], result: { count: 2 } }, // dropped a chunk
    };
    expect(() => assertParity(disagree)).toThrow(/parity FAILED/);
  });

  test("streaming: same chunks but a different termination fails", () => {
    const disagree: Record<string, StreamResult> = {
      executeStream: { chunks: [{ n: 1 }], errorCode: "internal" },
      mcp: { chunks: [{ n: 1 }], result: { count: 1 } }, // ended clean instead of erroring
    };
    expect(() => assertParity(disagree)).toThrow(/parity FAILED/);
  });

  test("refuses a degenerate single-leg comparison", () => {
    expect(() => assertParity({ execute: { output: {} } })).toThrow(/at least two legs/);
  });
});
