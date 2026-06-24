import {
  type Actor,
  type CapabilityDoc,
  describeCapability,
  execute,
  executeStream,
  FacetError,
  type FieldDoc,
  type Registry,
} from "@facet/core";
import { type AuthParts, contextFromParts } from "@facet/surface-kit";
import { flagString, parseArgs } from "./args";

/**
 * The CLI surface — projected from a Registry. It is written ONCE, generically: `facet <capability.id>`
 * dispatches into the SAME chokepoint every other surface uses, so a capability with `surfaces.includes("cli")`
 * is callable from the command line the moment its `*.cap.ts` lands — no hand-written subcommand per
 * capability, no per-surface authz or validation.
 *
 * The surface's ONLY job is to establish a Context and translate errors into exit codes. Every invariant —
 * input validation, scope authz, the confirmation gate, idempotency, audit, kill-switch — already lives in
 * `@facet/core` `execute()`; this dispatcher re-implements none of them. It parses the branded flags
 * (`--json`, `--yes`, `--key`, `--actor`), asks the host for a Context, calls `execute`, prints the JSON
 * result, and maps a thrown `FacetError` to `✗ <code>: <message>` on stderr + exit 1.
 *
 * CARVE NOTE: Moral Fabric's CLI bootstrapped a dev PGlite db, ran install-gating against a tenant, and
 * could forward calls to a remote HTTP surface. Facet has no spine: there is no db, no tenant, no
 * install-gating and no `--remote`. The host supplies a single `contextFor(seam)` — the seam where a real
 * app decides who the actor is and what scopes they hold. `runCli` itself constructs NO scopes and NO auth;
 * it folds nothing tenant-shaped in (a multi-tenant host would do that inside `contextFor`).
 */

/** Branded CLI flag names — the mirror of HTTP's `x-facet-*` headers and MCP's merged fields. */
export const FLAG = {
  json: "json",
  confirm: "yes",
  idempotencyKey: "key",
  actor: "actor",
  surface: "surface",
} as const;

/** Exit codes the CLI returns (so callers and tests can assert intent rather than a magic number). */
export const EXIT = {
  ok: 0,
  /** A thrown `FacetError` — the capability ran the chokepoint and was refused (or failed). */
  error: 1,
  /** A usage problem before the chokepoint — unknown capability or invalid `--json`. */
  usage: 2,
} as const;

/**
 * The host seam — the same {@link AuthParts} contract every Facet surface uses. `runCli` builds the calling
 * `actor` (from `--actor`, or a default dev user) and hands it here; the host returns "what they may do"
 * (`{ actor, scopes, ledger? }`). The SURFACE then assembles the Context — adding `surface: "cli"` and the
 * `--yes` / `--key` it parsed — via `contextFromParts`. The surface shapes the request; the host decides
 * authorization. There is deliberately no tenant/db/install here — a multi-tenant host folds its tenant into
 * the granted `scopes` (and the idempotency key) inside this function. Sync or async.
 */
export interface RunCliOpts {
  contextFor: (actor: Actor) => AuthParts | Promise<AuthParts>;
}

/**
 * Where `runCli` writes. Defaults to the real console, but a test can pass capturing sinks to assert on
 * stdout/stderr WITHOUT spawning a subprocess — the whole CLI runs in-process and returns its exit code.
 */
export interface WriterSink {
  out: (line: string) => void;
  err: (line: string) => void;
}

const consoleSink: WriterSink = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
};

/** The default actor when `--actor` is omitted: a trusted dev user, matching the example host's grant seam. */
const DEFAULT_ACTOR: Actor = { kind: "user", id: "dev@example.com", email: "dev@example.com" };

const HELP = `facet — capability CLI (one definition, projected onto the command line)

Usage
  facet <capability.id> [--json '<input>'] [--yes] [--key <k>] [--actor <email>]
  facet <capability.id> --help            show a capability's input/output, scopes, and examples
  facet ls [--surface http|cli|mcp|agent]
  facet help

Flags
  --json     JSON input for the capability          (default: {})
  --yes      supply confirmation for write/destructive capabilities
  --key      idempotency key (a replay returns the stored result)
  --actor    actor email                            (default: ${DEFAULT_ACTOR.email})
  --surface  (ls only) keep only capabilities that project onto this surface

Examples
  facet ls
  facet logs.tail --json '{"source":"build"}'
  facet jobs.start --json '{"name":"nightly"}'            # → ✗ confirmation_required (exit 1)
  facet jobs.start --json '{"name":"nightly"}' --yes      # now it runs`;

/** Build the `Actor` the host's seam will authorize: a `--actor` email, or the default dev user. */
function actorFrom(flags: ReturnType<typeof parseArgs>["flags"]): Actor {
  const email = flagString(flags, FLAG.actor);
  return email !== undefined ? { kind: "user", id: email, email } : DEFAULT_ACTOR;
}

