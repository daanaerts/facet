#!/usr/bin/env bun
/**
 * The manual "run everything" gate — the local stand-in for CI (there is intentionally NO `.github` workflow).
 *
 * It runs typecheck + lint + the full test suite — and the test suite itself already contains the
 * surface-purity TRIPWIRE (`tests/surface-purity.test.ts`), the surprise-capability proof, and the
 * cross-surface parity matrix, so "run the tests" is "run the guards". Every step runs even if an earlier one
 * fails (so you see the whole picture, not just the first red), then a summary prints and the process exits
 * non-zero iff anything failed.
 *
 * Run it before you commit:  bun run check
 *
 * When you do add CI later, point the workflow at this same command so local and CI run identically.
 */

interface Step {
  name: string;
  cmd: string[];
}

const STEPS: Step[] = [
  { name: "typecheck  (tsc --noEmit)", cmd: ["bun", "run", "typecheck"] },
  { name: "lint       (biome check)", cmd: ["bun", "run", "lint"] },
  { name: "test       (suite incl. tripwire · parity · surprise-cap)", cmd: ["bun", "test"] },
];

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;

const results: { step: Step; ok: boolean }[] = [];
for (const step of STEPS) {
  console.log(`\n${bold(cyan(`▶ ${step.name}`))}`);
  const { exitCode } = Bun.spawnSync(step.cmd, { stdout: "inherit", stderr: "inherit" });
  results.push({ step, ok: exitCode === 0 });
}

console.log(`\n${bold("── check summary ──────────────────────────────────────")}`);
for (const { step, ok } of results) {
  console.log(`  ${ok ? green("✓ pass") : red("✗ FAIL")}  ${step.name}`);
}

const failed = results.filter((r) => !r.ok).length;
if (failed > 0) {
  console.log(`\n${bold(red(`${failed} check(s) failed.`))}`);
  process.exit(1);
}
console.log(`\n${bold(green("All checks passed."))}`);
