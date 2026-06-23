#!/usr/bin/env bun
import { runCli } from "@facet/cli";
import { devCliContextFor } from "./host";
import { todoRegistry } from "./registry";

/**
 * The todo app projected onto the CLI — `bun run examples/todo/cli.ts <capability.id> …`. It reuses the same
 * registry every other surface builds (`todoRegistry`) and the host's `devCliContextFor` seam. The CLI is a
 * leaf process: `runCli` returns an exit code (so the whole surface stays unit-testable in-process), and this
 * thin entrypoint is the only place that turns that code into a real `process.exit`.
 *
 * Run it (see README for the full set):
 *   bun run examples/todo/cli.ts ls
 *   bun run examples/todo/cli.ts todos.list
 *   bun run examples/todo/cli.ts todos.add --json '{"title":"ship it"}'          # → ✗ confirmation_required
 *   bun run examples/todo/cli.ts todos.add --json '{"title":"ship it"}' --yes    # now it runs
 *   bun run examples/todo/cli.ts todos.watch                                     # streams one line per todo
 */
if (import.meta.main) {
  runCli(todoRegistry(), Bun.argv.slice(2), { contextFor: devCliContextFor() }).then(
    (code) => process.exit(code),
    (e) => {
      console.error(e);
      process.exit(1);
    },
  );
}
