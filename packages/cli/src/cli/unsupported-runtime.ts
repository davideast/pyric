/**
 * Child runtimes that cannot evaluate Node loader hooks, and the upfront stop
 * error `pyric sandbox` and `pyric run` raise instead of running unswapped code
 * (ADR 0023).
 *
 * Uses the shared `env`/shell option classifier (`shell-command-classifier.ts`)
 * for early, friendly detection of visible argv/script forms; any construct
 * outside static classification passes through to the execution-time `PATH`
 * shim in `spawnSandboxChild`.
 */

import { warnDeprecatedGuardEnvOnce } from '../register/deprecated-guard-env.js';
import {
  SHELL_BINARIES,
  commandBasename,
  parseShellInvocation,
  stepEnvOption,
} from './shell-command-classifier.js';
import {
  COMMAND_GROUP_TOKENS,
  ENV_ASSIGNMENT,
  SHELL_OPERATORS,
  expandUnquotedOperators,
  extractCommandSubstitutions,
  splitEnvSplitString,
  tokenizeShellScript,
  type ShellToken,
} from './shell-script-tokenizer.js';

export { SHELL_OPERATORS };

/** Error code raised when `pyric sandbox` or `pyric run` refuses to spawn an unsupported child runtime. */
export const UNSUPPORTED_RUNTIME_CODE = 'PYRIC_UNSUPPORTED_RUNTIME';

/** Command basenames that cannot evaluate Node loader hooks, to the runtime. */
const UNSUPPORTED_RUNTIME_BINARIES = new Map<string, string>([
  ['bun', 'bun'],
  ['bunx', 'bun'],
  ['deno', 'deno'],
]);

const MAX_SCRIPT_DEPTH = 8;

/** Transparent command-prefix builtins/utilities that execute their target command. */
const TRANSPARENT_PREFIX_WRAPPERS = new Set(['builtin', 'nohup', 'time', 'nice']);

/** Resolve a package-runner target (`bun`, `bun@latest`, `deno@2`) to an unsupported runtime, if any. */
function runtimeFromPackageSpec(token: string): string | undefined {
  const base = commandBasename(token);
  const name = !base.startsWith('@') && base.includes('@') ? base.slice(0, base.indexOf('@')) : base;
  return UNSUPPORTED_RUNTIME_BINARIES.get(name);
}

type ScanState =
  | { readonly kind: 'command' }
  | { readonly kind: 'args' }
  | { readonly kind: 'env'; readonly acceptFlags: boolean }
  | { readonly kind: 'exec' }
  | { readonly kind: 'command-builtin' }
  | { readonly kind: 'prefix-wrapper'; readonly name: string }
  | { readonly kind: 'eval'; readonly acceptDashDash: boolean; readonly words: readonly string[] }
  | { readonly kind: 'case-head' }
  | { readonly kind: 'case-pattern' }
  | { readonly kind: 'npm' }
  | { readonly kind: 'npx' }
  | { readonly kind: 'pkg-manager' }
  | { readonly kind: 'dlx' }
  | { readonly kind: 'runner-target' }
  | { readonly kind: 'skip-one'; readonly next: ScanState }
  | { readonly kind: 'package-arg'; readonly next: ScanState }
  | { readonly kind: 'script-next'; readonly after: ScanState };

