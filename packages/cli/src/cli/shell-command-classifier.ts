/**
 * Shared POSIX/GNU `env` and Bourne-shell (`sh`, `bash`, `zsh`, `dash`, `ksh`)
 * option walkers and command-token classifiers used by both
 * `unsupported-runtime.ts` and `sandbox-env-sanitizer.ts`.
 */
import {
  COMMAND_GROUP_TOKENS,
  SHELL_OPERATORS,
  type ShellToken,
} from './shell-script-tokenizer.js';

/** POSIX/Bourne shells whose `-c <script>` operand executes a shell command string. */
export const SHELL_BINARIES = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);

const BOOLEAN_SHELL_SHORT_FLAGS = new Set([
  'a',
  'b',
  'e',
  'f',
  'h',
  'i',
  'k',
  'l',
  'm',
  'n',
  'p',
  'r',
  's',
  't',
  'u',
  'v',
  'x',
  'B',
  'C',
  'E',
  'H',
  'P',
  'T',
]);

const BOOLEAN_SHELL_LONG_FLAGS = new Set([
  '--login',
  '--norc',
  '--noprofile',
  '--posix',
  '--restricted',
  '--verbose',
  '--noediting',
]);

/** Strip directory and a Windows `.exe` suffix from a command token. */
export function commandBasename(token: string): string {
  const base = token.split(/[\\/]/).pop() ?? token;
  return base.toLowerCase().replace(/\.exe$/, '');
}

function isDynamicOrGlobToken(token: ShellToken): boolean {
  return token.hasDynamicExpansion || token.hasUnquotedGlob;
}

export type EnvOptionStep =
  | { readonly kind: 'end-flags'; readonly nextIndex: number }
  | {
      readonly kind: 'option';
      readonly ignoreEnv: boolean;
      readonly unsetKey: string | null;
      readonly splitString: string | null;
      /** Non-`-u`/`-S` flags preserved when reconstructing an `env` argv. */
      readonly passthroughArgs: readonly string[];
      readonly nextIndex: number;
    }
  | { readonly kind: 'unclassified' };

/**
 * Parse a single option token (and any option-argument token it consumes) at
 * `tokens[index]` for POSIX / GNU coreutils `env`, walking bundled short-flag
 * clusters character by character.
 */
export function stepEnvOption(tokens: readonly ShellToken[], index: number): EnvOptionStep {
  const tok = tokens[index]!;
  if (isDynamicOrGlobToken(tok)) return { kind: 'unclassified' };
  const raw = tok.value;

  if (raw === '--') {
    return { kind: 'end-flags', nextIndex: index + 1 };
  }
  if (raw === '-' || raw === '--ignore-environment') {
    return {
      kind: 'option',
      ignoreEnv: true,
      unsetKey: null,
      splitString: null,
      passthroughArgs: [raw],
      nextIndex: index + 1,
    };
  }
  if (raw === '--null' || raw === '--debug') {
    return {
      kind: 'option',
      ignoreEnv: false,
      unsetKey: null,
      splitString: null,
      passthroughArgs: [raw],
      nextIndex: index + 1,
    };
  }
  if (raw === '--unset' || raw === '--chdir' || raw === '--argv0' || raw === '--split-string') {
    const nextTok = tokens[index + 1];
    if (nextTok === undefined || isDynamicOrGlobToken(nextTok)) {
      return { kind: 'unclassified' };
    }
    const arg = nextTok.value;
    if (raw === '--unset') {
      return {
        kind: 'option',
        ignoreEnv: false,
        unsetKey: arg,
        splitString: null,
        passthroughArgs: [],
        nextIndex: index + 2,
      };
    }
    if (raw === '--split-string') {
      return {
        kind: 'option',
        ignoreEnv: false,
        unsetKey: null,
        splitString: arg,
        passthroughArgs: [],
        nextIndex: index + 2,
      };
    }
    return {
      kind: 'option',
      ignoreEnv: false,
      unsetKey: null,
      splitString: null,
      passthroughArgs: [raw, arg],
      nextIndex: index + 2,
    };
  }
  if (raw.startsWith('--unset=')) {
    return {
      kind: 'option',
      ignoreEnv: false,
      unsetKey: raw.slice('--unset='.length),
      splitString: null,
      passthroughArgs: [],
      nextIndex: index + 1,
    };
  }
  if (raw.startsWith('--split-string=')) {
    return {
      kind: 'option',
      ignoreEnv: false,
      unsetKey: null,
      splitString: raw.slice('--split-string='.length),
      passthroughArgs: [],
      nextIndex: index + 1,
    };
  }
  if (raw.startsWith('--chdir=') || raw.startsWith('--argv0=')) {
    return {
      kind: 'option',
      ignoreEnv: false,
      unsetKey: null,
      splitString: null,
      passthroughArgs: [raw],
      nextIndex: index + 1,
    };
  }
  if (raw.startsWith('--')) {
    return { kind: 'unclassified' };
  }

  // Bundled short options (`-iv`, `-vu KEY`, `-iu UNUSED`, `-vS "..."`, `-uKEY`)
  let ignoreEnv = false;
  let keptShort = '';
  for (let k = 1; k < raw.length; k++) {
    const ch = raw[k]!;
    if (ch === 'i') {
      ignoreEnv = true;
      keptShort += ch;
      continue;
    }
    if (ch === '0' || ch === 'v') {
      keptShort += ch;
      continue;
    }
    if (ch === 'u' || ch === 'C' || ch === 'a' || ch === 'S') {
      const attached = raw.slice(k + 1);
      let optArg: string;
      let nextIndex: number;
      if (attached.length > 0) {
        optArg = attached;
        nextIndex = index + 1;
      } else {
        const nextTok = tokens[index + 1];
        if (nextTok === undefined || isDynamicOrGlobToken(nextTok)) {
          return { kind: 'unclassified' };
        }
        optArg = nextTok.value;
        nextIndex = index + 2;
      }
      const passthroughArgs: string[] = [];
      if (keptShort.length > 0) {
        passthroughArgs.push(`-${keptShort}`);
      }
      if (ch === 'C' || ch === 'a') {
        passthroughArgs.push(`-${ch}`, optArg);
      }
      return {
        kind: 'option',
        ignoreEnv,
        unsetKey: ch === 'u' ? optArg : null,
        splitString: ch === 'S' ? optArg : null,
        passthroughArgs,
        nextIndex,
      };
    }
    return { kind: 'unclassified' };
  }

  return {
    kind: 'option',
    ignoreEnv,
    unsetKey: null,
    splitString: null,
    passthroughArgs: keptShort.length > 0 ? [`-${keptShort}`] : [],
    nextIndex: index + 1,
  };
}

