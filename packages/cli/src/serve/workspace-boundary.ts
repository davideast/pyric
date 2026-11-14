import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { isLoopbackAddress } from './peer.js';

export const CANDIDATE_SUBDIRS = ['', 'web', 'frontend', 'client', 'app', 'ui', 'www'] as const;
export const ROOT_ONLY_SUBDIRS = [''] as const;

const OWNING_CONFIG_MARKERS = ['.firebaserc', 'firebase.json', 'pyric.json', 'pnpm-workspace.yaml'] as const;
const BOUNDARY_MARKERS = ['.git', 'firebase.json', '.firebaserc', 'pyric.json', 'package.json'] as const;

function hasWorkspacesPackageJson(dir: string): boolean {
  const pkgPath = join(dir, 'package.json');
  if (!existsSync(pkgPath)) return false;
  try {
    const parsed = JSON.parse(readFileSync(pkgPath, 'utf8')) as { workspaces?: unknown } | null;
    if (!parsed || typeof parsed !== 'object') return false;
    return Array.isArray(parsed.workspaces) || (parsed.workspaces !== null && typeof parsed.workspaces === 'object');
  } catch {
    return false;
  }
}

function isOwningWorkspaceConfigDir(dir: string): boolean {
  if (OWNING_CONFIG_MARKERS.some((marker) => existsSync(join(dir, marker)))) {
    return true;
  }
  return hasWorkspacesPackageJson(dir);
}

function hasBoundaryMarker(dir: string): boolean {
  return BOUNDARY_MARKERS.some((marker) => existsSync(join(dir, marker)));
}

/**
 * Finds the nearest owning Firebase/Pyric/monorepo workspace directory at or above
 * `startDir`, without crossing an enclosing `.git` repository root.
 */
export function findOwningWorkspaceDir(startDir: string): string | null {
  let dir = resolve(startDir);
  for (;;) {
    if (isOwningWorkspaceConfigDir(dir)) return dir;
    if (existsSync(join(dir, '.git'))) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export interface WorkspaceSearchEntry {
  dir: string;
  includeSubdirs: boolean;
}

/**
 * Walks upward from `startDir` up to the owning workspace/project root (or the first
 * project/repository boundary marker when outside an owning workspace), never climbing
 * past `.git`, `firebase.json`, `.firebaserc`, `pyric.json`, or standalone `package.json`.
 */
export function candidateWorkspaceDirectories(startDir: string): WorkspaceSearchEntry[] {
  const entries: WorkspaceSearchEntry[] = [];
  const resolvedStart = resolve(startDir);
  const owningRoot = findOwningWorkspaceDir(resolvedStart);
  const insideOwningRoot =
    owningRoot !== null &&
    (resolvedStart === owningRoot || resolvedStart.startsWith(owningRoot + sep));
  let current = resolvedStart;
  for (;;) {
    const hasGitMarker = existsSync(join(current, '.git'));
    const includeSubdirs = current === resolvedStart || current === owningRoot || hasGitMarker;
    entries.push({ dir: current, includeSubdirs });
    if (insideOwningRoot && current === owningRoot) break;
    if (!insideOwningRoot && hasBoundaryMarker(current)) break;
    if (hasGitMarker) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return entries;
}

function parseLoopbackPortSpec(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  if (/^\d{1,5}$/.test(trimmed)) {
    const numeric = Number(trimmed);
    if (numeric > 0 && numeric <= 65535) return numeric;
    return undefined;
  }
  let candidateUrl = trimmed;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    candidateUrl = `http://${trimmed}`;
  }
  let parsed: URL;
  try {
    parsed = new URL(candidateUrl);
  } catch {
    return undefined;
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host !== 'localhost' && !isLoopbackAddress(host)) return undefined;
  const isTls = parsed.protocol === 'https:' || parsed.protocol === 'wss:';
  const defaultPort = isTls ? 443 : 80;
  if (parsed.port === '') return defaultPort;
  const port = Number(parsed.port);
  if (Number.isInteger(port) && port > 0 && port <= 65535) return port;
  return undefined;
}

function recordBoundEnvPort(raw: string | undefined, boundPorts: number[]): boolean {
  if (raw === undefined) return true;
  const trimmed = raw.trim();
  if (trimmed === '') return true;
  const parsed = parseLoopbackPortSpec(trimmed);
  if (parsed === undefined) return false;
  boundPorts.push(parsed);
  return true;
}

/**
 * Checks whether `env.PYRIC_SESSION_TOKEN` is allowed to authenticate to `targetPort`.
 * Suppresses the ambient token whenever environment host/port bindings (`PYRIC_LIVE_HOST`,
 * `PYRIC_SANDBOX=remote:<url>`, `PYRIC_SANDBOX_PORT`, `PYRIC_WORKER_INIT_HOST`, or bare
 * `PYRIC_SANDBOX=remote` backed by a disk pointer on another port) name a different port
 * or an unparseable/non-loopback endpoint.
 */
export function isEnvSessionTokenAllowedForPort(input: {
  env: NodeJS.ProcessEnv;
  targetPort: number | undefined;
  diskPorts?: ReadonlySet<number>;
  tokenMismatchedOnDisk?: boolean;
}): boolean {
  const { env, targetPort } = input;
  if (targetPort === undefined) return true;
  if (input.tokenMismatchedOnDisk === true) return false;

  const boundEnvPorts: number[] = [];
  if (!recordBoundEnvPort(env.PYRIC_LIVE_HOST, boundEnvPorts)) return false;
  if (!recordBoundEnvPort(env.PYRIC_SANDBOX_PORT, boundEnvPorts)) return false;
  if (!recordBoundEnvPort(env.PYRIC_WORKER_INIT_HOST, boundEnvPorts)) return false;

  const sandboxSpec = env.PYRIC_SANDBOX?.trim();
  if (typeof sandboxSpec === 'string' && sandboxSpec !== '') {
    if (sandboxSpec.startsWith('remote:')) {
      const remoteUrl = sandboxSpec.slice('remote:'.length);
      if (!recordBoundEnvPort(remoteUrl, boundEnvPorts)) return false;
    } else if (sandboxSpec === 'remote' && input.diskPorts && input.diskPorts.size > 0) {
      if (!input.diskPorts.has(targetPort)) return false;
    }
  }

  if (boundEnvPorts.length > 0 && !boundEnvPorts.every((port) => port === targetPort)) {
    return false;
  }
  return true;
}
