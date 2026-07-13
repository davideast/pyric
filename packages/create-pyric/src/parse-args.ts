/**
 * Minimal argv parser for `create-pyric` (no subcommand — first bare
 * arg is the target directory).
 */

export type FlagValue = string | boolean | Array<string | boolean>;

export interface CreateArgs {
  flags: Map<string, FlagValue>;
  positional: string[];
}

export function parseCreateArgs(argv: string[]): CreateArgs {
  const flags = new Map<string, FlagValue>();
  const positional: string[] = [];
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === undefined) {
      i += 1;
      continue;
    }
    if (arg === '--') {
      // Flags after `--` are still ours (npm create pyric dir -- --force).
      i += 1;
      continue;
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        setFlag(flags, arg.slice(2, eq), arg.slice(eq + 1));
      } else {
        const next = argv[i + 1];
        if (next && !next.startsWith('-')) {
          setFlag(flags, arg.slice(2), next);
          i += 1;
        } else {
          setFlag(flags, arg.slice(2), true);
        }
      }
    } else if (arg.startsWith('-')) {
      setFlag(flags, arg.slice(1), true);
    } else {
      positional.push(arg);
    }
    i += 1;
  }
  return { flags, positional };
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
