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

const SHORT_VALUE_ALIASES: ReadonlyMap<string, string> = new Map([
  ['p', 'port'],
]);

function consumeFlag(
  flags: Map<string, FlagValue>,
  key: string,
  argv: string[],
  currentIndex: number,
  canTakeValue: boolean,
): number {
  const next = argv[currentIndex + 1];
  if (canTakeValue && next !== undefined && !next.startsWith('-')) {
    setFlag(flags, key, next);
    return currentIndex + 1;
  }
  setFlag(flags, key, true);
  return currentIndex;
}

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
      // — never parsed as flags (`pyric sandbox -- npm start --port 3000`).
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
        i = consumeFlag(flags, key, argv, i, !isBooleanFlag(key));
      }
    } else if (arg.startsWith('-') && arg !== '-') {
      const raw = arg.slice(1);
      const longKey = SHORT_VALUE_ALIASES.get(raw);
      if (longKey !== undefined) {
        i = consumeFlag(flags, longKey, argv, i, true);
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
  return subcommand === 'sandbox';
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
