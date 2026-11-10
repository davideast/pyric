import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const POINTER_REL = join('.pyric', 'serve.json');
const SESSION_REL = join('.pyric', 'session.json');
const CAPABILITY_TOKEN_REL = join('.pyric', 'capability-token');
const VALID_CAPABILITY_TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/;
const CANDIDATE_SUBDIRS = ['', 'web', 'frontend', 'client', 'app', 'ui', 'www'];

const TOKENS_BY_PORT_KEY = Symbol.for('pyric.localSessionTokensByPort');

function activeTokensByPort(): Map<number, string> {
  const holder = globalThis as unknown as Record<symbol, Map<number, string> | undefined>;
  const existing = holder[TOKENS_BY_PORT_KEY];
  if (existing !== undefined) return existing;
  const created = new Map<number, string>();
  holder[TOKENS_BY_PORT_KEY] = created;
  return created;
}

/** Registers an active server's capability token in-process by TCP port; returns an idempotent unregister closure. */
export function registerLocalSessionToken(port: number, token: string): () => void {
  if (!Number.isInteger(port) || port <= 0 || !token) return () => {};
  const map = activeTokensByPort();
  map.set(port, token);
  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    if (map.get(port) === token) {
      map.delete(port);
    }
  };
}

export function inProcessSessionTokenForPort(port: number | undefined): string | undefined {
  if (port === undefined || !Number.isInteger(port) || port <= 0) return undefined;
  return activeTokensByPort().get(port);
}

function parseLoopbackPort(rawUrl: string | undefined): number | undefined {
  if (!rawUrl) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return undefined;
  }
  if (!LOOPBACK_HOSTNAMES.has(parsed.hostname.toLowerCase())) return undefined;
  const defaultPort = parsed.protocol === 'https:' || parsed.protocol === 'wss:' ? 443 : 80;
  return parsed.port === '' ? defaultPort : Number(parsed.port);
}

export function inProcessSessionTokenForUrl(url: string | undefined): string | undefined {
  return inProcessSessionTokenForPort(parseLoopbackPort(url));
}

