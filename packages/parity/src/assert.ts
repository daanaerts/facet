import type { StreamResult, SurfaceResult } from "./types";

/**
 * `assertParity` — the harness's one assertion: every leg AGREES. Hand it a map of `leg label → result`
 * (either {@link SurfaceResult} unary outcomes or {@link StreamResult} stream outcomes, all the same shape),
 * and it fails with a per-leg DIFF the moment any leg differs from the reference. This is what turns "the
 * surfaces happen to match today" into an enforced property: the test states the legs, this states they are
 * equal, and a regression names exactly which leg drifted and how.
 *
 * The REFERENCE leg is the raw-`execute()` baseline when present (the keys `"execute"` for unary or
 * `"executeStream"` for streaming) — the ground truth a surface must match — otherwise the first entry. Every
 * other leg is deep-compared against it; a mismatch throws an error listing the reference and each diverging
 * leg with both sides, so a failure is read at a glance rather than decoded from a `toEqual` dump.
 *
 * Deep equality is by canonical JSON (stable key order), which is exactly right for these results: a
 * capability output / chunk / error code is plain JSON data, and two legs are in parity iff that data is
 * identical. (`undefined` fields — the unset half of the output/errorCode or result/errorCode pair — drop out
 * of JSON, so an absent `output` and an absent `errorCode` compare equal, which is the intent.)
 */

/** The conventional key for the raw baseline leg, preferred as the parity reference when present. */
const BASELINE_KEYS = ["execute", "executeStream"] as const;

/** A leg result is one of the two normalized shapes the drivers produce. */
type LegResult = SurfaceResult | StreamResult;

/**
 * Assert that every leg in `results` agrees with the reference leg. Throws with a per-leg diff on any
 * mismatch; returns silently when all legs are in parity. `results` must hold at least two legs (a parity
 * assertion over a single leg is meaningless and almost certainly a wiring mistake).
 */
export function assertParity(results: Record<string, LegResult>): void {
  const labels = Object.keys(results);
  if (labels.length < 2) {
    throw new Error(
      `assertParity needs at least two legs to compare; got ${labels.length} (${labels.join(", ") || "none"}).`,
    );
  }

  const referenceLabel = pickReference(labels);
  const reference = results[referenceLabel] as LegResult;
  const referenceJson = canonical(reference);

  const diffs: string[] = [];
  for (const label of labels) {
    if (label === referenceLabel) continue;
    const candidate = results[label] as LegResult;
    if (canonical(candidate) !== referenceJson) {
      diffs.push(
        `  ${label}:\n      got      ${canonical(candidate)}\n      expected ${referenceJson}`,
      );
    }
  }

  if (diffs.length > 0) {
    throw new Error(
      `cross-surface parity FAILED — legs disagree with reference "${referenceLabel}":\n${diffs.join("\n")}`,
    );
  }
}

/** Choose the reference leg: the raw baseline when present, else the first declared leg. */
function pickReference(labels: string[]): string {
  for (const key of BASELINE_KEYS) {
    if (labels.includes(key)) return key;
  }
  return labels[0] as string;
}

/**
 * Canonical JSON of a result for deep comparison: object keys are emitted in sorted order at every level so
 * two structurally-equal results stringify identically regardless of key insertion order (HTTP's parsed JSON,
 * MCP's `structuredContent`, and the baseline's raw output can order keys differently). `undefined` values are
 * dropped by `JSON.stringify`, which is what makes the unset half of each result pair compare as absent.
 */
function canonical(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

/** Recursively rebuild a value with object keys sorted, so canonical JSON is order-independent. */
function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}
