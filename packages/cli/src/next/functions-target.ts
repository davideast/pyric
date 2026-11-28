/**
 * Resolution and loopback/private-origin guards for Next.js Functions HTTP
 * gateway proxying under `withPyric`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PyricNextFunctionsOptions, PyricNextOptions } from './types.js';
import { resolveSandboxTargetUrl } from './target-url.js';
import { resolveFirebaseProject } from '../cli/firebase-project.js';
import { discoverFunctionsProject } from '../functions/project.js';
import {
  isLoopbackAddress,
  isWildcardIpAddress,
  matchesAnyCidr,
  parseCidr,
  type ParsedCidr,
} from '../serve/peer.js';

const DEFAULT_LOOPBACK_HOST = 'http://127.0.0.1';
const MIN_PORT = 1;
const MAX_PORT = 65535;
const FUNCTIONS_GATEWAY_ENV = 'PYRIC_FUNCTIONS_GATEWAY_URL';
const DEFAULT_DEMO_PROJECT_ID = 'demo-project';

// Excludes link-local ranges (169.254.0.0/16 cloud metadata / IMDS and fe80::/10)
// to prevent SSRF toward host or cloud metadata endpoints.
const PRIVATE_ORIGIN_CIDRS: readonly ParsedCidr[] = [
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '100.64.0.0/10',
  'fc00::/7',
]
  .map((entry) => parseCidr(entry))
  .filter((cidr): cidr is ParsedCidr => cidr !== null);

export interface ResolvedFunctionsGateway {
  /** Normalized loopback or private-network HTTP(S) origin with no trailing slash. */
  readonly targetUrl: string;
  /** Directory used for `firebase.json` and Firebase project resolution. */
  readonly projectDir: string;
  /** Resolved Firebase project ID for emulator-path callable/HTTP routes, or null. */
  readonly projectId: string | null;
  /** Parsed `firebase.json` object when present and valid JSON, else null. */
  readonly firebaseJson: unknown;
  /** Whether `firebase.json` Hosting function rewrites are proxied. */
  readonly includeHostingRewrites: boolean;
}

function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= MIN_PORT && port <= MAX_PORT;
}

function normalizeGatewayOriginInput(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  let httpUrl = trimmed;
  if (trimmed.startsWith('wss://')) {
    httpUrl = `https://${trimmed.slice('wss://'.length)}`;
  } else if (trimmed.startsWith('ws://')) {
    httpUrl = `http://${trimmed.slice('ws://'.length)}`;
  }
  return httpUrl.endsWith('/') ? httpUrl.slice(0, -1) : httpUrl;
}

function unwrapIpv6Host(hostname: string): string {
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    return hostname.slice(1, -1);
  }
  return hostname;
}

function isLoopbackHostname(bareHost: string): boolean {
  if (bareHost === 'localhost' || bareHost.endsWith('.localhost')) {
    return true;
  }
  return isLoopbackAddress(bareHost);
}

/**
 * True when `rawUrl` parses as an HTTP(S) (or WS(S)) origin with no userinfo,
 * path, query, or fragment and names a loopback or RFC1918/ULA/CGNAT
 * private-network host. Wildcard addresses (`0.0.0.0`, `::`), link-local
 * addresses (`169.254.0.0/16`, `fe80::/10`), and public hosts are rejected.
 */
export function isLoopbackOrPrivateOrigin(rawUrl: string): boolean {
  const normalized = normalizeGatewayOriginInput(rawUrl);
  if (normalized.length === 0) return false;
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return false;
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return false;
  }
  if (parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') {
    return false;
  }
  const bareHost = unwrapIpv6Host(parsed.hostname.toLowerCase());
  if (bareHost.length === 0 || isWildcardIpAddress(bareHost)) {
    return false;
  }
  if (isLoopbackHostname(bareHost)) {
    return true;
  }
  return matchesAnyCidr(bareHost, PRIVATE_ORIGIN_CIDRS);
}

/**
 * Validate and normalize an explicit Functions gateway origin, throwing when it
 * is malformed or points outside loopback/private networks.
 */
export function assertLocalFunctionsGatewayOrigin(rawUrl: string, sourceLabel: string): string {
  const normalized = normalizeGatewayOriginInput(rawUrl);
  if (!isLoopbackOrPrivateOrigin(normalized)) {
    throw new Error(
      `[Pyric] ${sourceLabel} must be a loopback or private-network HTTP(S) origin with no credentials or path; received '${rawUrl}'.`,
    );
  }
  return new URL(normalized).origin;
}

