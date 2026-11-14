/**
 * Child runtimes that cannot evaluate Node loader hooks, and the upfront stop
 * error `pyric sandbox` and `pyric run` raise instead of running unswapped code
 * (ADR 0023).
 */

import { warnDeprecatedGuardEnvOnce } from '../register/deprecated-guard-env.js';
import {
  COMMAND_GROUP_TOKENS,
  ENV_ASSIGNMENT,
  SHELL_OPERATORS,
  expandUnquotedOperators,
  extractCommandSubstitutions,
  tokenizeShellScript,
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

/** POSIX/Bourne shells whose `-c <script>` argument executes a shell command string. */
const SHELL_BINARIES = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);

const MAX_SCRIPT_DEPTH = 8;

/** Strip directory and a Windows `.exe` suffix from a command token. */
function commandBasename(token: string): string {
  const base = token.split(/[\\/]/).pop() ?? token;
  return base.toLowerCase().replace(/\.exe$/, '');
}

/** Resolve a package-runner target (`bun`, `bun@latest`, `deno@2`) to an unsupported runtime, if any. */
function runtimeFromPackageSpec(token: string): string | undefined {
  const base = commandBasename(token);
  const name = !base.startsWith('@') && base.includes('@') ? base.slice(0, base.indexOf('@')) : base;
  return UNSUPPORTED_RUNTIME_BINARIES.get(name);
}

/** Transparent command-prefix builtins/utilities that execute their target command. */
const TRANSPARENT_PREFIX_WRAPPERS = new Set(['builtin', 'nohup', 'time', 'nice']);

type ScanState =
  | { readonly kind: 'command' }
  | { readonly kind: 'args' }
  | { readonly kind: 'env'; readonly acceptFlags: boolean }
  | { readonly kind: 'exec' }
  | { readonly kind: 'command-builtin' }
  | { readonly kind: 'prefix-wrapper'; readonly name: string }
  | { readonly kind: 'eval'; readonly acceptDashDash: boolean; readonly words: readonly string[] }
  | { readonly kind: 'npm' }
  | { readonly kind: 'npx' }
  | { readonly kind: 'pkg-manager' }
  | { readonly kind: 'dlx' }
  | { readonly kind: 'runner-target' }
  | { readonly kind: 'shell' }
  | { readonly kind: 'skip-one'; readonly next: ScanState }
  | { readonly kind: 'package-arg'; readonly next: ScanState }
  | { readonly kind: 'script-next'; readonly after: ScanState };

function enterCommandToken(token: string): { readonly hit: string | null; readonly next: ScanState } {
  if (COMMAND_GROUP_TOKENS.has(token) || ENV_ASSIGNMENT.test(token)) {
    return { hit: null, next: { kind: 'command' } };
  }
  const base = commandBasename(token);
  const direct = UNSUPPORTED_RUNTIME_BINARIES.get(base);
  if (direct !== undefined) return { hit: direct, next: { kind: 'args' } };
  if (base === 'env') return { hit: null, next: { kind: 'env', acceptFlags: true } };
  if (base === 'exec') return { hit: null, next: { kind: 'exec' } };
  if (base === 'command') return { hit: null, next: { kind: 'command-builtin' } };
  if (base === 'eval') return { hit: null, next: { kind: 'eval', acceptDashDash: true, words: [] } };
  if (TRANSPARENT_PREFIX_WRAPPERS.has(base)) {
    return { hit: null, next: { kind: 'prefix-wrapper', name: base } };
  }
  if (base === 'npm') return { hit: null, next: { kind: 'npm' } };
  if (base === 'npx') return { hit: null, next: { kind: 'npx' } };
  if (base === 'pnpm' || base === 'yarn') return { hit: null, next: { kind: 'pkg-manager' } };
  if (SHELL_BINARIES.has(base)) return { hit: null, next: { kind: 'shell' } };
  return { hit: null, next: { kind: 'args' } };
}

