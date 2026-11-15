/**
 * Project identity, MCP `initialize.instructions`, `_pyric` envelope metadata,
 * and Node-host capability probing for `pyric mcp`.
 *
 * Kept separate from `in-process.ts` so project-directory detection and host
 * probing stay small, cohesive, and directly testable.
 */
import { existsSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { boundedRequest } from '../../bounded-request.js';
import type { Discovered } from '../../serve/discovery.js';
import {
  fetchLoopbackTarget,
  resolveSessionTokenForTarget,
} from '../../serve/local-session-token.js';

/** Files whose presence indicates a Firebase or Pyric project directory. */
const PROJECT_MARKERS: readonly string[] = [
  'firebase.json',
  'pyric.json',
  '.firebaserc',
  'firestore.rules',
  'database.rules.json',
  'storage.rules',
];

export interface ProjectIdentity {
  /** Canonical absolute path of the active project directory. */
  readonly projectDir: string;
  /** True when at least one Firebase or Pyric project marker exists in `projectDir`. */
  readonly isProject: boolean;
}

export interface PyricEnvelope {
  mode: 'sandbox' | 'live';
  project: string;
  target: 'host' | 'in-process';
  projectDir?: string;
  isProject?: boolean;
}

export interface NodeHostProbe {
  /** True when the discovered host mounts `/__pyric/hosted/method` (Node hosted or live). */
  readonly supportsMethods: boolean;
  /** Host runtime mode reported by `/__pyric/health`. */
  readonly mode: 'sandbox' | 'live';
}

function canonicalProjectDir(projectDir: string): string {
  const resolved = resolve(projectDir);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function hasProjectMarker(projectDir: string): boolean {
  for (const marker of PROJECT_MARKERS) {
    if (existsSync(join(projectDir, marker))) return true;
  }
  return false;
}

export function resolveProjectIdentity(projectDir: string): ProjectIdentity {
  const canonical = canonicalProjectDir(projectDir);
  return {
    projectDir: canonical,
    isProject: hasProjectMarker(canonical),
  };
}

/**
 * One concise sentence returned as MCP `initialize.instructions`, naming the
 * active project directory, target, and a warning when no project markers exist.
 */
export function formatMcpInstructions(
  identity: ProjectIdentity,
  target: 'host' | 'in-process',
  hostUrl?: string,
): string {
  let targetPhrase = 'an in-process sandbox';
  if (target === 'host') {
    if (hostUrl !== undefined && hostUrl.length > 0) {
      targetPhrase = `the running sandbox host at ${hostUrl}`;
    } else {
      targetPhrase = 'the running sandbox host';
    }
  }
  if (identity.isProject) {
    return `Pyric MCP server for project ${identity.projectDir}, targeting ${targetPhrase}.`;
  }
  return `Pyric MCP server for ${identity.projectDir} (warning: no Firebase or Pyric project markers found here; pass --project-dir <dir> or set PYRIC_PROJECT_DIR if you meant another directory), targeting ${targetPhrase}.`;
}

export function buildPyricEnvelope(
  mode: 'sandbox' | 'live',
  project: string,
  target: 'host' | 'in-process',
  identity?: ProjectIdentity,
): PyricEnvelope {
  const envelope: PyricEnvelope = { mode, project, target };
  if (identity !== undefined) {
    envelope.projectDir = identity.projectDir;
    envelope.isProject = identity.isProject;
  }
  return envelope;
}

function headerIncludesPost(raw: string | string[] | null | undefined): boolean {
  if (typeof raw === 'string') return raw.toUpperCase().includes('POST');
  if (Array.isArray(raw)) {
    return raw.some((item) => item.toUpperCase().includes('POST'));
  }
  return false;
}

async function probeNodeHostMode(
  base: string,
  token: string | undefined,
  projectDir: string,
): Promise<'sandbox' | 'live'> {
  const healthUrl = `${base}/__pyric/health`;
  const headers: Record<string, string> = { accept: 'application/json' };
  if (token !== undefined) headers['x-pyric-session-token'] = token;
  try {
    let body: { mode?: unknown; live?: unknown } | null = null;
    if (healthUrl.startsWith('https://')) {
      const response = await fetchLoopbackTarget(
        healthUrl,
        { headers, signal: AbortSignal.timeout(1_000) },
        projectDir,
      );
      if (!response.ok) return 'sandbox';
      body = (await response.json()) as { mode?: unknown; live?: unknown } | null;
    } else {
      const response = await boundedRequest(healthUrl, { headers, deadlineMs: 1_000 });
      if (response === null || response.status !== 200) return 'sandbox';
      body = JSON.parse(response.body.toString('utf8')) as { mode?: unknown; live?: unknown } | null;
    }
    if (body !== null && typeof body === 'object') {
      if (body.mode === 'live') return 'live';
      if (typeof body.live === 'object' && body.live !== null) return 'live';
    }
  } catch {
    // Fall back to sandbox mode if health cannot be parsed.
  }
  return 'sandbox';
}

/**
 * Determine whether a discovered host is a Node host (`hosted` or `live`) that
 * serves `/__pyric/hosted/method`, vs a SharedWorker host (which returns 404).
 *
 * A `GET` to `/__pyric/hosted/method` has zero side effects: Node hosts reply
 * `405 Method Not Allowed` with `allow: POST`, while SharedWorker hosts reply
 * `404`.
 */
export async function probeNodeHost(
  found: Discovered,
  projectDir: string,
): Promise<NodeHostProbe> {
  const base = found.base.replace(/\/$/, '');
  const methodUrl = `${base}/__pyric/hosted/method`;
  const token = resolveSessionTokenForTarget({
    explicitToken: found.token,
    url: found.base,
    cwd: projectDir,
  });
  const headers: Record<string, string> = {};
  if (token !== undefined) headers['x-pyric-session-token'] = token;

  try {
    let status = 0;
    let allowHeader: string | string[] | null | undefined;
    if (methodUrl.startsWith('https://')) {
      const response = await fetchLoopbackTarget(
        methodUrl,
        { method: 'GET', headers, signal: AbortSignal.timeout(1_000) },
        projectDir,
      );
      status = response.status;
      allowHeader = response.headers.get('allow');
    } else {
      const response = await boundedRequest(methodUrl, {
        method: 'GET',
        headers,
        deadlineMs: 1_000,
      });
      if (response !== null) {
        status = response.status;
        allowHeader = response.headers.allow;
      }
    }
    if (status === 405 && headerIncludesPost(allowHeader)) {
      const mode = await probeNodeHostMode(base, token, projectDir);
      return { supportsMethods: true, mode };
    }
  } catch {
    // Treat unreachable or non-conforming probes as non-method hosts.
  }
  return { supportsMethods: false, mode: 'sandbox' };
}