/**
 * `facet ls` — list the registry. Prints one line per capability (id, risk, surfaces, summary), optionally
 * filtered to a single surface with `--surface`. This is the registry projected to the terminal — a new
 * capability appears here automatically, with no per-capability code. It never authenticates: the listing
 * advertises the contract; the chokepoint (`execute`) is what refuses an actual call.
 */
function runLs(
  registry: Registry,
  flags: ReturnType<typeof parseArgs>["flags"],
  sink: WriterSink,
): number {
  const surface = flagString(flags, FLAG.surface);
  let defs = registry.all().filter((d) => d.enabled);
  if (surface) defs = defs.filter((d) => d.surfaces.includes(surface as never));

  for (const d of defs) {
    sink.out(`${d.id.padEnd(28)} ${d.risk.padEnd(11)} [${d.surfaces.join(",")}]  ${d.summary}`);
  }
  sink.err(`\n${defs.length} capabilit${defs.length === 1 ? "y" : "ies"}`);
  return EXIT.ok;
}

/** The requiredness/default qualifier shown for an input field: `default: X`, `required`, or `optional`. */
function qualifierOf(f: FieldDoc): string {
  if (f.default !== undefined) return `default: ${JSON.stringify(f.default)}`;
  return f.required ? "required" : "optional";
}

/**
 * Render aligned field rows. Input rows carry the requiredness/default qualifier; output rows drop it.
 * Columns are padded to the widest entry so the descriptions line up. Callers guard `fields.length > 0`.
 */
function fieldRows(fields: FieldDoc[], withQualifier: boolean): string[] {
  const nameW = Math.max(...fields.map((f) => f.name.length));
  const typeW = Math.max(...fields.map((f) => f.type.length));
  const qualW = withQualifier ? Math.max(...fields.map((f) => qualifierOf(f).length)) : 0;
  return fields.map((f) => {
    const parts = [f.name.padEnd(nameW), f.type.padEnd(typeW)];
    if (withQualifier) parts.push(qualifierOf(f).padEnd(qualW));
    const head = parts.join("  ");
    return f.description ? `${head}  ${f.description}` : head.trimEnd();
  });
}

/**
 * Render a {@link CapabilityDoc} as a terminal man page — the CLI's projection of the shared help model.
 * Title + summary, a meta line (threat model, reversibility, streaming, surfaces, scopes), the optional
 * long-form `description`, a usage line, the input/output fields, and the authored examples. Everything is
 * derived from the capability's own schema + spec, so a new `*.cap.ts` is self-documenting on `--help` the
 * moment it lands — there is no per-capability help to hand-maintain.
 */
function renderCapabilityHelp(doc: CapabilityDoc): string {
  const lines: string[] = [`${doc.id} — ${doc.summary}`];

  const meta: string[] = [doc.risk];
  if (doc.reversible === true) meta.push("reversible");
  if (doc.reversible === false) meta.push("permanent");
  if (doc.stream) meta.push("streams");
  meta.push(`surfaces: ${doc.surfaces.join(", ")}`);
  if (doc.scopes.length > 0) meta.push(`scopes: ${doc.scopes.join(", ")}`);
  lines.push(`  ${meta.join(" · ")}`);

  if (doc.risk !== "read") {
    lines.push(
      "",
      `  Requires --yes — ${doc.risk} actions are confirmation-gated by the chokepoint.`,
    );
  }

  if (doc.description) lines.push("", doc.description.trim());

  const jsonArg = doc.input.length > 0 ? " --json '<input>'" : "";
  const yesArg = doc.risk !== "read" ? " --yes" : "";
  lines.push("", "Usage", `  facet ${doc.id}${jsonArg}${yesArg}`);

  if (doc.input.length > 0) {
    lines.push("", "Input");
    for (const row of fieldRows(doc.input, true)) lines.push(`  ${row}`);
  }

  if (doc.output.length > 0) {
    lines.push("", doc.stream ? "Output (final)" : "Output");
    for (const row of fieldRows(doc.output, false)) lines.push(`  ${row}`);
  }

  if (doc.examples.length > 0) {
    lines.push("", "Examples");
    for (const ex of doc.examples) {
      lines.push(`  facet ${doc.id} --json '${JSON.stringify(ex.input)}'${yesArg}`);
      if (ex.note) lines.push(`      ${ex.note}`);
    }
  }

  return lines.join("\n");
}

/**
 * Run one capability through the chokepoint. Parses `--json` into the input (a bad parse is a usage error,
 * exit 2, BEFORE any Context is formed), refuses an unknown id with exit 2, then asks the host for a Context
 * and calls `execute`. On success it prints the pretty JSON result to stdout; a thrown `FacetError` is
 * rendered `✗ <code>: <message>` (+ its `data`) on stderr with exit 1 — the same taxonomy HTTP renders as a
 * status and MCP renders as a tool error, here rendered as an exit code.
 */
