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
  flags: Map<string, FlagValue>;
  positional: string[];
  /** Everything after a bare `--`, verbatim (e.g. `pyric dev -- npm start`).
   *  Optional so hand-built ParsedArgs literals stay valid. */
  passthrough?: string[];
}

export type FlagValue = string | boolean | Array<string | boolean>;

const BOOLEAN_FLAGS = new Set([
  'json',
  'bridge',
  'ui',
  'no-ui',
  'no-open',
  'no-run',
  'no-cache',
  'no-watch',
  'no-capture',
  'persist',
  'fresh',
  'force',
  'help',
  'version',
]);

function isBooleanFlag(key: string): boolean {
  return BOOLEAN_FLAGS.has(key) || key.startsWith('no-');
}

const SHORT_ALIASES: ReadonlyMap<string, { key: string; takesValue: boolean }> = new Map([
  ['p', { key: 'port', takesValue: true }],
  ['h', { key: 'help', takesValue: false }],
  ['v', { key: 'version', takesValue: false }],
]);

export function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, FlagValue>();
  const positional: string[] = [];
  const passthrough: string[] = [];
  let subcommand: string | null = null;
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === undefined) {
      i += 1;
      continue;
    }
    if (arg === '--') {
      // Everything after a bare `--` belongs to the child command, verbatim
      // — never parsed as flags (`pyric dev -- npm start --port 3000`).
      passthrough.push(...argv.slice(i + 1).filter((a): a is string => a !== undefined));
      break;
    }
    if (isExecutionSubcommand(subcommand) && positional.length > 0) {
      positional.push(arg);
      i += 1;
      continue;
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        setFlag(flags, arg.slice(2, eq), arg.slice(eq + 1));
      } else {
        const key = arg.slice(2);
        const next = argv[i + 1];
        if (!isBooleanFlag(key) && next && !next.startsWith('-')) {
          setFlag(flags, key, next);
          i += 1;
        } else {
          setFlag(flags, key, true);
        }
      }
    } else if (arg.startsWith('-') && arg !== '-') {
      const raw = arg.slice(1);
      const alias = SHORT_ALIASES.get(raw);
      if (alias) {
        if (alias.takesValue) {
          const next = argv[i + 1];
          if (next && !next.startsWith('-')) {
            setFlag(flags, alias.key, next);
            i += 1;
          } else {
            setFlag(flags, alias.key, true);
          }
        } else {
          setFlag(flags, alias.key, true);
        }
      } else {
        setFlag(flags, raw, true);
      }
    } else if (subcommand === null) {
      subcommand = arg;
    } else {
      positional.push(arg);
    }
    i += 1;
  }
  return { subcommand, flags, positional, passthrough };
}

function isExecutionSubcommand(subcommand: string | null): boolean {
  return subcommand === 'sandbox' || subcommand === 'dev';
}

function setFlag(flags: Map<string, FlagValue>, key: string, value: string | boolean): void {
  const current = flags.get(key);
  if (current === undefined) {
    flags.set(key, value);
  } else if (Array.isArray(current)) {
    current.push(value);
  } else {
    flags.set(key, [current, value]);
  }
}