export type ShellInvocationParse =
  | { readonly kind: 'command-script'; readonly scriptIndex: number; readonly endIndex: number }
  | { readonly kind: 'non-command'; readonly endIndex: number }
  | { readonly kind: 'unclassified' };

function findSegmentEnd(tokens: readonly ShellToken[], from: number): number {
  let idx = from;
  while (idx < tokens.length) {
    const val = tokens[idx]!.value;
    if (SHELL_OPERATORS.has(val) || COMMAND_GROUP_TOKENS.has(val)) break;
    idx++;
  }
  return idx;
}

/**
 * Parse a shell invocation's options starting at `startIndex` (immediately
 * after `sh`/`bash`/`zsh`/`dash`/`ksh`), walking bundled `-...` / `+...` flags
 * character by character and accounting for queued `-o`/`+o`/`-O`/`+O` optargs.
 */
export function parseShellInvocation(
  tokens: readonly ShellToken[],
  startIndex: number,
): ShellInvocationParse {
  const endIndex = findSegmentEnd(tokens, startIndex);
  let hasCommandFlag = false;
  let pendingOptArgs = 0;
  let i = startIndex;

  while (i < endIndex) {
    const tok = tokens[i]!;
    if (pendingOptArgs > 0) {
      if (isDynamicOrGlobToken(tok)) return { kind: 'unclassified' };
      pendingOptArgs -= 1;
      i++;
      continue;
    }
    const raw = tok.value;
    if (raw === '--') {
      if (isDynamicOrGlobToken(tok)) return { kind: 'unclassified' };
      i++;
      break;
    }
    if (raw.startsWith('--')) {
      if (isDynamicOrGlobToken(tok)) return { kind: 'unclassified' };
      if (raw === '--command') {
        hasCommandFlag = true;
        i++;
        continue;
      }
      if (raw === '--rcfile' || raw === '--init-file') {
        pendingOptArgs += 1;
        i++;
        continue;
      }
      if (raw.startsWith('--rcfile=') || raw.startsWith('--init-file=') || BOOLEAN_SHELL_LONG_FLAGS.has(raw)) {
        i++;
        continue;
      }
      return { kind: 'unclassified' };
    }
    if ((raw.startsWith('-') || raw.startsWith('+')) && raw.length > 1) {
      if (isDynamicOrGlobToken(tok)) return { kind: 'unclassified' };
      const prefix = raw[0]!;
      for (let k = 1; k < raw.length; k++) {
        const ch = raw[k]!;
        if (ch === 'c' && prefix === '-') {
          hasCommandFlag = true;
          continue;
        }
        if (ch === 'o' || ch === 'O') {
          pendingOptArgs += 1;
          continue;
        }
        if (BOOLEAN_SHELL_SHORT_FLAGS.has(ch)) {
          continue;
        }
        return { kind: 'unclassified' };
      }
      i++;
      continue;
    }
    // Reached first positional operand
    break;
  }

  if (pendingOptArgs > 0) {
    return { kind: 'unclassified' };
  }
  if (hasCommandFlag) {
    if (i >= endIndex) return { kind: 'unclassified' };
    if (isDynamicOrGlobToken(tokens[i]!)) return { kind: 'unclassified' };
    return { kind: 'command-script', scriptIndex: i, endIndex };
  }
  if (i < endIndex && isDynamicOrGlobToken(tokens[i]!)) {
    return { kind: 'unclassified' };
  }
  return { kind: 'non-command', endIndex };
}
