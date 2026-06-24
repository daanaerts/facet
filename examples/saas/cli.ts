#!/usr/bin/env bun
import { runCli } from "@facet/cli";
import { saasCliContextFor } from "./host";
import { saasRegistry } from "./registry";

/**
 * The multi-tenant app projected onto the CLI — `bun run examples/saas/cli.ts <capability.id> …`. The tenant
 * comes from `SAAS_TOKEN` (default `tok_acme_admin`), so the SAME command run as two tokens sees two worlds:
 *
 *   bun run examples/saas/cli.ts ls
 *   bun run examples/saas/cli.ts projects.list                                  # acme's projects
 *   SAAS_TOKEN=tok_globex_admin bun run examples/saas/cli.ts projects.list      # globex's — a different set
 *   bun run examples/saas/cli.ts projects.create --json '{"name":"New thing"}'  # → ✗ confirmation_required
 *   bun run examples/saas/cli.ts projects.create --json '{"name":"New thing"}' --yes
 *   bun run examples/saas/cli.ts projects.delete --json '{"id":"proj_1"}' --yes # admin → deleted
 *   SAAS_TOKEN=tok_acme_member bun run examples/saas/cli.ts projects.delete --json '{"id":"proj_1"}' --yes
 *                                                                               # → ✗ forbidden (not an admin)
 */
if (import.meta.main) {
  runCli(saasRegistry(), Bun.argv.slice(2), { contextFor: saasCliContextFor() }).then(
    (code) => process.exit(code),
    (e) => {
      console.error(e);
      process.exit(1);
    },
  );
}
