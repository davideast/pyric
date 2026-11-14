import { existsSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { HostTrust } from 'pyric/sandbox/internal';
import { honorsCertificatePin, trustedFetch } from '../remote/loopback-tls.js';
import type { AnsweringHost, Discovered } from './discovery.js';
import { writeMode600FileSync } from './mode600-file.js';
import { isLoopbackAddress } from './peer.js';
import {
  CANDIDATE_SUBDIRS,
  candidateWorkspaceDirectories,
  findOwningWorkspaceDir,
  isEnvSessionTokenAllowedForPort,
  ROOT_ONLY_SUBDIRS,
} from './workspace-boundary.js';

export { writeMode600FileSync };

const POINTER_REL = join('.pyric', 'serve.json');
const SESSION_REL = join('.pyric', 'session.json');
const WORKSPACE_GROUPS = ['apps', 'packages', 'services'] as const;

const TOKENS_BY_PORT_KEY = Symbol.for('pyric.localSessionTokensByPort');
const REQUIRED_TOKENS_KEY = Symbol.for('pyric.requiredSessionTokens');
const PROJECT_POLICIES_KEY = Symbol.for('pyric.projectSessionPolicies');

export interface ProjectSessionPolicy {
  token: string;
  requireSessionToken: boolean;
}

function activeTokensByPort(): Map<number, string> {
  const holder = globalThis as unknown as Record<symbol, Map<number, string> | undefined>;
  const existing = holder[TOKENS_BY_PORT_KEY];
  if (existing !== undefined) return existing;
  const created = new Map<number, string>();
  holder[TOKENS_BY_PORT_KEY] = created;
  return created;
}

function requiredSessionTokens(): Set<string> {
  const holder = globalThis as unknown as Record<symbol, Set<string> | undefined>;
  const existing = holder[REQUIRED_TOKENS_KEY];
  if (existing !== undefined) return existing;
  const created = new Set<string>();
  holder[REQUIRED_TOKENS_KEY] = created;
  return created;
}

function projectSessionPolicies(): Map<string, ProjectSessionPolicy> {
  const holder = globalThis as unknown as Record<symbol, Map<string, ProjectSessionPolicy> | undefined>;
  const existing = holder[PROJECT_POLICIES_KEY];
  if (existing !== undefined) return existing;
  const created = new Map<string, ProjectSessionPolicy>();
  holder[PROJECT_POLICIES_KEY] = created;
  return created;
}

export function registerSessionTokenRequirement(token: string | undefined, required: boolean): () => void {
  if (!token || !required) return () => {};
  const set = requiredSessionTokens();
  set.add(token);
  return () => {
    set.delete(token);
  };
}

export function isSessionTokenRequired(token: string | undefined): boolean {
  if (!token) return false;
  return requiredSessionTokens().has(token);
}

export function registerProjectSessionPolicy(
  projectDir: string,
  policy: ProjectSessionPolicy,
): () => void {
  const key = resolve(projectDir);
  const map = projectSessionPolicies();
  map.set(key, policy);
  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    if (map.get(key) === policy) {
      map.delete(key);
    }
  };
}

export function projectSessionPolicyFor(projectDir: string): ProjectSessionPolicy | undefined {
  return projectSessionPolicies().get(resolve(projectDir));
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
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host !== 'localhost' && !isLoopbackAddress(host)) return undefined;
  const isTls = parsed.protocol === 'https:' || parsed.protocol === 'wss:';
  const defaultPort = isTls ? 443 : 80;
  if (parsed.port === '') return defaultPort;
  return Number(parsed.port);
}

export function inProcessSessionTokenForUrl(url: string | undefined): string | undefined {
  return inProcessSessionTokenForPort(parseLoopbackPort(url));
}