function enterCommandToken(raw: string): { readonly hit: string | null; readonly next: ScanState } {
  if (COMMAND_GROUP_TOKENS.has(raw) || ENV_ASSIGNMENT.test(raw)) {
    return { hit: null, next: { kind: 'command' } };
  }
  const base = commandBasename(raw);
  const direct = UNSUPPORTED_RUNTIME_BINARIES.get(base);
  if (direct !== undefined) return { hit: direct, next: { kind: 'args' } };
  if (base === 'env') return { hit: null, next: { kind: 'env', acceptFlags: true } };
  if (base === 'exec') return { hit: null, next: { kind: 'exec' } };
  if (base === 'command') return { hit: null, next: { kind: 'command-builtin' } };
  if (base === 'eval') return { hit: null, next: { kind: 'eval', acceptDashDash: true, words: [] } };
  if (base === 'case') return { hit: null, next: { kind: 'case-head' } };
  if (base === 'esac' || base === 'then' || base === 'else' || base === 'do' || base === 'fi' || base === 'done') {
    return { hit: null, next: { kind: 'command' } };
  }
  if (TRANSPARENT_PREFIX_WRAPPERS.has(base)) {
    return { hit: null, next: { kind: 'prefix-wrapper', name: base } };
  }
  if (base === 'npm') return { hit: null, next: { kind: 'npm' } };
  if (base === 'npx') return { hit: null, next: { kind: 'npx' } };
  if (base === 'pnpm' || base === 'yarn') return { hit: null, next: { kind: 'pkg-manager' } };
  if (SHELL_BINARIES.has(base)) return { hit: null, next: { kind: 'command' } };
  return { hit: null, next: { kind: 'args' } };
}

function detectInShellScript(script: string, depth: number): string | null {
  if (depth > MAX_SCRIPT_DEPTH) return null;
  const directHit = detectInShellTokens(tokenizeShellScript(script), depth);
  if (directHit !== null) return directHit;
  for (const sub of extractCommandSubstitutions(script)) {
    const subHit = detectInShellScript(sub, depth + 1);
    if (subHit !== null) return subHit;
  }
  return null;
}

function flushEvalWords(state: ScanState, depth: number): string | null {
  if (state.kind !== 'eval' || state.words.length === 0) return null;
  return detectInShellScript(state.words.join(' '), depth + 1);
}