/** Appends `?token=<token>` to an MCP URL when `token` is non-empty and not already present. */
export function withMcpToken(url: string, token: string | undefined): string {
  if (!token) return url;
  try {
    const parsed = new URL(url);
    if (!parsed.searchParams.has('token')) {
      parsed.searchParams.set('token', token);
    }
    return parsed.toString();
  } catch {
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}token=${encodeURIComponent(token)}`;
  }
}

/** Writes `content` to `filePath` and enforces `0o600` owner-only permissions even when overwriting an existing file. */
export function writeMode600FileSync(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, { mode: 0o600 });
  try {
    chmodSync(filePath, 0o600);
  } catch {
    // Best-effort on filesystems without POSIX chmod semantics.
  }
}

/**
 * Reads the owner-only `0o600` project capability secret from `.pyric/capability-token`
 * for sandboxes that own durable `.pyric/state/` data (`--hosted` / `--persist`), so an
 * already-open browser tab reconnects seamlessly across a dev-server process restart.
 */
export function readDurableProjectCapabilityToken(projectDir: string): string | undefined {
  const filePath = join(projectDir, CAPABILITY_TOKEN_REL);
  if (!existsSync(filePath)) return undefined;
  try {
    const raw = readFileSync(filePath, 'utf8').trim();
    if (!VALID_CAPABILITY_TOKEN_RE.test(raw)) return undefined;
    try {
      chmodSync(filePath, 0o600);
    } catch {
      // Best-effort permission hardening.
    }
    return raw;
  } catch {
    return undefined;
  }
}

/** Writes `.pyric/capability-token` (`0o600`) once a durable offline sandbox owns `.pyric/state/`. */
export function writeDurableProjectCapabilityToken(projectDir: string, token: string): void {
  if (!VALID_CAPABILITY_TOKEN_RE.test(token)) return;
  try {
    writeMode600FileSync(join(projectDir, CAPABILITY_TOKEN_REL), `${token}\n`);
  } catch {
    // Read-only project roots still operate with their in-memory token.
  }
}

interface DiskTokenEntry {
  pid?: unknown;
  port?: unknown;
  url?: unknown;
  mcpUrl?: unknown;
  instanceId?: unknown;
  token?: unknown;
}

function isProcessAlive(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === 'EPERM';
  }
}

function extractEntryPort(entry: DiskTokenEntry): number | undefined {
  if (typeof entry.port === 'number' && Number.isInteger(entry.port) && entry.port > 0) {
    return entry.port;
  }
  for (const raw of [entry.mcpUrl, entry.url]) {
    if (typeof raw !== 'string') continue;
    const match = raw.match(/:(\d{2,5})(?:[/?]|$)/);
    if (match) return Number(match[1]);
  }
  return undefined;
}

function candidateTokenFiles(startDir: string): string[] {
  const files: string[] = [];
  const seen = new Set<string>();
  let current = resolve(startDir);
  for (;;) {
    for (const sub of CANDIDATE_SUBDIRS) {
      for (const rel of [POINTER_REL, SESSION_REL]) {
        const candidate = sub ? join(current, sub, rel) : join(current, rel);
        if (!seen.has(candidate)) {
          seen.add(candidate);
          files.push(candidate);
        }
      }
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return files;
}

/**
 * Writes `.pyric/session.json` (`0o600`) for runs that already own `.pyric/`
 * state (`--persist` / `--hosted`), even when `--bridge` is off, so sibling CLI
 * commands (`pyric snapshot`, `pyric assurance derive`) can authenticate.
 */
export function writeOwnedSessionFile(
  projectDir: string,
  info: { port: number; instanceId?: string; token: string },
): () => void {
  const sessionFile = join(projectDir, SESSION_REL);
  try {
    writeMode600FileSync(
      sessionFile,
      JSON.stringify(
        {
          pid: process.pid,
          port: info.port,
          ...(info.instanceId ? { instanceId: info.instanceId } : {}),
          token: info.token,
        },
        null,
        2,
      ) + '\n',
    );
  } catch {
    return () => {};
  }
  let cleaned = false;
  return () => {
    if (cleaned) return;
    cleaned = true;
    try {
      if (!existsSync(sessionFile)) return;
      const current = JSON.parse(readFileSync(sessionFile, 'utf8')) as DiskTokenEntry;
      if (current.pid === process.pid && current.token === info.token) {
        rmSync(sessionFile, { force: true });
      }
    } catch {
      // Best-effort cleanup.
    }
  };
}

/**
 * Resolves the capability token for a local server from:
 *   1. The in-process port registry (same-process callers & multi-server tests),
 *   2. `.pyric/serve.json` or `.pyric/session.json` (`0o600`) in `cwd` / ancestors,
 *   3. `PYRIC_SESSION_TOKEN` passed to spawned child processes.
 */
export function resolveSessionTokenForTarget(input: {
  cwd?: string;
  url?: string;
  port?: number;
  env?: NodeJS.ProcessEnv;
  explicitToken?: string;
}): string | undefined {
  if (typeof input.explicitToken === 'string' && input.explicitToken.length > 0) {
    return input.explicitToken;
  }

  const targetPort = input.port ?? parseLoopbackPort(input.url);
  const inProcess = inProcessSessionTokenForPort(targetPort);
  if (inProcess) return inProcess;

  if (input.cwd) {
    let fallbackWithoutPort: string | undefined;
    for (const filePath of candidateTokenFiles(input.cwd)) {
      if (!existsSync(filePath)) continue;
      try {
        const entry = JSON.parse(readFileSync(filePath, 'utf8')) as DiskTokenEntry;
        if (typeof entry.token !== 'string' || entry.token.length === 0) continue;
        if (!isProcessAlive(entry.pid)) continue;
        const entryPort = extractEntryPort(entry);
        if (targetPort !== undefined) {
          if (entryPort === targetPort) return entry.token;
        } else {
          fallbackWithoutPort ??= entry.token;
        }
      } catch {
        // Ignore unreadable or mid-write pointer files.
      }
    }
    if (fallbackWithoutPort) return fallbackWithoutPort;
  }

  const envToken = (input.env ?? process.env).PYRIC_SESSION_TOKEN;
  if (typeof envToken === 'string' && envToken.length > 0) {
    return envToken;
  }
  return undefined;
}