interface DiskTokenEntry {
  pid?: unknown;
  port?: unknown;
  url?: unknown;
  mcpUrl?: unknown;
  instanceId?: unknown;
  token?: unknown;
  tls?: {
    ca?: unknown;
    fingerprint256?: unknown;
  };
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
  for (const { dir, includeSubdirs } of candidateWorkspaceDirectories(startDir)) {
    const subdirs = includeSubdirs ? CANDIDATE_SUBDIRS : ROOT_ONLY_SUBDIRS;
    for (const sub of subdirs) {
      let baseDir = dir;
      if (sub !== '') {
        baseDir = join(dir, sub);
      }
      for (const rel of [POINTER_REL, SESSION_REL]) {
        const candidate = join(baseDir, rel);
        if (!seen.has(candidate)) {
          seen.add(candidate);
          files.push(candidate);
        }
      }
    }
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
  const record: Record<string, unknown> = {
    pid: process.pid,
    port: info.port,
    token: info.token,
  };
  if (info.instanceId) {
    record.instanceId = info.instanceId;
  }
  try {
    writeMode600FileSync(sessionFile, `${JSON.stringify(record, null, 2)}\n`);
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

  const hasTargetUrl = typeof input.url === 'string' && input.url.length > 0;
  const targetPort = input.port ?? parseLoopbackPort(input.url);
  if (hasTargetUrl && targetPort === undefined) {
    return undefined;
  }

  const inProcess = inProcessSessionTokenForPort(targetPort);
  if (inProcess) return inProcess;

  const env = input.env ?? process.env;
  const envToken = env.PYRIC_SESSION_TOKEN;
  const diskPorts = new Set<number>();
  let tokenMismatchedOnDisk = false;

  if (input.cwd) {
    let fallbackWithoutPort: string | undefined;
    for (const filePath of candidateTokenFiles(input.cwd)) {
      if (!existsSync(filePath)) continue;
      try {
        const entry = JSON.parse(readFileSync(filePath, 'utf8')) as DiskTokenEntry;
        if (typeof entry.token !== 'string' || entry.token.length === 0) continue;
        if (!isProcessAlive(entry.pid)) continue;
        const entryPort = extractEntryPort(entry);
        if (entryPort !== undefined) {
          diskPorts.add(entryPort);
        }
        if (targetPort !== undefined) {
          if (entryPort === targetPort) return entry.token;
          if (entryPort !== undefined && entry.token === envToken) {
            tokenMismatchedOnDisk = true;
          }
        } else {
          fallbackWithoutPort ??= entry.token;
        }
      } catch {
        // Ignore unreadable or mid-write pointer files.
      }
    }
    if (fallbackWithoutPort) return fallbackWithoutPort;
  }

  if (typeof envToken === 'string' && envToken.length > 0) {
    if (
      !isEnvSessionTokenAllowedForPort({
        env,
        targetPort,
        diskPorts,
        tokenMismatchedOnDisk,
      })
    ) {
      return undefined;
    }
    return envToken;
  }
  return undefined;
}

function candidateTlsPointerFiles(startDir: string): string[] {
  const files = [...candidateTokenFiles(startDir)];
  const seen = new Set(files);
  const projectRoot = findOwningWorkspaceDir(startDir) ?? resolve(startDir);
  for (const group of WORKSPACE_GROUPS) {
    const groupDir = join(projectRoot, group);
    if (!existsSync(groupDir)) continue;
    try {
      for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const candidate = join(groupDir, entry.name, POINTER_REL);
        if (!seen.has(candidate)) {
          seen.add(candidate);
          files.push(candidate);
        }
      }
    } catch {
      // Ignore unreadable workspace directories.
    }
  }
  return files;
}

function httpOriginFromTargetUrl(rawUrl: string): string | undefined {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol === 'wss:') {
      parsed.protocol = 'https:';
      return parsed.origin;
    }
    if (parsed.protocol === 'https:') {
      return parsed.origin;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function resolveLoopbackTlsTrustForTarget(input: {
  cwd?: string;
  url?: string;
  port?: number;
}): HostTrust | undefined {
  if (!input.url || !input.cwd) return undefined;
  const origin = httpOriginFromTargetUrl(input.url);
  if (origin === undefined) return undefined;
  const targetPort = input.port ?? parseLoopbackPort(origin);
  if (targetPort === undefined) return undefined;

  for (const filePath of candidateTlsPointerFiles(input.cwd)) {
    if (!existsSync(filePath)) continue;
    try {
      const entry = JSON.parse(readFileSync(filePath, 'utf8')) as DiskTokenEntry;
      if (!isProcessAlive(entry.pid)) continue;
      if (extractEntryPort(entry) !== targetPort) continue;
      const tls = entry.tls;
      if (!tls || typeof tls !== 'object') continue;
      let ca: string[] = [];
      if (Array.isArray(tls.ca)) {
        ca = tls.ca.filter((item): item is string => typeof item === 'string' && item.length > 0);
      }
      let fingerprint256: string | undefined;
      if (typeof tls.fingerprint256 === 'string' && tls.fingerprint256.length > 0) {
        fingerprint256 = tls.fingerprint256;
      }
      if (ca.length === 0 || fingerprint256 === undefined) continue;
      return { origin, ca, fingerprint256 };
    } catch {
      // Ignore unreadable pointer files.
    }
  }
  return undefined;
}

export function fetchLoopbackTarget(
  url: string,
  init?: RequestInit,
  cwd?: string,
): Promise<Response> {
  if (url.startsWith('https://') && cwd && honorsCertificatePin()) {
    const trust = resolveLoopbackTlsTrustForTarget({ cwd, url });
    if (trust !== undefined) {
      return trustedFetch(trust)(url, init);
    }
  }
  return fetch(url, init);
}

function answeredBase(base: string): string {
  return base.replace(/\/$/, '');
}

export async function probeHttpsHostUrl(
  rawUrl: string,
  cwd: string,
): Promise<AnsweringHost | null> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  const port = parseLoopbackPort(parsed.origin);
  if (port === undefined) return null;
  const candidates = [...new Set([`https://127.0.0.1:${port}`, `https://[::1]:${port}`, parsed.origin])];
  for (const base of candidates) {
    const token = resolveSessionTokenForTarget({ url: base, port, cwd });
    const headers: Record<string, string> = { accept: 'application/json' };
    if (token !== undefined) {
      headers['x-pyric-session-token'] = token;
    }
    try {
      const res = await fetchLoopbackTarget(
        `${base}/__pyric/health`,
        {
          headers,
          signal: AbortSignal.timeout(1_000),
        },
        cwd,
      );
      if (!res.ok) continue;
      const body = (await res.json()) as {
        mode?: unknown;
        instanceId?: unknown;
        sandboxConnected?: unknown;
      };
      if (body?.mode !== 'sandbox') continue;
      const instanceId = typeof body.instanceId === 'string' ? body.instanceId : null;
      return {
        base: answeredBase(base),
        instanceId,
      };
    } catch {
      // Try next loopback family.
    }
  }
  return null;
}

export async function discoverHttpsPointer(cwd: string): Promise<Discovered | null> {
  for (const filePath of candidateTlsPointerFiles(cwd)) {
    if (!filePath.endsWith(POINTER_REL) || !existsSync(filePath)) continue;
    try {
      const entry = JSON.parse(readFileSync(filePath, 'utf8')) as DiskTokenEntry;
      if (!isProcessAlive(entry.pid)) continue;
      const url = typeof entry.url === 'string' ? entry.url : undefined;
      if (!url || !url.startsWith('https://')) continue;
      const answered = await probeHttpsHostUrl(url, cwd);
      if (answered === null) continue;
      const entryInstanceId = typeof entry.instanceId === 'string' ? entry.instanceId : null;
      if (entryInstanceId !== null && answered.instanceId !== null && answered.instanceId !== entryInstanceId) {
        continue;
      }
      const pointerDir = dirname(dirname(filePath));
      let canonicalDir = pointerDir;
      try {
        canonicalDir = realpathSync(pointerDir);
      } catch {
        // Keep resolved directory when realpath fails.
      }
      let token: string | undefined;
      if (typeof entry.token === 'string' && entry.token.length > 0) {
        token = entry.token;
      } else {
        token = resolveSessionTokenForTarget({ url: answered.base, cwd });
      }
      let mcpUrl = `${answered.base}/__pyric/mcp`;
      if (typeof entry.mcpUrl === 'string') {
        mcpUrl = entry.mcpUrl;
      }
      const discovered: Discovered = {
        pointerProjectDir: canonicalDir,
        mcpUrl,
        url,
        base: answered.base,
        instanceId: entryInstanceId ?? answered.instanceId,
        source: `pointer:${filePath}`,
      };
      if (token !== undefined) {
        discovered.token = token;
      }
      return discovered;
    } catch {
      // Ignore unreadable pointer files.
    }
  }
  return null;
}