function detectInShellTokens(initialTokens: readonly ShellToken[], depth: number): string | null {
  if (depth > MAX_SCRIPT_DEPTH) return null;
  const tokens: ShellToken[] = [...initialTokens];
  let state: ScanState = { kind: 'command' };
  let i = 0;

  while (i < tokens.length) {
    const token = tokens[i]!;
    const raw = token.value;

    if (SHELL_OPERATORS.has(raw)) {
      const evalHit = flushEvalWords(state, depth);
      if (evalHit !== null) return evalHit;
      state = { kind: 'command' };
      i++;
      continue;
    }
    if (state.kind === 'eval' && (raw === ')' || raw === '}')) {
      const evalHit = flushEvalWords(state, depth);
      if (evalHit !== null) return evalHit;
      state = { kind: 'command' };
      i++;
      continue;
    }

    switch (state.kind) {
      case 'command': {
        if (!COMMAND_GROUP_TOKENS.has(raw) && !ENV_ASSIGNMENT.test(raw)) {
          const base = commandBasename(raw);
          if (SHELL_BINARIES.has(base)) {
            const shellParsed = parseShellInvocation(tokens, i + 1);
            if (shellParsed.kind === 'command-script') {
              const hit = detectInShellScript(tokens[shellParsed.scriptIndex]!.value, depth + 1);
              if (hit !== null) return hit;
            }
            if (shellParsed.kind !== 'unclassified') {
              i = shellParsed.endIndex;
              state = { kind: 'args' };
              continue;
            }
            state = { kind: 'args' };
            i++;
            continue;
          }
        }
        const entered = enterCommandToken(raw);
        if (entered.hit !== null) return entered.hit;
        state = entered.next;
        i++;
        break;
      }
      case 'case-head': {
        if (raw === 'in') state = { kind: 'case-pattern' };
        i++;
        break;
      }
      case 'case-pattern': {
        if (raw === 'esac') {
          state = { kind: 'command' };
        } else if (raw === ')') {
          state = { kind: 'command' };
        }
        i++;
        break;
      }
      case 'args':
        i++;
        break;
      case 'skip-one':
        state = state.next;
        i++;
        break;
      case 'exec': {
        if (raw === '--') {
          state = { kind: 'command' };
        } else if (/^-[cl]*a$/.test(raw)) {
          state = { kind: 'skip-one', next: state };
        } else if (raw.startsWith('-')) {
          // Other exec flags (-c, -l, -aName)
        } else {
          state = { kind: 'command' };
          continue;
        }
        i++;
        break;
      }
      case 'command-builtin': {
        if (raw === '--') {
          state = { kind: 'command' };
        } else if (/^-p*[vV][pvV]*$/.test(raw) || raw === '--verbose') {
          state = { kind: 'args' };
        } else if (raw.startsWith('-')) {
          // Execution flag such as `command -p <cmd>`
        } else {
          state = { kind: 'command' };
          continue;
        }
        i++;
        break;
      }
      case 'prefix-wrapper': {
        if (raw === '--') {
          state = { kind: 'command' };
        } else if (state.name === 'nice' && (raw === '-n' || raw === '--adjustment')) {
          state = { kind: 'skip-one', next: state };
        } else if (raw.startsWith('-')) {
          // Wrapper option (-p on time, -10 / --adjustment=10 on nice)
        } else {
          state = { kind: 'command' };
          continue;
        }
        i++;
        break;
      }
      case 'eval': {
        if (state.acceptDashDash && raw === '--') {
          state = { kind: 'eval', acceptDashDash: false, words: state.words };
        } else {
          state = { kind: 'eval', acceptDashDash: false, words: [...state.words, raw] };
        }
        i++;
        break;
      }
      case 'package-arg': {
        const hit = runtimeFromPackageSpec(raw);
        if (hit !== undefined) return hit;
        state = state.next;
        i++;
        break;
      }
      case 'script-next': {
        const hit = detectInShellScript(raw, depth + 1);
        if (hit !== null) return hit;
        state = state.after;
        i++;
        break;
      }
      case 'runner-target': {
        const hit = runtimeFromPackageSpec(raw);
        if (hit !== undefined) return hit;
        state = { kind: 'command' };
        continue;
      }
      case 'env': {
        if (state.acceptFlags && raw.startsWith('-')) {
          const stepped = stepEnvOption(tokens, i);
          if (stepped.kind === 'unclassified') {
            state = { kind: 'args' };
            i++;
            continue;
          }
          if (stepped.kind === 'end-flags') {
            state = { kind: 'env', acceptFlags: false };
            i = stepped.nextIndex;
            continue;
          }
          if (stepped.splitString !== null) {
            const split = splitEnvSplitString(stepped.splitString);
            if (split.kind === 'classified') {
              tokens.splice(i, stepped.nextIndex - i, ...split.tokens);
              continue;
            }
            const fallbackHit = detectInShellScript(stepped.splitString, depth + 1);
            if (fallbackHit !== null) return fallbackHit;
            state = { kind: 'args' };
            i = stepped.nextIndex;
            continue;
          }
          i = stepped.nextIndex;
          continue;
        }
        if (ENV_ASSIGNMENT.test(raw)) {
          i++;
          continue;
        }
        state = { kind: 'command' };
        continue;
      }
      case 'npm': {
        if (raw === 'exec' || raw === 'x') {
          state = { kind: 'npx' };
        } else if (
          raw === '--prefix' ||
          raw === '-C' ||
          raw === '--workspace' ||
          raw === '-w' ||
          raw === '--userconfig' ||
          raw === '--cache'
        ) {
          state = { kind: 'skip-one', next: state };
        } else if (raw.startsWith('-')) {
          // Other npm global flags (--silent, --workspaces, --yes)
        } else {
          state = { kind: 'args' };
        }
        i++;
        break;
      }
      case 'npx': {
        if (raw === '--') {
          state = { kind: 'runner-target' };
        } else if (raw === '-c' || raw === '--call') {
          state = { kind: 'script-next', after: { kind: 'args' } };
        } else if (raw.startsWith('--call=')) {
          const hit = detectInShellScript(raw.slice('--call='.length), depth + 1);
          if (hit !== null) return hit;
          state = { kind: 'args' };
        } else if (raw === '-p' || raw === '--package') {
          state = { kind: 'package-arg', next: { kind: 'npx' } };
        } else if (raw.startsWith('--package=')) {
          const hit = runtimeFromPackageSpec(raw.slice('--package='.length));
          if (hit !== undefined) return hit;
        } else if (raw.startsWith('-')) {
          // Other npx flags (-y, --yes, -q, --quiet, --no-install)
        } else {
          const hit = runtimeFromPackageSpec(raw);
          if (hit !== undefined) return hit;
          state = { kind: 'command' };
          continue;
        }
        i++;
        break;
      }
      case 'pkg-manager': {
        if (raw === 'dlx' || raw === 'exec') {
          state = { kind: 'dlx' };
        } else if (raw === '--') {
          // `pnpm -- bun app.ts` or `yarn -- deno ...`
        } else if (raw === '--dir' || raw === '-C' || raw === '--filter' || raw === '-F' || raw === '--cwd') {
          state = { kind: 'skip-one', next: state };
        } else if (raw.startsWith('-')) {
          // Other pnpm/yarn flags (--silent, -s, -w, --workspace-root)
        } else {
          const hit = runtimeFromPackageSpec(raw);
          if (hit !== undefined) return hit;
          state = { kind: 'args' };
        }
        i++;
        break;
      }
      case 'dlx': {
        if (raw === '--') {
          state = { kind: 'runner-target' };
        } else if (raw === '-p' || raw === '--package') {
          state = { kind: 'package-arg', next: { kind: 'dlx' } };
        } else if (raw.startsWith('--package=')) {
          const hit = runtimeFromPackageSpec(raw.slice('--package='.length));
          if (hit !== undefined) return hit;
        } else if (raw === '-c' || raw === '--shell-mode') {
          state = { kind: 'script-next', after: { kind: 'args' } };
        } else if (raw.startsWith('-')) {
          // Other dlx flags (-q, --quiet, --silent)
        } else {
          const hit = runtimeFromPackageSpec(raw);
          if (hit !== undefined) return hit;
          state = { kind: 'command' };
          continue;
        }
        i++;
        break;
      }
    }
  }

  return flushEvalWords(state, depth);
}

