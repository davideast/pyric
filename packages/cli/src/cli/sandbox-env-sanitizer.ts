/**
 * Environment-assignment, `env`-utility, and flat `sh -c` sanitization for
 * `spawnSandboxChild`: uses the shared `env`/shell option classifier
 * (`shell-command-classifier.ts`) to keep launcher-owned `PYRIC_*` activation
 * variables, canonical `NODE_OPTIONS` register preloads, and the execution-time
 * `PATH` shim intact across inline `KEY=VAL` assignments, bundled `env` flags
 * (`-iv`, `-iu`, `-vu`, `-vS`), `env -S`, and flat `sh -c` scripts.
 */
import {
  matchesRegisterSpecifier,
  withCanonicalRegisterNodeOptions,
} from '../register/child-process-guard.js';
import { prependShimToPath } from './launcher-path-shim.js';
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
  splitEnvSplitString,
  tokenizeFlatShellScript,
  type ShellToken,
} from './shell-script-tokenizer.js';

const MAX_SANITIZE_DEPTH = 6;

/**
 * Host-binding and activation variables owned by `buildChildEnv` that inline
 * `KEY=VAL` tokens or `env -u` flags on a `pyric sandbox` / `pyric run` command
 * must never blank or forge.
 */
export const PROTECTED_LAUNCHER_ENV_KEYS = new Set([
  'PYRIC_SANDBOX',
  'PYRIC_BEACON_TOKEN',
  'PYRIC_SESSION_TOKEN',
  'PYRIC_SANDBOX_INSTANCE',
  'PYRIC_WORKER_INIT',
  'PYRIC_WORKER_INIT_HOST',
]);

export function resolveLauncherRegisterUrl(
  nodeOptions: string | undefined,
  fallbackUrl: string,
): string {
  if (!nodeOptions) return fallbackUrl;
  const tailMatch = /(?:^|\s)--import(?:=|\s+)(\S+)\s*$/.exec(nodeOptions);
  const tailTarget = tailMatch?.[1];
  if (tailTarget !== undefined && matchesRegisterSpecifier(tailTarget, fallbackUrl)) {
    return tailTarget;
  }
  return fallbackUrl;
}

function isProtectedLauncherKey(key: string): boolean {
  return key === 'NODE_OPTIONS' || PROTECTED_LAUNCHER_ENV_KEYS.has(key);
}

export function sanitizeEnvAssignmentValue(
  key: string,
  val: string,
  optsEnv: NodeJS.ProcessEnv,
  registerUrl: string,
  shimDir: string | null = null,
): string | null {
  if (key === 'PATH' && shimDir !== null) {
    return prependShimToPath(val, shimDir) ?? shimDir;
  }
  if (!optsEnv.PYRIC_SANDBOX) return val;
  if (key === 'NODE_OPTIONS') {
    return withCanonicalRegisterNodeOptions(val, registerUrl);
  }
  if (PROTECTED_LAUNCHER_ENV_KEYS.has(key)) {
    return optsEnv[key] ?? null;
  }
  return val;
}

function quoteShellWord(word: string): string {
  if (word.length > 0 && /^[A-Za-z0-9_./:@=-]+$/.test(word)) return word;
  return `'${word.replace(/'/g, "'\\''")}'`;
}

export function formatShellCommand(tokens: readonly string[]): string {
  return tokens
    .map((token) => {
      if (SHELL_OPERATORS.has(token) || token === '(' || token === ')') return token;
      const envMatch = /^([A-Za-z_][A-Za-z0-9_]*=)(.*)$/.exec(token);
      if (envMatch) {
        return `${envMatch[1]}${quoteShellWord(envMatch[2]!)}`;
      }
      return quoteShellWord(token);
    })
    .join(' ');
}

function pinnedEnvAssignments(optsEnv: NodeJS.ProcessEnv, shimDir: string | null): string[] {
  const assignments: string[] = [];
  if (optsEnv.PYRIC_SANDBOX) {
    for (const key of ['NODE_OPTIONS', ...PROTECTED_LAUNCHER_ENV_KEYS]) {
      const pinned = optsEnv[key];
      if (pinned !== undefined) assignments.push(`${key}=${pinned}`);
    }
  }
  const pathVal = prependShimToPath(optsEnv.PATH, shimDir);
  if (pathVal !== undefined) assignments.push(`PATH=${pathVal}`);
  return assignments;
}

