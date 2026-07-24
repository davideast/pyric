/**
 * Resolution logic for determining the local Pyric dev server URL.
 */
import type { PyricNextOptions } from './types.js';

const DEFAULT_LOOPBACK_HOST = 'http://127.0.0.1';
const DEFAULT_SANDBOX_PORT = 4000;
const REMOTE_PREFIX = 'remote:';

function stripTrailingSlash(url: string): string {
  if (url.endsWith('/')) {
    return url.slice(0, -1);
  }
  return url;
}

/**
 * Resolve the destination URL for Next.js dev-time rewrites using explicit
 * fallback precedence: option URL → option port → PYRIC_SANDBOX remote URL →
 * PYRIC_SANDBOX_PORT → default port 4000.
 */
export function resolveSandboxTargetUrl(options?: PyricNextOptions): string {
  if (options !== undefined && options.url !== undefined) {
    return stripTrailingSlash(options.url);
  }

  if (options !== undefined && options.port !== undefined) {
    return `${DEFAULT_LOOPBACK_HOST}:${options.port}`;
  }

  const envSandbox = process.env.PYRIC_SANDBOX;
  if (envSandbox !== undefined && envSandbox.startsWith(REMOTE_PREFIX)) {
    const rawRemoteUrl = envSandbox.slice(REMOTE_PREFIX.length);
    return stripTrailingSlash(rawRemoteUrl);
  }

  const envPort = process.env.PYRIC_SANDBOX_PORT;
  if (envPort !== undefined) {
    const parsedPort = Number(envPort);
    if (!Number.isNaN(parsedPort)) {
      return `${DEFAULT_LOOPBACK_HOST}:${parsedPort}`;
    }
  }

  return `${DEFAULT_LOOPBACK_HOST}:${DEFAULT_SANDBOX_PORT}`;
}
