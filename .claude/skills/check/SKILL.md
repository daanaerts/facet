---
name: check
description: Run Facet's full gate — typecheck, lint, and the test suite (which includes the surface-purity tripwire, the cross-surface parity matrix, and the surprise-capability proof). Use before committing, or whenever asked to verify the repo is green / that nothing regressed.
---

Run the project's one-command gate and report honestly.

1. From the repo root, run: `bun run check`
2. It runs **typecheck → lint → the full test suite**, executing every step even if an earlier one fails, and prints a per-step pass/fail summary. The surface-purity tripwire (`tests/surface-purity.test.ts`), the `@facet/parity` matrix, and the surprise-capability proof are part of the test step — so "tests pass" means "the guards held".
3. Report the summary. If **anything failed**, surface the relevant failing output — the failing test name(s), the `tsc` errors, or the `biome` findings — so it's actionable, and do **not** claim the repo is green.
4. This is the deliberate, manual stand-in for CI: there is intentionally **no `.github` workflow**. If/when CI is added, it should run this same `bun run check` so local and CI are identical.