/**
 * Decide whether the child command starts a runtime that cannot intercept.
 *
 * Returns the canonical runtime name (`bun` for `bunx` too) or `null`.
 */
export function detectUnsupportedRuntime(argv: readonly string[]): string | null {
  return detectInShellTokens(argv.flatMap(expandUnquotedOperators), 0);
}

/**
 * Format the actionable stop message emitted when `pyric sandbox` or `pyric run`
 * refuses an unswappable child runtime (`bun`, `bunx`, `deno`).
 */
export function formatUnsupportedRuntimeStop(
  runtime: string,
  label?: string,
  command = 'pyric sandbox',
): string {
  const commandNote = label !== undefined && label.trim().length > 0 ? ` (\`${label}\`)` : '';
  return (
    `${command}: stopped before starting \`${runtime}\`${commandNote} [${UNSUPPORTED_RUNTIME_CODE}].\n` +
    `  \`${runtime}\` does not run Node module.registerHooks, so firebase and firebase-admin imports cannot be swapped and would reach live Firebase.\n` +
    `  Run the command with \`node\` (Node >= 22.15) or \`npx tsx\` instead.\n`
  );
}

/**
 * Shared pre-spawn gate for `pyric sandbox` and `pyric run`: emits the one-time
 * `PYRIC_GUARD` / `PYRIC_GUARD_ALLOW` deprecation notice and, when `plan` starts
 * an unsupported child runtime, writes the stop error and returns `true`.
 */
export function checkSandboxChildLaunch(
  plan: { readonly argv: readonly string[]; readonly label?: string } | null,
  command = 'pyric sandbox',
  opts: {
    readonly env?: NodeJS.ProcessEnv;
    readonly write?: (line: string) => void;
    readonly slot?: Record<symbol, unknown>;
  } = {},
): boolean {
  const write = opts.write ?? ((line: string) => void process.stderr.write(line));
  warnDeprecatedGuardEnvOnce(opts.env ?? process.env, write, opts.slot);
  if (plan === null) return false;
  const unsupportedRuntime = detectUnsupportedRuntime(plan.argv);
  if (unsupportedRuntime === null) return false;
  write(formatUnsupportedRuntimeStop(unsupportedRuntime, plan.label, command));
  return true;
}
