/**
 * Child runtimes that cannot evaluate Node loader hooks, and the upfront stop
 * error `pyric sandbox` and `pyric run` raise instead of running unswapped code
 * (ADR 0023).
 */

import { warnDeprecatedGuardEnvOnce } from '../register/deprecated-guard-env.js';

/** Error code raised when `pyric sandbox` or `pyric run` refuses to spawn an unsupported child runtime. */
export const UNSUPPORTED_RUNTIME_CODE = 'PYRIC_UNSUPPORTED_RUNTIME';

/** Tokens that end one command and begin the next inside a shell string. */
export const SHELL_OPERATORS = new Set(['&&', '||', '|', ';', '&']);

/** Grouping tokens that leave the parser at the start of a command. */
const COMMAND_GROUP_TOKENS = new Set(['(', ')', '{', '}']);

/** Command basenames that cannot evaluate Node loader hooks, to the runtime. */
const UNSUPPORTED_RUNTIME_BINARIES = new Map<string, string>([
  ['bun', 'bun'],
  ['bunx', 'bun'],
  ['deno', 'deno'],
]);

/** POSIX/Bourne shells whose `-c <script>` argument executes a shell command string. */
const SHELL_BINARIES = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);

/** Leading `KEY=VAL` environment assignments in a shell command. */
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

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

/**
 * Split unquoted shell operators and subshell parentheses inside a single
 * whitespace-free argv token (e.g. `b;`, `false||deno`, `(bun`), while leaving
 * quoted/multi-word arguments, `KEY=VAL` assignments, `--flag=val` options, and
 * URLs intact.
 */
function expandUnquotedOperators(token: string): string[] {
  if (
    token.length === 0 ||
    SHELL_OPERATORS.has(token) ||
    COMMAND_GROUP_TOKENS.has(token) ||
    /\s/.test(token) ||
    ENV_ASSIGNMENT.test(token) ||
    /^--[A-Za-z0-9_-]+=/.test(token) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(token)
  ) {
    return [token];
  }

  const out: string[] = [];
  let buf = '';
  let i = 0;
  const flush = (): void => {
    if (buf.length > 0) {
      out.push(buf);
      buf = '';
    }
  };

  while (i < token.length) {
    const ch = token[i]!;
    const two = token.slice(i, i + 2);
    if (two === '&&' || two === '||') {
      flush();
      out.push(two);
      i += 2;
      continue;
    }
    if (ch === ';' || ch === '|' || ch === '&' || ch === '(' || ch === ')') {
      flush();
      out.push(ch);
      i++;
      continue;
    }
    buf += ch;
    i++;
  }
  flush();
  return out;
}

/**
 * Tokenize a shell `-c` / `env -S` script string into words and unquoted shell
 * operators while keeping single- and double-quoted segments attached.
 */
function tokenizeShellScript(script: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inToken = false;
  let i = 0;

  const flush = (): void => {
    if (inToken) {
      tokens.push(current);
      current = '';
      inToken = false;
    }
  };

  while (i < script.length) {
    const ch = script[i]!;
    if (ch === '\n' || ch === '\r') {
      flush();
      tokens.push(';');
      i++;
      continue;
    }
    if (/\s/.test(ch)) {
      flush();
      i++;
      continue;
    }
    const two = script.slice(i, i + 2);
    if (two === '&&' || two === '||') {
      flush();
      tokens.push(two);
      i += 2;
      continue;
    }
    if (ch === ';' || ch === '|' || ch === '&' || ch === '(' || ch === ')') {
      flush();
      tokens.push(ch);
      i++;
      continue;
    }
    inToken = true;
    if (ch === "'") {
      i++;
      while (i < script.length && script[i] !== "'") {
        current += script[i]!;
        i++;
      }
      if (i < script.length) i++;
      continue;
    }
    if (ch === '"') {
      i++;
      while (i < script.length && script[i] !== '"') {
        if (script[i] === '\\' && i + 1 < script.length && (script[i + 1] === '"' || script[i + 1] === '\\')) {
          current += script[i + 1]!;
          i += 2;
          continue;
        }
        current += script[i]!;
        i++;
      }
      if (i < script.length) i++;
      continue;
    }
    if (ch === '\\' && i + 1 < script.length) {
      current += script[i + 1]!;
      i += 2;
      continue;
    }
    current += ch;
    i++;
  }
  flush();
  return tokens;
}

type ScanState =
  | { readonly kind: 'command' }
  | { readonly kind: 'args' }
  | { readonly kind: 'env'; readonly acceptFlags: boolean }
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
  if (base === 'npm') return { hit: null, next: { kind: 'npm' } };
  if (base === 'npx') return { hit: null, next: { kind: 'npx' } };
  if (base === 'pnpm' || base === 'yarn') return { hit: null, next: { kind: 'pkg-manager' } };
  if (SHELL_BINARIES.has(base)) return { hit: null, next: { kind: 'shell' } };
  return { hit: null, next: { kind: 'args' } };
}

function detectInTokens(rawArgv: readonly string[], depth: number): string | null {
  if (depth > MAX_SCRIPT_DEPTH) return null;
  const tokens = rawArgv.flatMap(expandUnquotedOperators);
  let state: ScanState = { kind: 'command' };

  for (const token of tokens) {
    if (SHELL_OPERATORS.has(token)) {
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
      case 'package-arg': {
        const hit = runtimeFromPackageSpec(token);
        if (hit !== undefined) return hit;
        state = state.next;
        break;
      }
      case 'script-next': {
        const hit = detectInTokens(tokenizeShellScript(token), depth + 1);
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
          const script = token.startsWith('--split-string=')
            ? token.slice('--split-string='.length)
            : token.slice(2);
          const hit = detectInTokens(tokenizeShellScript(script), depth + 1);
          if (hit !== null) return hit;
          state = { kind: 'env', acceptFlags: false };
        } else if (
          state.acceptFlags &&
          (/^-[i0v]*[uC]$/.test(token) || token === '--unset' || token === '--chdir')
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
          const hit = detectInTokens(tokenizeShellScript(token.slice('--call='.length)), depth + 1);
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
        if (/^-[A-Za-ln-np-z]*c[A-Za-ln-np-z]*$/.test(token) || token === '--command') {
          state = { kind: 'script-next', after: { kind: 'args' } };
        } else if (token === '-o' || token === '+o') {
          state = { kind: 'skip-one', next: state };
        } else if (token.startsWith('-') || token.startsWith('+')) {
          // Other shell options (-e, -u, -x, -l)
        } else {
          state = { kind: 'args' };
        }
        break;
      }
    }
  }

  return null;
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