function readFirebaseJsonSafe(projectDir: string, warn: (message: string) => void): unknown {
  const file = join(projectDir, 'firebase.json');
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    warn(
      `[Pyric] firebase.json could not be parsed for Functions rewrites: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

function hasDiscoverableFunctions(
  projectDir: string,
  firebaseJson: unknown,
  warn: (message: string) => void,
): boolean {
  if (firebaseJson === null || typeof firebaseJson !== 'object') {
    return false;
  }
  const config = firebaseJson as { functions?: unknown };
  if (config.functions === undefined || config.functions === null) {
    return false;
  }
  try {
    return discoverFunctionsProject(projectDir, { warn }) !== null;
  } catch (error) {
    warn(
      `[Pyric] Skipping Functions gateway rewrites: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

function resolveProjectId(
  fnOptions: PyricNextFunctionsOptions | undefined,
  projectDir: string,
  hasDiscoveredProject: boolean,
): string | null {
  const explicitProjectId = fnOptions?.projectId?.trim();
  if (explicitProjectId !== undefined && explicitProjectId.length > 0) {
    return explicitProjectId;
  }
  try {
    const resolved = resolveFirebaseProject({ projectDir }).projectId;
    if (typeof resolved === 'string' && resolved.length > 0) {
      return resolved;
    }
  } catch {
    // Best-effort project lookup; fall back safely when .firebaserc is unreadable.
  }
  return hasDiscoveredProject ? DEFAULT_DEMO_PROJECT_ID : null;
}

function resolveGatewayTargetUrl(input: {
  options?: PyricNextOptions;
  fnOptions?: PyricNextFunctionsOptions;
  projectDir: string;
  explicitEnabled: boolean;
  envGatewayUrl: string | undefined;
  warn: (message: string) => void;
}): string | null {
  const { options, fnOptions, projectDir, explicitEnabled, envGatewayUrl, warn } = input;
  if (fnOptions?.url !== undefined) {
    return assertLocalFunctionsGatewayOrigin(fnOptions.url, 'options.functions.url');
  }
  if (fnOptions?.port !== undefined) {
    if (!isValidPort(fnOptions.port)) {
      throw new Error(
        `[Pyric] options.functions.port must be an integer from ${MIN_PORT} to ${MAX_PORT}, received ${fnOptions.port}.`,
      );
    }
    return `${DEFAULT_LOOPBACK_HOST}:${fnOptions.port}`;
  }
  if (envGatewayUrl !== undefined && envGatewayUrl.length > 0) {
    return assertLocalFunctionsGatewayOrigin(envGatewayUrl, FUNCTIONS_GATEWAY_ENV);
  }
  const sandboxTarget = resolveSandboxTargetUrl(options, projectDir);
  if (!isLoopbackOrPrivateOrigin(sandboxTarget)) {
    if (explicitEnabled) {
      throw new Error(
        `[Pyric] Functions gateway rewrites only proxy to loopback or private-network origins; refusing '${sandboxTarget}'.`,
      );
    }
    warn(
      `[Pyric] Skipping Functions gateway rewrites because sandbox target '${sandboxTarget}' is not a loopback or private-network origin.`,
    );
    return null;
  }
  return new URL(normalizeGatewayOriginInput(sandboxTarget)).origin;
}

/**
 * Determine whether the local Functions HTTP gateway is active for this Next.js
 * project and resolve its guarded target origin, project ID, and `firebase.json`.
 * Returns `null` as a safe fallback when no Functions gateway is active.
 */
export function resolveFunctionsGateway(
  options?: PyricNextOptions,
  cwd: string = process.cwd(),
  warn: (message: string) => void = (message) => console.warn(message),
): ResolvedFunctionsGateway | null {
  if (options?.rewrites === false || options?.functions === false) {
    return null;
  }

  const fnOptions =
    typeof options?.functions === 'object' && options.functions !== null ? options.functions : undefined;
  const explicitEnabled = options?.functions === true || fnOptions !== undefined;
  const projectDir = fnOptions?.projectDir ?? cwd;
  const rawEnvUrl = process.env[FUNCTIONS_GATEWAY_ENV]?.trim();
  const hasEnvGateway = rawEnvUrl !== undefined && rawEnvUrl.length > 0;

  const firebaseJson = readFirebaseJsonSafe(projectDir, warn);
  const hasDiscoveredProject = hasDiscoverableFunctions(projectDir, firebaseJson, warn);

  if (!explicitEnabled && !hasEnvGateway && !hasDiscoveredProject) {
    return null;
  }

  const targetUrl = resolveGatewayTargetUrl({
    options,
    fnOptions,
    projectDir,
    explicitEnabled,
    envGatewayUrl: rawEnvUrl,
    warn,
  });
  if (targetUrl === null) {
    return null;
  }

  return {
    targetUrl,
    projectDir,
    projectId: resolveProjectId(fnOptions, projectDir, hasDiscoveredProject),
    firebaseJson,
    includeHostingRewrites: fnOptions?.hostingRewrites !== false,
  };
}
