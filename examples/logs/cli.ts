#!/usr/bin/env bun
import { type CliContextSeam, runCli } from "@facet/cli";
import { buildContext, type Context } from "@facet/core";
import { MemoryLedger } from "./host";
import { logsRegistry } from "./http";

/**
 * The `logs` domain projected onto the CLI — the example host's whole CLI contribution. It reuses the same
 * registry the HTTP surface builds (`logsRegistry`) and supplies a DEV `contextFor`: this is the seam where
 * a real app would derive the actor from a verified session and decide its scopes, but for the demo every
 * invocation is a single trusted dev user granted the logs/jobs scopes. Nothing framework-specific leaks in
 * — the host decides what scopes mean, and folds nothing tenant-shaped in because this domain has no tenants.
 *
 * Run it:
 *   bun run examples/logs/cli.ts ls
 *   bun run examples/logs/cli.ts logs.tail --json '{"source":"build"}'
 *   bun run examples/logs/cli.ts jobs.start --json '{"name":"nightly"}'          # → ✗ confirmation_required
 *   bun run examples/logs/cli.ts jobs.start --json '{"name":"nightly"}' --yes    # now it runs
 */

/** The scopes the dev user is granted — enough to read logs and read/write jobs (mirrors the HTTP host). */
const DEV_SCOPES = ["logs:read", "jobs:read", "jobs:write"];

/**
 * A dev `contextFor`: turn the CLI's request seam (actor + confirm + key, supplied by `runCli`) into a
 * Context with the logs/jobs scopes granted and an in-memory idempotency ledger, so a retried `jobs.start`
 * carrying the same `--key` dedupes. The ledger is created ONCE here (closed over), not per call, so replays
 * actually hit a shared store. A real host swaps this for session-derived scopes; the surface does not change.
 */
export function devContextFor(): (seam: CliContextSeam) => Context {
  const ledger = new MemoryLedger();
  return (seam: CliContextSeam): Context =>
    buildContext({
      actor: seam.actor,
      scopes: DEV_SCOPES,
      surface: seam.surface,
      confirm: seam.confirm,
      idempotencyKey: seam.idempotencyKey,
      ledger,
    });
}

/**
 * The CLI is a leaf process: `runCli` returns an exit code (so it stays unit-testable in-process), and this
 * thin entrypoint is the only place that turns that code into a real `process.exit`. A capability that throws
 * a non-FacetError bubbles out of `runCli`; we catch it, print it, and exit non-zero rather than hang.
 */
if (import.meta.main) {
  runCli(logsRegistry(), Bun.argv.slice(2), { contextFor: devContextFor() }).then(
    (code) => process.exit(code),
    (e) => {
      console.error(e);
      process.exit(1);
    },
  );
}