function detectInShellScript(script: string, depth: number): string | null {
  if (depth > MAX_SCRIPT_DEPTH) return null;
  const directHit = detectInTokens(tokenizeShellScript(script), depth);
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

function detectInTokens(rawArgv: readonly string[], depth: number): string | null {
  if (depth > MAX_SCRIPT_DEPTH) return null;
  const tokens = rawArgv.flatMap(expandUnquotedOperators);
  let state: ScanState = { kind: 'command' };

  for (const token of tokens) {
    if (SHELL_OPERATORS.has(token)) {
      const evalHit = flushEvalWords(state, depth);
      if (evalHit !== null) return evalHit;
      state = { kind: 'command' };
      continue;
    }
    if (state.kind === 'eval' && (token === ')' || token === '}')) {
      const evalHit = flushEvalWords(state, depth);
      if (evalHit !== null) return evalHit;
      state = { kind: 'command' };
      continue;
    }

    switch (state.kind) {
      case 'command': {
        const entered = enterCommandToken(token);
        if (entered.hit !== null) return entered.hit;
        state = entered.next;
        break;
      }
      case 'args':
        break;
      case 'skip-one':
        state = state.next;
        break;
      case 'exec': {
        if (token === '--') {
          state = { kind: 'command' };
        } else if (/^-[cl]*a$/.test(token)) {
          state = { kind: 'skip-one', next: state };
        } else if (token.startsWith('-')) {
          // Other exec flags (-c, -l, -aName)
        } else {
          const entered = enterCommandToken(token);
          if (entered.hit !== null) return entered.hit;
          state = entered.next;
        }
        break;
      }
      case 'command-builtin': {
        if (token === '--') {
          state = { kind: 'command' };
        } else if (/^-p*[vV][pvV]*$/.test(token) || token === '--verbose') {
          // Lookup-only `command -v` / `command -V` inspects PATH without executing.
          state = { kind: 'args' };
        } else if (token.startsWith('-')) {
          // Execution flag such as `command -p <cmd>`
        } else {
          const entered = enterCommandToken(token);
          if (entered.hit !== null) return entered.hit;
          state = entered.next;
        }
        break;
      }
      case 'prefix-wrapper': {
        if (token === '--') {
          state = { kind: 'command' };
        } else if (state.name === 'nice' && (token === '-n' || token === '--adjustment')) {
          state = { kind: 'skip-one', next: state };
        } else if (token.startsWith('-')) {
          // Wrapper option (-p on time, -10 / --adjustment=10 on nice)
        } else {
          const entered = enterCommandToken(token);
          if (entered.hit !== null) return entered.hit;
          state = entered.next;
        }
        break;
      }
      case 'eval': {
        if (state.acceptDashDash && token === '--') {
          state = { kind: 'eval', acceptDashDash: false, words: state.words };
        } else {
          state = { kind: 'eval', acceptDashDash: false, words: [...state.words, token] };
        }
        break;
      }
      case 'package-arg': {
        const hit = runtimeFromPackageSpec(token);
        if (hit !== undefined) return hit;
        state = state.next;
        break;
      }
      case 'script-next': {
        const hit = detectInShellScript(token, depth + 1);
        if (hit !== null) return hit;
        state = state.after;
        break;
      }
      case 'runner-target': {
        const hit = runtimeFromPackageSpec(token);
        if (hit !== undefined) return hit;
        const entered = enterCommandToken(token);
        if (entered.hit !== null) return entered.hit;
        state = entered.next;
        break;
      }
      case 'env': {
        if (state.acceptFlags && token === '--') {
          state = { kind: 'env', acceptFlags: false };
        } else if (state.acceptFlags && (token === '-S' || token === '--split-string')) {
          state = { kind: 'script-next', after: { kind: 'env', acceptFlags: false } };
        } else if (
          state.acceptFlags &&
          (token.startsWith('--split-string=') || (token.startsWith('-S') && token.length > 2))
        ) {
          let script = token.slice(2);
          if (token.startsWith('--split-string=')) {
            script = token.slice('--split-string='.length);
          }
          const hit = detectInShellScript(script, depth + 1);
          if (hit !== null) return hit;
          state = { kind: 'env', acceptFlags: false };
        } else if (
          state.acceptFlags &&
          (/^-[i0v]*[uCa]$/.test(token) || token === '--unset' || token === '--chdir' || token === '--argv0')
        ) {
          state = { kind: 'skip-one', next: state };
        } else if (state.acceptFlags && token.startsWith('-')) {
          // Boolean or attached-value env flag (-i, -uFOO, --unset=FOO)
        } else if (ENV_ASSIGNMENT.test(token)) {
          // GNU env permutes flags and KEY=VAL assignments until `--` or the command binary.
        } else {
          const entered = enterCommandToken(token);
          if (entered.hit !== null) return entered.hit;
          state = entered.next;
        }
        break;
      }
      case 'npm': {
        if (token === 'exec' || token === 'x') {
          state = { kind: 'npx' };
        } else if (
          token === '--prefix' ||
          token === '-C' ||
          token === '--workspace' ||
          token === '-w' ||
          token === '--userconfig' ||
          token === '--cache'
        ) {
          state = { kind: 'skip-one', next: state };
        } else if (token.startsWith('-')) {
          // Other npm global flags (--silent, --workspaces, --yes)
        } else {
          state = { kind: 'args' };
        }
        break;
      }
      case 'npx': {
        if (token === '--') {
          state = { kind: 'runner-target' };
        } else if (token === '-c' || token === '--call') {
          state = { kind: 'script-next', after: { kind: 'args' } };
        } else if (token.startsWith('--call=')) {
          const hit = detectInShellScript(token.slice('--call='.length), depth + 1);
          if (hit !== null) return hit;
          state = { kind: 'args' };
        } else if (token === '-p' || token === '--package') {
          state = { kind: 'package-arg', next: { kind: 'npx' } };
        } else if (token.startsWith('--package=')) {
          const hit = runtimeFromPackageSpec(token.slice('--package='.length));
          if (hit !== undefined) return hit;
        } else if (token.startsWith('-')) {
          // Other npx flags (-y, --yes, -q, --quiet, --no-install)
        } else {
          const hit = runtimeFromPackageSpec(token);
          if (hit !== undefined) return hit;
          const entered = enterCommandToken(token);
          if (entered.hit !== null) return entered.hit;
          state = entered.next;
        }
        break;
      }
      case 'pkg-manager': {
        if (token === 'dlx' || token === 'exec') {
          state = { kind: 'dlx' };
        } else if (token === '--') {
          // `pnpm -- bun app.ts` or `yarn -- deno ...`
        } else if (
          token === '--dir' ||
          token === '-C' ||
          token === '--filter' ||
          token === '-F' ||
          token === '--cwd'
        ) {
          state = { kind: 'skip-one', next: state };
        } else if (token.startsWith('-')) {
          // Other pnpm/yarn flags (--silent, -s, -w, --workspace-root)
        } else {
          const hit = runtimeFromPackageSpec(token);
          if (hit !== undefined) return hit;
          state = { kind: 'args' };
        }
        break;
      }
      case 'dlx': {
        if (token === '--') {
          state = { kind: 'runner-target' };
        } else if (token === '-p' || token === '--package') {
          state = { kind: 'package-arg', next: { kind: 'dlx' } };
        } else if (token.startsWith('--package=')) {
          const hit = runtimeFromPackageSpec(token.slice('--package='.length));
          if (hit !== undefined) return hit;
        } else if (token === '-c' || token === '--shell-mode') {
          state = { kind: 'script-next', after: { kind: 'args' } };
        } else if (token.startsWith('-')) {
          // Other dlx flags (-q, --quiet, --silent)
        } else {
          const hit = runtimeFromPackageSpec(token);
          if (hit !== undefined) return hit;
          const entered = enterCommandToken(token);
          if (entered.hit !== null) return entered.hit;
          state = entered.next;
        }
        break;
      }
      case 'shell': {
        if (/^-[A-Za-np-z]*c[A-Za-np-z]*$/.test(token) || token === '--command') {
          state = { kind: 'script-next', after: { kind: 'args' } };
        } else if (
          token === '-o' ||
          token === '+o' ||
          token === '-O' ||
          token === '+O' ||
          token === '--rcfile' ||
          token === '--init-file'
        ) {
          state = { kind: 'skip-one', next: state };
        } else if (token.startsWith('-') || token.startsWith('+')) {
          // Other shell options (-e, -u, -x, -l, -m, --norc, --posix)
        } else {
          state = { kind: 'args' };
        }
        break;
      }
    }
  }

  return flushEvalWords(state, depth);
}

/**
 * Decide whether the child command starts a runtime that cannot intercept.
 *
 * Detection covers command starts across discrete and attached shell operators,
 * subshell parentheses, leading `KEY=VAL` assignments, `env` / `npx` /
 * `pnpm dlx` / `yarn dlx` launchers, and `sh` / `bash` / `zsh` `-c <script>`
 * invocations. `npm run dev` whose `package.json` script shells out to `bun`
 * remains outside argv inspection.
 *
 * Returns the canonical runtime name (`bun` for `bunx` too) or null.
 */
export function detectUnsupportedRuntime(argv: readonly string[]): string | null {
  return detectInTokens(argv, 0);
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
