/**
 * @facet/parity — the GENERIC cross-surface parity harness (a TEST harness, not a surface). It drives one
 * capability through the raw `@facet/core` `execute()` baseline AND all four surfaces (agent, cli, http, mcp),
 * normalizing each to a single shape, and asserts they AGREE: same output, same confirmation gate, same error
 * taxonomy, same ordered stream + termination. This is the proof — mechanized, not intended — that "one typed
 * capability → four surfaces" holds with zero per-surface drift, with the raw `execute()` leg as the ground
 * truth the surfaces are measured against.
 *
 * It is parameterized over a {@link ParityHosts} bundle (a registry factory + the per-surface host seams), so
 * the same drivers run over any domain (todo, logs, a fresh fixture) and any host policy — the harness owns no
 * registry and no auth of its own.
 *
 * Unlike the four surface packages, this package MAY call `execute()` / `executeStream()` directly: that is
 * exactly the baseline leg. The surface-purity tripwire scans only the four surface dirs, so this is allowed.
 */
export { assertParity } from "./assert";
export {
  readCliErrorCode,
  readMcpErrorCode,
  viaAgent,
  viaCli,
  viaExecute,
  viaHttp,
  viaMcp,
} from "./drivers";
export {
  viaAgentStream,
  viaCliStream,
  viaExecuteStream,
  viaHttpStream,
  viaMcpStream,
} from "./streaming";
export type { CallOpts, ParityHosts, StreamResult, SurfaceResult } from "./types";