async function runCapability(
  registry: Registry,
  id: string,
  flags: ReturnType<typeof parseArgs>["flags"],
  opts: RunCliOpts,
  sink: WriterSink,
): Promise<number> {
  // `facet <id> --help` — render THIS capability's man page from its schema and stop, before any Context is
  // formed (help authorizes nothing). It is generated, not hand-written: `describeCapability` flattens the
  // same input/output schema `execute()` enforces, so the help can never drift from the contract. An unknown
  // id is the same usage error (exit 2) a real call would hit.
  if (flags.help === true) {
    const def = registry.get(id);
    if (!def) {
      sink.err(`unknown capability: ${id}\nrun 'facet ls' to list capabilities`);
      return EXIT.usage;
    }
    sink.out(renderCapabilityHelp(describeCapability(def)));
    return EXIT.ok;
  }

  // Parse `--json` first: an invalid payload is a usage error before the chokepoint, never a 500.
  let input: unknown = {};
  const json = flagString(flags, FLAG.json);
  if (json !== undefined) {
    try {
      input = JSON.parse(json);
    } catch (e) {
      sink.err(`invalid --json: ${(e as Error).message}`);
      return EXIT.usage;
    }
  }

  // Unknown capability → exit 2, BEFORE forming a Context, so it reads as a usage problem (mirrors the
  // way `execute` would 404 a missing id — but we want the distinct usage code at the CLI boundary).
  if (!registry.has(id)) {
    sink.err(`unknown capability: ${id}\nrun 'facet ls' to list capabilities`);
    return EXIT.usage;
  }

  try {
    // The host seam: the surface builds the actor + reads confirm/key off the flags; the host grants the
    // scopes; the surface assembles the Context (adding `surface: "cli"`) via `contextFromParts`.
    const parts = await opts.contextFor(actorFrom(flags));
    const ctx = contextFromParts(parts, {
      surface: "cli",
      confirm: flags[FLAG.confirm] === true,
      idempotencyKey: flagString(flags, FLAG.idempotencyKey),
    });

    // STREAMING (additive): a streaming capability is the CLI's incremental idiom. Drive the core's
    // `executeStream()` — the SAME chokepoint, which runs the read gates and validates each chunk — and
    // print ONE JSON line per chunk to stdout AS IT ARRIVES (so a `tail`-style follow scrolls live), then
    // the validated final value as the last line. A non-streaming capability is unchanged: one final line.
    // The branch is purely a rendering choice; both paths flow through core, which owns every invariant.
    //
    // MID-STREAM FAILURE (see `docs/STREAMING-CONTRACT.md`): if the stream throws AFTER K chunks (a bad chunk
    // or a handler throw), the K chunk lines are already on stdout; the throw propagates to the shared `catch`
    // below, which prints `✗ <code>: <message>` to stderr and returns exit 1 — and we never reach the final
    // line. So a failed stream ends in `✗` + exit 1 with no final line, exactly as a pre-stream refusal does,
    // only preceded by the chunks that made it out. The core guarantees the throw is a `FacetError`.
    const def = registry.get(id);
    if (def?.stream) {
      const gen = executeStream(registry, id, input, ctx);
      let step = await gen.next();
      while (!step.done) {
        sink.out(JSON.stringify(step.value));
        step = await gen.next();
      }
      sink.out(JSON.stringify(step.value));
      return EXIT.ok;
    }

    const out = await execute(registry, id, input, ctx);
    sink.out(JSON.stringify(out, null, 2));
    return EXIT.ok;
  } catch (e) {
    // Map a thrown FacetError → `✗ <code>: <message>` (+ data) on stderr, exit 1. Anything else rethrows:
    // a non-FacetError is a real bug, and the thin `cli.ts` wrapper turns it into a crash + non-zero exit.
    if (e instanceof FacetError) {
      sink.err(`✗ ${e.code}: ${e.message}`);
      if (e.data !== undefined) sink.err(JSON.stringify(e.data, null, 2));
      return EXIT.error;
    }
    throw e;
  }
}

/**
 * Dispatch the CLI and return an EXIT code (the caller, e.g. `examples/logs/cli.ts`, does the
 * `process.exit`). Returning a code rather than calling `process.exit` is what makes the whole surface
 * unit-testable in-process: a test passes capturing `out`/`err` sinks and asserts on the lines + the code,
 * with no subprocess and no real stdout.
 *
 *   facet <capability.id> [--json '<input>'] [--yes] [--key <k>] [--actor <email>]  → execute + print JSON
 *   facet ls [--surface http|cli|mcp|agent]                                          → list the registry
 *   facet help | (no args)                                                           → usage
 */
export async function runCli(
  registry: Registry,
  argv: string[],
  opts: RunCliOpts,
  sink: WriterSink = consoleSink,
): Promise<number> {
  const { positionals, flags } = parseArgs(argv);
  const cmd = positionals[0];

  // The GLOBAL help: no command, or an explicit `help` / bare `--help`. A capability-scoped `--help`
  // (`facet logs.tail --help`) is NOT global — it carries a `cmd`, so it falls through to `runCapability`,
  // which renders that one capability's man page from its schema.
  if (!cmd || cmd === "help") {
    sink.out(HELP);
    return EXIT.ok;
  }

  if (cmd === "ls") return runLs(registry, flags, sink);

  return runCapability(registry, cmd, flags, opts, sink);
}
