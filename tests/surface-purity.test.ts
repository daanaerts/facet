import { describe, expect, test } from "bun:test";
import { Glob } from "bun";

/**
 * THE SURFACE-PURITY TRIPWIRE — a STRUCTURAL guard, not a behavioural one.
 *
 * The cross-surface thesis rests on a NEGATIVE property: a surface package re-implements NONE of the
 * chokepoint. It must not validate input, enforce scopes, or call a capability handler — all of that lives
 * exactly once in `@facet/core` `execute()` / `executeStream()`. The behavioural parity test proves the
 * surfaces AGREE today; it does NOT stop a surface from growing its own (correct-today, drift-tomorrow) copy
 * of a check. This test does: it scans the four surface packages' source for the chokepoint's own work and
 * fails if any of it appears in a surface.
 *
 * METHOD (auditable on purpose): read every `*.ts` under each surface's `src`, strip comments (preserving
 * line numbers, and keeping `://` so URLs survive), then scan for the forbidden call patterns in FORBIDDEN.
 * It deliberately ALLOWS the read-only projections a surface legitimately needs — `toJsonSchema(def.input)`,
 * `def.risk`, `def.stream`, `def.surfaces`, `def.enabled` — and forbids only the act of re-doing a core
 * invariant (validating, authorizing, or running a handler).
 *
 * LIMITATIONS (please weigh in the audit): this is a TEXTUAL scan, not an AST analysis. It will not catch a
 * check reached through an alias (`const s = def.input; s.safeParse(...)`) or one factored into a helper
 * module OUTSIDE these dirs. Extend FORBIDDEN / SURFACE_DIRS as the surface set or the schema dialect
 * changes — in particular the Standard-Schema migration must KEEP the `~standard` guard below (that becomes
 * the new validation entry point a surface must never call).
 */

const ROOT = `${import.meta.dir}/..`;

/** The packages that must be pure projections. A surface lives entirely in one of these dirs. */
const SURFACE_DIRS = [
  "packages/http/src",
  "packages/cli/src",
  "packages/mcp/src",
  "packages/agent/src",
] as const;

/** The chokepoint's own work — forbidden in any surface. Each pattern is a thing only the core may do. */
const FORBIDDEN: { rx: RegExp; why: string }[] = [
  { rx: /\bsafeParse\s*\(/, why: "input validation (Zod safeParse) — only execute() validates" },
  {
    rx: /~standard/,
    why: "input validation (StandardSchema '~standard') — only execute() validates",
  },
  {
    rx: /def\s*\.\s*(input|output)\s*\.\s*parse\s*\(/,
    why: "validates against the capability's own schema — only execute() validates",
  },
  { rx: /\brequireScope\s*\(/, why: "scope authz — only execute() enforces scopes" },
  {
    rx: /\.handler\s*\(/,
    why: "calls a capability handler directly — only execute() runs handlers",
  },
  {
    rx: /\.streamHandler\b/,
    why: "drives the streaming handler directly — only executeStream() does",
  },
];

/** Strip `//` and block comments, preserving line count and leaving `://` (URLs) intact. */
function stripComments(src: string): string {
  // Block comments → same number of newlines, everything else blanked (preserves line numbers).
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  // Line comments → removed, but only when the `//` is NOT preceded by `:` (so `https://` survives).
  return noBlock.replace(/([^:]|^)\/\/[^\n]*/g, "$1");
}

async function filesUnder(dir: string): Promise<string[]> {
  const glob = new Glob("**/*.ts");
  const out: string[] = [];
  for await (const f of glob.scan({ cwd: `${ROOT}/${dir}`, absolute: true })) out.push(f);
  return out;
}

interface Violation {
  file: string;
  line: number;
  snippet: string;
  why: string;
}

describe("surface purity — no surface re-implements the chokepoint", () => {
  test("no validation / authz / handler-invocation in any surface package", async () => {
    const violations: Violation[] = [];
    for (const dir of SURFACE_DIRS) {
      for (const file of await filesUnder(dir)) {
        const lines = stripComments(await Bun.file(file).text()).split("\n");
        lines.forEach((line, i) => {
          for (const { rx, why } of FORBIDDEN) {
            if (rx.test(line)) {
              violations.push({
                file: file.replace(`${ROOT}/`, ""),
                line: i + 1,
                snippet: line.trim(),
                why,
              });
            }
          }
        });
      }
    }
    if (violations.length > 0) {
      const report = violations
        .map((v) => `  ${v.file}:${v.line} — ${v.why}\n      > ${v.snippet}`)
        .join("\n");
      throw new Error(
        `A surface re-implemented the chokepoint (it must delegate to execute()/executeStream()):\n${report}`,
      );
    }
    expect(violations).toHaveLength(0);
  });

  test("every surface DOES route through the chokepoint (execute / executeStream)", async () => {
    for (const dir of SURFACE_DIRS) {
      let usesChokepoint = false;
      for (const file of await filesUnder(dir)) {
        if (/\bexecute(Stream)?\s*\(/.test(stripComments(await Bun.file(file).text()))) {
          usesChokepoint = true;
          break;
        }
      }
      expect(usesChokepoint, `${dir} must call execute()/executeStream()`).toBe(true);
    }
  });
});
