import { describe, expect, test } from "bun:test";
import { Glob } from "bun";

/**
 * THE @facet/postgres BOUNDARY TRIPWIRE — a STRUCTURAL guard that the Postgres adapter stays a leaf.
 *
 * The architecture promise (boundaries-and-decoupling): `@facet/postgres` depends on `@facet/core` (types
 * only — `Ledger`, `Context`), never the reverse, and the pg concretions (drizzle-orm, a pg driver, the
 * `facet_idempotency` table) live ENTIRELY in the adapter. If any of that leaks into core, the engine stops
 * being runtime-pure and persistence-agnostic — the exact `Context.db` leak the carve removed. This test
 * scans `@facet/core`'s source + manifest and fails on any such import or reference.
 */

const ROOT = `${import.meta.dir}/..`;
const CORE_SRC = "packages/core/src";

/** Things the runtime-pure, persistence-agnostic core must never name. */
const FORBIDDEN_IN_CORE: { rx: RegExp; why: string }[] = [
  { rx: /from\s+["']drizzle-orm/, why: "core importing drizzle-orm (a Postgres-only concretion)" },
  { rx: /from\s+["']pg["']/, why: "core importing node-postgres" },
  { rx: /from\s+["']postgres["']/, why: "core importing postgres.js" },
  {
    rx: /from\s+["']@facet\/postgres/,
    why: "core importing the @facet/postgres sibling (the dependency arrow must point adapter → core only)",
  },
  { rx: /facet_idempotency/, why: "core naming the idempotency table (a storage concretion)" },
];

function stripComments(src: string): string {
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  return noBlock.replace(/([^:]|^)\/\/[^\n]*/g, "$1");
}

async function filesUnder(dir: string): Promise<string[]> {
  const glob = new Glob("**/*.ts");
  const out: string[] = [];
  for await (const f of glob.scan({ cwd: `${ROOT}/${dir}`, absolute: true })) out.push(f);
  return out;
}

describe("@facet/postgres boundary — the adapter is a leaf, core never reaches for it", () => {
  test("no pg / drizzle / sibling import (and no table name) appears in @facet/core source", async () => {
    const violations: string[] = [];
    for (const file of await filesUnder(CORE_SRC)) {
      const lines = stripComments(await Bun.file(file).text()).split("\n");
      lines.forEach((line, i) => {
        for (const { rx, why } of FORBIDDEN_IN_CORE) {
          if (rx.test(line)) {
            violations.push(
              `  ${file.replace(`${ROOT}/`, "")}:${i + 1} — ${why}\n      > ${line.trim()}`,
            );
          }
        }
      });
    }
    if (violations.length > 0) {
      throw new Error(
        `@facet/core reached for a persistence concretion:\n${violations.join("\n")}`,
      );
    }
    expect(violations).toHaveLength(0);
  });

  test("@facet/core's manifest declares no pg / drizzle / sibling dependency", async () => {
    const pkg = (await Bun.file(`${ROOT}/packages/core/package.json`).json()) as Record<
      string,
      Record<string, string> | undefined
    >;
    const named = Object.keys({
      ...pkg.dependencies,
      ...pkg.peerDependencies,
      ...pkg.devDependencies,
      ...pkg.optionalDependencies,
    });
    const forbidden = named.filter((n) =>
      ["drizzle-orm", "pg", "postgres", "@facet/postgres"].includes(n),
    );
    expect(forbidden, `core must not depend on ${forbidden.join(", ")}`).toHaveLength(0);
  });
});
