/**
 * Resolution logic for determining the local Pyric dev server URL.
 */
import type { PyricNextOptions } from './types.js';

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

/**
 * Resolve the destination URL for Next.js dev-time rewrites using explicit
 * fallback precedence: option URL → option port → PYRIC_SANDBOX remote URL →
 * PYRIC_SANDBOX_PORT → default port 4000.
 */
export function resolveSandboxTargetUrl(options?: PyricNextOptions): string {
  if (options !== undefined && options.url !== undefined) {
    return normalizeUrl(options.url);
  }

  if (options !== undefined && options.port !== undefined) {
    if (!isValidPort(options.port)) {
      throw new Error(`[Pyric] The port option must be an integer from ${MIN_PORT} to ${MAX_PORT}, received ${options.port}.`);
    }
    return `${DEFAULT_LOOPBACK_HOST}:${options.port}`;
  }

  const envSandbox = process.env.PYRIC_SANDBOX;
  if (envSandbox !== undefined && envSandbox.startsWith(REMOTE_PREFIX)) {
    const rawRemoteUrl = envSandbox.slice(REMOTE_PREFIX.length);
    return normalizeUrl(rawRemoteUrl);
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