function sanitizeShellTokenStream(
  initialTokens: readonly ShellToken[],
  optsEnv: NodeJS.ProcessEnv,
  registerUrl: string,
  shimDir: string | null,
  depth: number,
): string[] {
  if (depth > MAX_SANITIZE_DEPTH) {
    return initialTokens.map((t) => t.value);
  }
  const tokens: ShellToken[] = [...initialTokens];
  const out: string[] = [];
  let mode: 'start' | 'env-flags' | 'env-assigns' | 'args' = 'start';
  let pendingIgnoreEnv = false;
  let i = 0;

  const flushPendingIgnoreEnv = (): void => {
    if (!pendingIgnoreEnv) return;
    pendingIgnoreEnv = false;
    out.push(...pinnedEnvAssignments(optsEnv, shimDir));
  };

  while (i < tokens.length) {
    const tok = tokens[i]!;
    const raw = tok.value;

    if (SHELL_OPERATORS.has(raw) || COMMAND_GROUP_TOKENS.has(raw)) {
      flushPendingIgnoreEnv();
      out.push(raw);
      mode = 'start';
      i++;
      continue;
    }

    if ((mode === 'start' || mode === 'env-flags' || mode === 'env-assigns') && ENV_ASSIGNMENT.test(raw)) {
      if (mode === 'env-flags') {
        flushPendingIgnoreEnv();
        mode = 'env-assigns';
      }
      const eq = raw.indexOf('=');
      const key = raw.slice(0, eq);
      const val = raw.slice(eq + 1);
      const rewritten = sanitizeEnvAssignmentValue(key, val, optsEnv, registerUrl, shimDir);
      if (rewritten !== null) {
        out.push(`${key}=${rewritten}`);
      }
      i++;
      continue;
    }

    if (mode === 'start') {
      const base = commandBasename(raw);
      if (base === 'env') {
        out.push(raw);
        mode = 'env-flags';
        i++;
        continue;
      }
      if (SHELL_BINARIES.has(base)) {
        const parsed = parseShellInvocation(tokens, i + 1);
        if (parsed.kind === 'command-script') {
          const scriptText = tokens[parsed.scriptIndex]!.value;
          const flat = tokenizeFlatShellScript(scriptText);
          for (let k = i; k < parsed.endIndex; k++) {
            if (k === parsed.scriptIndex && flat.kind === 'classified') {
              const innerSanitized = sanitizeShellTokenStream(
                flat.tokens,
                optsEnv,
                registerUrl,
                shimDir,
                depth + 1,
              );
              out.push(formatShellCommand(innerSanitized));
            } else {
              out.push(tokens[k]!.value);
            }
          }
          i = parsed.endIndex;
          mode = 'args';
          continue;
        }
      }
      out.push(raw);
      mode = 'args';
      i++;
      continue;
    }

    if (mode === 'env-flags') {
      if (raw.startsWith('-')) {
        const stepped = stepEnvOption(tokens, i);
        if (stepped.kind === 'unclassified') {
          flushPendingIgnoreEnv();
          out.push(raw);
          mode = 'args';
          i++;
          continue;
        }
        if (stepped.kind === 'end-flags') {
          out.push('--');
          flushPendingIgnoreEnv();
          mode = 'env-assigns';
          i = stepped.nextIndex;
          continue;
        }
        out.push(...stepped.passthroughArgs);
        if (stepped.unsetKey !== null && !isProtectedLauncherKey(stepped.unsetKey)) {
          out.push('-u', stepped.unsetKey);
        }
        if (stepped.ignoreEnv) {
          pendingIgnoreEnv = true;
        }
        if (stepped.splitString !== null) {
          const split = splitEnvSplitString(stepped.splitString);
          if (split.kind === 'classified') {
            tokens.splice(i, stepped.nextIndex - i, ...split.tokens);
            continue;
          }
          // Unclassifiable `-S` string: keep `-S <raw>` intact so `PATH` shim enforces at execution.
          flushPendingIgnoreEnv();
          out.push('-S', stepped.splitString);
          mode = 'args';
          i = stepped.nextIndex;
          continue;
        }
        i = stepped.nextIndex;
        continue;
      }
      flushPendingIgnoreEnv();
      mode = 'env-assigns';
      continue;
    }

    if (mode === 'env-assigns') {
      mode = 'start';
      continue;
    }

    out.push(raw);
    i++;
  }

  flushPendingIgnoreEnv();
  return out;
}

export function sanitizeCommandSegmentTokens(
  tokens: readonly string[],
  optsEnv: NodeJS.ProcessEnv,
  registerUrl: string,
  shimDir: string | null = null,
): string[] {
  if (!optsEnv.PYRIC_SANDBOX && shimDir === null) return [...tokens];
  const shellTokens: ShellToken[] = tokens.map((value) => ({
    value,
    hasDynamicExpansion: false,
    hasUnquotedGlob: false,
    isQuoted: false,
  }));
  return sanitizeShellTokenStream(shellTokens, optsEnv, registerUrl, shimDir, 0);
}
