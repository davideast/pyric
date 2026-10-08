/**
 * Resolution logic for determining the local Pyric dev server URL.
 */
import type { PyricNextOptions } from './types.js';
import { readProjectPointerUrl } from '../serve/discovery.js';

const DEFAULT_LOOPBACK_HOST = 'http://127.0.0.1';
const DEFAULT_SANDBOX_PORT = 4000;
const REMOTE_PREFIX = 'remote:';
const MIN_PORT = 1;
const MAX_PORT = 65535;

function stripTrailingSlash(url: string): string {
  if (url.endsWith('/')) {
    return url.slice(0, -1);
  }
  return url;
}

/**
 * A rewrite destination is fetched over HTTP, so a WebSocket scheme names the
 * same origin under its HTTP counterpart.
 */
function toHttpScheme(url: string): string {
  if (url.startsWith('wss://')) {
    return `https://${url.slice('wss://'.length)}`;
  }
  if (url.startsWith('ws://')) {
    return `http://${url.slice('ws://'.length)}`;
  }
  return url;
}

function normalizeUrl(url: string): string {
  return stripTrailingSlash(toHttpScheme(url));
}

function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= MIN_PORT && port <= MAX_PORT;
}

/** Parse an environment port; an empty, non-integer or out-of-range value is unset. */
function parseEnvPort(raw: string): number | undefined {
  if (raw.trim().length === 0) {
    return undefined;
  }
  const parsed = Number(raw);
  return isValidPort(parsed) ? parsed : undefined;
}

function portOfUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.port !== '') return parsed.port;
    return parsed.protocol === 'https:' ? '443' : '80';
  } catch {
    return null;
  }
}

const reportedStaleUrls = new Set<string>();

/**
 * An explicit `PYRIC_SANDBOX=remote:<url>` on a port other than the one the
 * project's `.pyric/serve.json` records is stale: the host moved, or the url
 * came from another machine. Config resolution is synchronous, so the
 * locator url is taken without a health probe.
 */
function resolveExplicitRemoteUrl(explicitUrl: string, pointerUrl: string | null): string {
  const isStale = pointerUrl !== null && portOfUrl(pointerUrl) !== portOfUrl(explicitUrl);
  if (!isStale) return explicitUrl;
  const hasReported = reportedStaleUrls.has(explicitUrl);
  if (!hasReported) {
    reportedStaleUrls.add(explicitUrl);
    console.warn(
      `[Pyric] PYRIC_SANDBOX=remote:${explicitUrl} is stale: this project's .pyric/serve.json ` +
        `records the running host at ${pointerUrl}, so rewrites target that host. ` +
        "Set PYRIC_SANDBOX=remote to find this project's host through .pyric/serve.json.",
    );
  }
  return pointerUrl;
}

/**
 * Resolve the destination URL for Next.js dev-time rewrites using explicit
 * fallback precedence: option URL → option port → PYRIC_SANDBOX remote URL
 * (bare `remote` reads the project's `.pyric/serve.json`) →
 * PYRIC_SANDBOX_PORT → default port 4000.
 */
export function resolveSandboxTargetUrl(options?: PyricNextOptions, cwd: string = process.cwd()): string {
  if (options !== undefined && options.url !== undefined) {
    return normalizeUrl(options.url);
  }

  if (options !== undefined && options.port !== undefined) {
    if (!isValidPort(options.port)) {
      throw new Error(`[Pyric] The port option must be an integer from ${MIN_PORT} to ${MAX_PORT}, received ${options.port}.`);
    }
    return `${DEFAULT_LOOPBACK_HOST}:${options.port}`;
  }

  const envSandbox = process.env.PYRIC_SANDBOX?.trim();
  if (envSandbox !== undefined && envSandbox.startsWith(REMOTE_PREFIX)) {
    const explicitUrl = normalizeUrl(envSandbox.slice(REMOTE_PREFIX.length));
    return resolveExplicitRemoteUrl(explicitUrl, readProjectPointerUrl(cwd));
  }
  if (envSandbox === 'remote') {
    const pointerUrl = readProjectPointerUrl(cwd);
    if (pointerUrl !== null) return pointerUrl;
  }

  const envPort = process.env.PYRIC_SANDBOX_PORT;
  if (envPort !== undefined) {
    const parsedPort = parseEnvPort(envPort);
    if (parsedPort !== undefined) {
      return `${DEFAULT_LOOPBACK_HOST}:${parsedPort}`;
    }
  }

  return `${DEFAULT_LOOPBACK_HOST}:${DEFAULT_SANDBOX_PORT}`;
}
