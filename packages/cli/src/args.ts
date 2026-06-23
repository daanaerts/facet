/**
 * The CLI's argument shape and parser. This is the Moral Fabric flag parser ported VERBATIM — it was
 * already spine-free (it knows nothing of tenants, installs, or a db), so the carve removed nothing here.
 * `runCli` reads the branded flags (`--yes`, `--key`, `--actor`, `--json`, `--surface`) off the result.
 */
export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

/** Minimal flag parser: `--key value` or boolean `--key`; everything else is positional. */
export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      positionals.push(arg);
    }
  }

  return { positionals, flags };
}

/** Read a flag as a string, or `undefined` if it is absent or a bare boolean flag. */
export function flagString(flags: ParsedArgs["flags"], key: string): string | undefined {
  const v = flags[key];
  return typeof v === "string" ? v : undefined;
}
