/**
 * @facet/cli — the CLI surface. Generic over a Registry: `facet <capability.id>` becomes a subcommand that
 * establishes a Context via a host-supplied `contextFor` seam and translates the FacetError family to an
 * exit code. Branded flags: `--yes` (confirm), `--key` (idempotency), `--actor`, `--json`.
 *
 * The surface validates nothing and authorizes nothing — all of that lives in `@facet/core` `execute()`.
 * It shares nothing with the other surfaces but `@facet/core`. See {@link runCli}.
 */
export { flagString, type ParsedArgs, parseArgs } from "./args";
export { EXIT, FLAG, type RunCliOpts, runCli, type WriterSink } from "./run";
