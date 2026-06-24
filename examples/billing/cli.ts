#!/usr/bin/env bun
import { runCli } from "@facet/cli";
import { devCliContextFor } from "./host";
import { billingRegistry } from "./registry";

/**
 * The billing app projected onto the CLI — `bun run examples/billing/cli.ts <capability.id> …`.
 *
 *   bun run examples/billing/cli.ts ls
 *   bun run examples/billing/cli.ts payments.list
 *   bun run examples/billing/cli.ts payments.charge --json '{"amountCents":2500,"customer":"cus_x"}'        # ✗ confirmation_required
 *   bun run examples/billing/cli.ts payments.charge --json '{"amountCents":2500,"customer":"cus_x"}' --yes  # runs
 *   bun run examples/billing/cli.ts payments.refund --json '{"paymentId":"pay_2"}' --yes                    # the wedge, confirmed
 *   # idempotency — the SAME key replays the first refund (no double refund)
 *   bun run examples/billing/cli.ts payments.refund --json '{"paymentId":"pay_1"}' --yes --key r1
 *   bun run examples/billing/cli.ts payments.refund --json '{"paymentId":"pay_1"}' --yes --key r1
 *   bun run examples/billing/cli.ts payments.export                                                         # streams a tape
 */
if (import.meta.main) {
  runCli(billingRegistry(), Bun.argv.slice(2), { contextFor: devCliContextFor() }).then(
    (code) => process.exit(code),
    (e) => {
      console.error(e);
      process.exit(1);
    },
  );
}
