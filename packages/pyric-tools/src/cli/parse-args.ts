/**
 * Minimal CLI argument parser shared across subcommands.
 *
 * Intentionally tiny — no `commander` / `yargs` dependency. The parser
 * is biased toward Firebase-style flag syntax (`--flag value` and
 * `--flag=value`); short flags are single-char booleans. Anything
 * beyond a "command + positionals + flags" model belongs in a
 * dedicated subcommand handler, not here.
 */

export interface ParsedArgs {
  subcommand: string | null;
  flags: Map<string, string | boolean>;
  positional: string[];
}

export function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string | boolean>();
  const positional: string[] = [];
  let subcommand: string | null = null;
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === undefined) {
      i += 1;
      continue;
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        flags.set(arg.slice(2, eq), arg.slice(eq + 1));
      } else {
        const next = argv[i + 1];
        if (next && !next.startsWith('-')) {
          flags.set(arg.slice(2), next);
          i += 1;
        } else {
          flags.set(arg.slice(2), true);
        }
      }
    } else if (arg.startsWith('-')) {
      flags.set(arg.slice(1), true);
    } else if (subcommand === null) {
      subcommand = arg;
    } else {
      positional.push(arg);
    }
    i += 1;
  }
  return { subcommand, flags, positional };
}
