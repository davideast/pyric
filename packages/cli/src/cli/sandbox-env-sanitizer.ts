/**
 * Environment-assignment and `env`-utility sanitization for `spawnSandboxChild`:
 * keeps launcher-owned `PYRIC_*` activation variables and canonical `NODE_OPTIONS`
 * register preloads intact across inline `KEY=VAL` assignments, `env -u`/`--unset`,
 * `env -i`/`--ignore-environment`, and chained shell operators.
 */
import { SHELL_OPERATORS } from './unsupported-runtime.js';
import {
  matchesRegisterSpecifier,
  withCanonicalRegisterNodeOptions,
} from '../register/child-process-guard.js';

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
): string | null {
  if (!optsEnv.PYRIC_SANDBOX) return val;
  if (key === 'NODE_OPTIONS') {
    return withCanonicalRegisterNodeOptions(val, registerUrl);
  }
  if (PROTECTED_LAUNCHER_ENV_KEYS.has(key)) {
    return optsEnv[key] ?? null;
  }
  return val;
}

function isEnvBinaryToken(token: string): boolean {
  const base = (token.split(/[\\/]/).pop() ?? token).toLowerCase().replace(/\.exe$/, '');
  return base === 'env';
}

export function sanitizeCommandSegmentTokens(
  tokens: readonly string[],
  optsEnv: NodeJS.ProcessEnv,
  registerUrl: string,
): string[] {
  if (!optsEnv.PYRIC_SANDBOX) return [...tokens];
  const sanitized: string[] = [];
  let mode: 'start' | 'env-flags' | 'env-assigns' | 'args' = 'start';

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (SHELL_OPERATORS.has(token) || token === '(' || token === ')') {
      sanitized.push(token);
      mode = 'start';
      continue;
    }
    if (
      (mode === 'start' || mode === 'env-flags' || mode === 'env-assigns') &&
      /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)
    ) {
      const eq = token.indexOf('=');
      const key = token.slice(0, eq);
      const val = token.slice(eq + 1);
      const rewritten = sanitizeEnvAssignmentValue(key, val, optsEnv, registerUrl);
      if (rewritten !== null) {
        sanitized.push(`${key}=${rewritten}`);
      }
      continue;
    }
    if (mode === 'start') {
      sanitized.push(token);
      mode = isEnvBinaryToken(token) ? 'env-flags' : 'args';
      continue;
    }
    if (mode === 'env-flags') {
      if (token === '--') {
        sanitized.push(token);
        mode = 'env-assigns';
        continue;
      }
      if ((token === '-u' || token === '--unset') && i + 1 < tokens.length) {
        const targetKey = tokens[i + 1]!;
        if (isProtectedLauncherKey(targetKey)) {
          i++;
          continue;
        }
        sanitized.push(token, targetKey);
        i++;
        continue;
      }
      if (token.startsWith('--unset=')) {
        const targetKey = token.slice('--unset='.length);
        if (isProtectedLauncherKey(targetKey)) continue;
        sanitized.push(token);
        continue;
      }
      if (token.startsWith('-u') && token.length > 2) {
        const targetKey = token.slice(2);
        if (isProtectedLauncherKey(targetKey)) continue;
        sanitized.push(token);
        continue;
      }
      if (token === '-' || token === '-i' || token === '--ignore-environment') {
        sanitized.push(token);
        for (const key of ['PYRIC_SANDBOX', 'NODE_OPTIONS', ...PROTECTED_LAUNCHER_ENV_KEYS]) {
          const pinned = optsEnv[key];
          if (pinned !== undefined) sanitized.push(`${key}=${pinned}`);
        }
        if (optsEnv.PATH !== undefined) sanitized.push(`PATH=${optsEnv.PATH}`);
        continue;
      }
      if ((token === '-C' || token === '--chdir' || token === '-a' || token === '--argv0') && i + 1 < tokens.length) {
        sanitized.push(token, tokens[i + 1]!);
        i++;
        continue;
      }
      if (token.startsWith('-')) {
        sanitized.push(token);
        continue;
      }
    }
    mode = 'args';
    sanitized.push(token);
  }
  return sanitized;
}
