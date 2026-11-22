import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { advertisedUrl } from '../serve/advertised-host.js';
import { formatPyricCommand, type PyricCommandPrefixOptions } from './command-hint.js';
import { parseCommandString } from './sandbox-runner.js';

export const PERSISTENCE_GUIDE_URL = 'https://pyric.dev/docs/observe/shape-your-data/';

export function formatBrowserPersistNoticeLine(): string {
  return (
    `  \u24d8 persist  data lives in this browser (IndexedDB) \u2014 see ${PERSISTENCE_GUIDE_URL}` +
    '\n             for what survives refresh/restart; `--persist` adds a committable .pyric/state/state.json'
  );
}

export function formatBridgeTipLine(options?: PyricCommandPrefixOptions): string {
  const mcpProxyCmd = formatPyricCommand('mcp-proxy', options);
  return `  tip  MCP? re-run with --bridge so an editor (Cursor / Claude / Antigravity) can attach via \`${mcpProxyCmd}\`.\n`;
}

function executableLabel(token: string): string {
  return basename(token).replace(/\.(?:cmd|exe|ps1|cjs|mjs|js)$/i, '').toLowerCase();
}

function readPackageScriptTokens(cwd: string, scriptName: string): string[] | null {
  try {
    const raw = readFileSync(join(cwd, 'package.json'), 'utf8');
    const pkg = JSON.parse(raw) as { scripts?: Record<string, unknown> };
    const script = pkg.scripts?.[scriptName];
    if (typeof script !== 'string' || script.trim() === '') {
      return null;
    }
    return parseCommandString(script);
  } catch (error) {
    void error;
    return null;
  }
}

function unwrapRunnerTokens(argv: readonly string[], cwd: string): readonly string[] {
  let tokens = [...argv];
  for (let depth = 0; depth < 4 && tokens.length > 0; depth += 1) {
    const head = executableLabel(tokens[0] ?? '');
    if (head === 'env') {
      let idx = 1;
      while (idx < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[idx] ?? '')) {
        idx += 1;
      }
      tokens = tokens.slice(idx);
      continue;
    }
    if (head === 'npx') {
      let idx = 1;
      while (idx < tokens.length && (tokens[idx] ?? '').startsWith('-')) {
        idx += 1;
      }
      tokens = tokens.slice(idx);
      continue;
    }
    if ((head === 'npm' || head === 'pnpm' || head === 'yarn' || head === 'bun') && tokens[1] === 'run') {
      const scriptName = tokens[2];
      if (scriptName !== undefined && !scriptName.startsWith('-')) {
        const expanded = readPackageScriptTokens(cwd, scriptName);
        if (expanded !== null) {
          const extra = tokens.slice(3).filter((item) => item !== '--');
          tokens = [...expanded, ...extra];
          continue;
        }
      }
    }
    if ((head === 'pnpm' || head === 'yarn') && (tokens[1] === 'exec' || tokens[1] === 'dlx')) {
      tokens = tokens.slice(2);
      continue;
    }
    break;
  }
  return tokens;
}

function readFlagValue(
  tokens: readonly string[],
  longFlags: readonly string[],
  shortFlags: readonly string[],
): string | undefined {
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] ?? '';
    for (const flag of [...longFlags, ...shortFlags]) {
      if (token === flag) {
        return tokens[i + 1];
      }
      if (token.startsWith(`${flag}=`)) {
        return token.slice(flag.length + 1);
      }
    }
  }
  return undefined;
}

interface FrameworkDefault {
  readonly defaultPort: number;
  readonly usesHttpsFlag: boolean;
}

function detectFrameworkServer(tokens: readonly string[]): FrameworkDefault | null {
  const bin = executableLabel(tokens[0] ?? '');
  const sub = tokens[1] ?? '';
  if (bin === 'next' && (sub === '' || sub === 'dev' || sub === 'start' || sub.startsWith('-'))) {
    const usesHttps = tokens.includes('--experimental-https');
    return { defaultPort: 3000, usesHttpsFlag: usesHttps };
  }
  if ((bin === 'nuxt' || bin === 'nuxi') && (sub === 'dev' || sub === 'preview')) {
    return { defaultPort: 3000, usesHttpsFlag: tokens.includes('--https') };
  }
  if (bin === 'astro' && (sub === '' || sub === 'dev' || sub === 'preview' || sub.startsWith('-'))) {
    return { defaultPort: 4321, usesHttpsFlag: false };
  }
  if (bin === 'vite' && (sub === '' || sub === 'dev' || sub === 'serve' || sub === 'preview' || sub.startsWith('-'))) {
    const defaultPort = sub === 'preview' ? 4173 : 5173;
    return { defaultPort, usesHttpsFlag: tokens.includes('--https') };
  }
  if (bin === 'react-router' && sub === 'dev') {
    return { defaultPort: 5173, usesHttpsFlag: false };
  }
  return null;
}

/**
 * Derive the browser origin of a known child dev server (`next dev`, `vite`,
 * `astro dev`, `nuxt dev`) from its launch command so `noTabError` can direct
 * the user to the app's own origin before any browser request has arrived.
 */
export function resolvePlannedChildAppOrigin(
  argv: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const tokens = unwrapRunnerTokens(argv, cwd);
  if (tokens.length === 0) {
    return undefined;
  }
  const framework = detectFrameworkServer(tokens);
  if (framework === null) {
    return undefined;
  }
  const rawPortFlag = readFlagValue(tokens, ['--port'], ['-p']);
  let port = framework.defaultPort;
  if (rawPortFlag !== undefined) {
    const parsed = Number(rawPortFlag);
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
      return undefined;
    }
    port = parsed;
  } else if (env.PORT !== undefined && /^\d+$/.test(env.PORT.trim())) {
    const envPort = Number(env.PORT.trim());
    if (envPort >= 1 && envPort <= 65535) {
      port = envPort;
    }
  }
  const rawHost =
    readFlagValue(tokens, ['--hostname', '--host'], ['-H']) ??
    (env.HOSTNAME !== undefined && env.HOSTNAME.trim() !== '' ? env.HOSTNAME.trim() : 'localhost');
  let host = rawHost.trim();
  if (host === '' || host.startsWith('-')) {
    host = 'localhost';
  }
  const scheme = framework.usesHttpsFlag ? 'https' : 'http';
  const bracketedHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  try {
    return new URL(advertisedUrl(`${scheme}://${bracketedHost}:${String(port)}`)).origin;
  } catch (error) {
    void error;
    return undefined;
  }
}
