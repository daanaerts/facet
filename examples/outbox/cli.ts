#!/usr/bin/env bun
import { runCli } from "@facet/cli";
import { devCliContextFor } from "./host";
import { outboxRegistry } from "./registry";

/**
 * The outbox app projected onto the CLI — `bun run examples/outbox/cli.ts <capability.id> …`.
 *
 *   bun run examples/outbox/cli.ts ls
 *   bun run examples/outbox/cli.ts messages.list
 *   bun run examples/outbox/cli.ts email.send --json '{"to":"a@b.com","subject":"Hi","body":"Yo"}'        # ✗ confirmation_required
 *   bun run examples/outbox/cli.ts email.send --json '{"to":"a@b.com","subject":"Hi","body":"Yo"}' --yes  # sent
 *   bun run examples/outbox/cli.ts issues.open --json '{"repo":"acme/app","title":"Bug","body":"…"}' --yes
 *   bun run examples/outbox/cli.ts outbox.tail                                                            # streams the log
 */
if (import.meta.main) {
  runCli(outboxRegistry(), Bun.argv.slice(2), { contextFor: devCliContextFor() }).then(
    (code) => process.exit(code),
    (e) => {
      console.error(e);
      process.exit(1);
    },
  );
}
