/**
 * Unified request guard policy for Pyric HTTP routes and WebSocket upgrades.
 *
 * Separates connection topology into two orthogonal axes:
 *   - TCP peer admission (`allowPeers`: `'loopback'` default, IP/CIDR list, or `'any'`),
 *   - HTTP `Host` header admission (`allowedHosts`: exact hosts or strict leading-dot
 *     subdomain suffixes with >= 2 DNS labels; never `*`, `true`, wildcard IPs, or TLDs).
 *
 * Default `localhost` / `127.0.0.1` / `::1` traffic from loopback TCP peers keeps its
 * zero-config behavior. Any request arriving on a non-loopback `Host` OR non-loopback
 * TCP peer MUST present a valid per-boot session capability token (`x-pyric-session-token`
 * header or port-scoped `__pyric_session_<port>` HttpOnly cookie).
 */
import type { IncomingHttpHeaders } from 'node:http';
import {
  isWildcardHostname,
  parseAllowedHostEntry,
  parseAllowedHostsStrict,
  parseHostHeader,
} from './host-pattern.js';
import {
  getHeader,
  isAllowedHost,
  isAllowedOriginOnPorts,
  isAllowedSessionToken,
  isForeignFetchSite,
  presentedSessionTokenKind,
  requestSocketScheme,
} from './loopback-guard.js';
import {
  isLocalPeer,
  isLoopbackAddress,
  matchesAnyCidr,
  parseCidr,
  REMOTE_PEER_HEADER,
  type ParsedCidr,
} from './peer.js';
import {
  isTrustedForwardingHop,
  resolveForwardedHost,
  resolveRequestHostContext,
} from './forwarded-proxy.js';

export { parseAllowedHostEntry, parseAllowedHostsStrict };

/** Public remote-access configuration contract shared by Vite, `pyric.json`, CLI flags, and env vars. */
export interface RemoteAccessOptions {
  /**
   * Explicit non-loopback hostnames or leading-dot subdomain patterns
   * (for example `'devbox.example.com'`, `'.tailnet.ts.net'`, `'devbox.example.com:8443'`).
   * Rejects `true`, `'*'`, wildcard IPs (`0.0.0.0`, `::`, `::ffff:0:0`), embedded wildcards
   * (`*.example.com`), and single-label suffixes (`.`, `.com`, `.dev`, `.local`).
   */
  allowedHosts?: readonly string[];

  /**
   * TCP peer admission rule (independent from `Host` header checking):
   * - `'loopback'` (default): only `127.0.0.0/8` and `::1` TCP peers (reverse proxies / tunnels).
   * - `readonly string[]`: explicit IP/CIDR allowlist (for example `['100.64.0.0/10']`).
   * - `'any'`: any reachable TCP peer presenting an admitted `Host` and valid session token.
   */
  allowPeers?: 'loopback' | 'any' | readonly string[];

  /**
   * Reverse-proxy header trust for `X-Forwarded-Proto` / `X-Forwarded-Host`:
   * - `false` (default): ignore forwarded headers for scheme and port resolution.
   * - `'loopback'`: trust only when the immediate TCP peer is an unmarked loopback socket.
   * - `readonly string[]`: trust only from explicit proxy IP/CIDR addresses.
   */
  trustProxy?: false | 'loopback' | readonly string[];

  /**
   * Mount the `/__pyric/unlock` one-time browser pairing route when `remoteAccess` is active
   * (default `true` when `remoteAccess` is configured, `false` otherwise).
   */
  browserUnlock?: boolean;

  /**
   * Second explicit gate required before `pyric live` routes admit non-loopback TCP peers.
   * Always defaults to `false`.
   */
  allowLiveRemotePeers?: boolean;
}

export type AllowPeersPolicy = 'loopback' | 'any' | readonly ParsedCidr[];
export type TrustProxyPolicy = false | 'loopback' | readonly ParsedCidr[];

export type GuardSurface =
  | 'namespace'
  | 'init'
  | 'sdk'
  | 'avatar'
  | 'unlock'
  | 'bridge-ws'
  | 'bridge-http'
  | 'bridge-storage'
  | 'bridge-live'
  | 'studio-ui'
  | 'studio-api'
  | 'flow'
  | 'activity'
  | 'rest-auth-rtdb'
  | 'html-bootstrap';

export type GuardRejectionReason =
  | 'remote-peer'
  | 'live-remote-peer-refused'
  | 'disallowed-host'
  | 'origin-mismatch'
  | 'scheme-mismatch'
  | 'cross-site-fetch'
  | 'missing-session-token'
  | 'invalid-session-token';

interface GuardAllowedDecision {
  readonly ok: true;
  readonly effectiveScheme: 'http:' | 'https:' | undefined;
  readonly isRemoteHost: boolean;
  readonly isRemotePeer: boolean;
  readonly isRemoteRequest: boolean;
  readonly authenticated: boolean;
}

interface GuardRejectedDecision {
  readonly ok: false;
  readonly status: 401 | 403;
  readonly reason: GuardRejectionReason;
  readonly message: string;
  readonly unlockRequired: boolean;
}

export type GuardDecision = GuardAllowedDecision | GuardRejectedDecision;

export interface GuardRequest {
  readonly method?: string;
  readonly headers?: IncomingHttpHeaders | Record<string, string | string[] | undefined> | Headers;
  readonly socket?: {
    readonly remoteAddress?: string;
    readonly localPort?: number;
    readonly encrypted?: boolean;
  } | null;
}

export interface RequestGuardPolicy {
  readonly boundHost: string;
  readonly boundPort?: number;
  readonly appPorts?: readonly number[];
  readonly allowedHosts: readonly string[];
  readonly allowPeers: AllowPeersPolicy;
  readonly trustProxy: TrustProxyPolicy;
  readonly sessionToken?: string;
  readonly requireSessionToken: boolean;
  readonly browserUnlock: boolean;
  readonly remoteAccessEnabled: boolean;
  readonly allowLiveRemotePeers: boolean;
}

export interface GuardPolicyInput {
  readonly boundHost: string;
  readonly boundPort?: number;
  readonly appPorts?: readonly number[];
  readonly allowedHosts?: readonly string[];
  readonly allowPeers?: 'loopback' | 'any' | readonly string[];
  readonly trustProxy?: false | 'loopback' | readonly string[];
  readonly sessionToken?: string;
  readonly requireSessionToken?: boolean;
  readonly browserUnlock?: boolean;
  readonly remoteAccessEnabled?: boolean;
  readonly allowLiveRemotePeers?: boolean;
  /** When true, throw on invalid `allowedHosts` entries instead of ignoring them. */
  readonly strictAllowedHosts?: boolean;
}

export interface EvaluateGuardOptions {
  readonly url?: URL;
  readonly extraAppPorts?: readonly number[];
}

function sanitizeDiagnosticToken(value: string | undefined): string {
  if (value === undefined) return '<missing>';
  const stripped = value.replace(/[\r\n\t\x00-\x1f\x7f]/g, '').trim();
  if (stripped.length <= 128) return stripped;
  return `${stripped.slice(0, 125)}...`;
}

function parseCidrList(entries: readonly string[], optionName: string): readonly ParsedCidr[] {
  if (entries.length === 0) {
    throw new Error(`pyric: ${optionName} list cannot be empty; omit it or pass 'loopback' / valid IP/CIDR entries.`);
  }
  const parsed: ParsedCidr[] = [];
  for (const raw of entries) {
    const cidr = parseCidr(raw);
    if (cidr === null) {
      throw new Error(
        `pyric: invalid ${optionName} IP/CIDR entry '${sanitizeDiagnosticToken(raw)}'. Wildcards ('0.0.0.0', '::', '/0') are rejected.`,
      );
    }
    parsed.push(cidr);
  }
  return Object.freeze(parsed);
}

/** Parse and validate an `allowPeers` setting into a compiled policy. */
export function parseAllowPeersSetting(
  value: 'loopback' | 'any' | readonly string[] | undefined,
): AllowPeersPolicy {
  if (value === undefined || value === 'loopback') return 'loopback';
  if (value === 'any') return 'any';
  return parseCidrList(value, 'allowPeers');
}

/** Parse and validate a `trustProxy` setting into a compiled policy. */
export function parseTrustProxySetting(
  value: false | 'loopback' | readonly string[] | undefined,
): TrustProxyPolicy {
  if (value === undefined || value === false) return false;
  if (value === 'loopback') return 'loopback';
  return parseCidrList(value, 'trustProxy');
}

/** Compile an immutable `RequestGuardPolicy`. */
export function createGuardPolicy(input: GuardPolicyInput): RequestGuardPolicy {
  const rawHosts = input.allowedHosts ?? [];
  const validHosts: string[] = [];
  if (input.strictAllowedHosts === true) {
    for (const pattern of parseAllowedHostsStrict(rawHosts)) {
      validHosts.push(pattern.raw);
    }
  } else {
    for (const rawEntry of rawHosts) {
      if (typeof rawEntry !== 'string') continue;
      const pattern = parseAllowedHostEntry(rawEntry);
      if (pattern !== null) {
        validHosts.push(pattern.raw);
      }
    }
  }
  const allowPeers = parseAllowPeersSetting(input.allowPeers);
  const trustProxy = parseTrustProxySetting(input.trustProxy);
  const remoteAccessEnabled = input.remoteAccessEnabled === true;
  let browserUnlock = false;
  if (input.browserUnlock !== undefined) {
    browserUnlock = input.browserUnlock;
  } else if (remoteAccessEnabled) {
    browserUnlock = true;
  }
  let appPorts: readonly number[] | undefined;
  if (input.appPorts !== undefined) {
    appPorts = Object.freeze([...input.appPorts]);
  }
  const policy: RequestGuardPolicy = {
    boundHost: input.boundHost,
    boundPort: input.boundPort,
    appPorts,
    allowedHosts: Object.freeze(validHosts),
    allowPeers,
    trustProxy,
    sessionToken: input.sessionToken,
    requireSessionToken: input.requireSessionToken === true,
    browserUnlock,
    remoteAccessEnabled,
    allowLiveRemotePeers: input.allowLiveRemotePeers === true,
  };
  return Object.freeze(policy);
}

function isMarkedRemotePeer(req: GuardRequest): boolean {
  return getHeader(req, REMOTE_PEER_HEADER) !== undefined;
}

/**
 * True only when the immediate TCP socket peer is trusted to supply
 * `X-Forwarded-Proto` / `X-Forwarded-Host` headers. Never trusts requests
 * tagged by an upstream `x-pyric-remote-peer` marker.
 */
export function isTrustedProxyPeer(req: GuardRequest, trustProxy: TrustProxyPolicy): boolean {
  if (trustProxy === false) return false;
  if (isMarkedRemotePeer(req)) return false;
  const remoteAddress = req.socket?.remoteAddress;
  if (trustProxy === 'loopback') {
    return isLoopbackAddress(remoteAddress);
  }
  return matchesAnyCidr(remoteAddress, trustProxy);
}

function lastForwardedToken(headerValue: string | undefined): string | undefined {
  if (headerValue === undefined) return undefined;
  const parts = headerValue.split(',');
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const candidate = parts[index]?.trim().toLowerCase();
    if (candidate !== undefined && candidate.length > 0) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Resolve the effective request scheme (`'http:'` or `'https:'`).
 *
 * When the listener socket itself is TLS-encrypted, returns `'https:'`
 * unconditionally so an upstream proxy cannot downgrade it. When a plain HTTP
 * listener receives a request from a peer matching `trustProxy`, honors the
 * trailing `X-Forwarded-Proto` token written by that trusted hop. Untrusted
 * peers' `X-Forwarded-Proto` headers are always ignored.
 */
export function effectiveRequestScheme(
  req: GuardRequest,
  trustProxy: TrustProxyPolicy = false,
): 'http:' | 'https:' | undefined {
  const socketScheme = requestSocketScheme(req);
  if (socketScheme === 'https:') return 'https:';
  if (isTrustedProxyPeer(req, trustProxy)) {
    const forwardedProto = lastForwardedToken(getHeader(req, 'x-forwarded-proto'));
    if (forwardedProto === 'https') return 'https:';
    if (forwardedProto === 'http') return 'http:';
  }
  return socketScheme;
}

/**
 * Return the trusted hop's `X-Forwarded-Host` header value (or `undefined` when
 * the peer is not trusted by `trustProxy` or the header is absent/malformed).
 */
export function effectiveForwardedHost(
  req: GuardRequest,
  trustProxy: TrustProxyPolicy,
): string | undefined {
  if (!isTrustedProxyPeer(req, trustProxy)) return undefined;
  const token = lastForwardedToken(getHeader(req, 'x-forwarded-host'));
  if (token === undefined) return undefined;
  const parsed = parseHostHeader(token);
  if (parsed === null || isWildcardHostname(parsed.hostname)) return undefined;
  return token;
}

/** True when the `Host` header is absent or names a loopback host (`localhost`, `127.0.0.0/8`, `::1`). */
export function isLoopbackHostHeader(hostHeader: string | undefined): boolean {
  if (hostHeader === undefined) return true;
  const parsed = parseHostHeader(hostHeader);
  if (parsed === null || isWildcardHostname(parsed.hostname)) return false;
  return parsed.hostname === 'localhost' || isLoopbackAddress(parsed.hostname);
}

/** True when a request's TCP peer is admitted by `policy.allowPeers`. */
export function isAdmittedPeer(req: GuardRequest, policy: Pick<RequestGuardPolicy, 'allowPeers'>): boolean {
  const markedRemote = isMarkedRemotePeer(req);
  if (!markedRemote && isLocalPeer({ socket: req.socket ?? undefined })) {
    return true;
  }
  if (policy.allowPeers === 'loopback') return false;
  if (policy.allowPeers === 'any') return true;
  // A proxied request marked remote carries the proxy's loopback socket address,
  // not the verified client IP, so CIDR matching fails closed when marked remote.
  if (markedRemote) return false;
  return matchesAnyCidr(req.socket?.remoteAddress, policy.allowPeers);
}

function isDocumentNavigation(req: GuardRequest): boolean {
  const method = (req.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') return false;
  const secFetchMode = getHeader(req, 'sec-fetch-mode')?.trim().toLowerCase();
  const secFetchDest = getHeader(req, 'sec-fetch-dest')?.trim().toLowerCase();
  return secFetchMode === 'navigate' && secFetchDest === 'document';
}

function collectEffectiveAppPorts(
  req: GuardRequest,
  policy: RequestGuardPolicy,
  extraAppPorts: readonly number[] | undefined,
  extraHosts: readonly string[],
): number[] | undefined {
  const merged: number[] = [];
  const pushUnique = (port: number | undefined): void => {
    if (port === undefined || !Number.isInteger(port) || port <= 0 || port > 65535) return;
    if (!merged.includes(port)) merged.push(port);
  };
  if (policy.appPorts !== undefined) {
    for (const port of policy.appPorts) pushUnique(port);
  } else {
    pushUnique(policy.boundPort);
    pushUnique(req.socket?.localPort);
  }
  if (extraAppPorts !== undefined) {
    for (const port of extraAppPorts) pushUnique(port);
  }
  if (isTrustedForwardingHop(req, policy)) {
    const candidates = [getHeader(req, 'host'), resolveForwardedHost(req, policy)];
    for (const candidate of candidates) {
      if (candidate === undefined) continue;
      if (!isAllowedHost(candidate, policy.boundHost, extraHosts)) continue;
      const parsed = parseHostHeader(candidate);
      if (parsed?.port !== undefined) pushUnique(parsed.port);
    }
  }
  return merged.length > 0 ? merged : undefined;
}

function isOnlySchemeMismatch(
  originHeader: string,
  boundHost: string,
  extra: readonly string[],
  ports: readonly number[] | undefined,
  effectiveScheme: 'http:' | 'https:' | undefined,
): boolean {
  if (effectiveScheme === undefined) return false;
  const otherScheme: 'http:' | 'https:' = effectiveScheme === 'http:' ? 'https:' : 'http:';
  return isAllowedOriginOnPorts(originHeader, boundHost, extra, ports, otherScheme);
}

function disallowedHostMessage(hostHeader: string | undefined, port: number | undefined): string {
  const safeHost = sanitizeDiagnosticToken(hostHeader);
  const displayPort = port ?? 5173;
  return (
    `pyric: refused Host '${safeHost}' (DNS-rebinding guard). ` +
    `Forward the port via SSH ('ssh -L ${displayPort}:localhost:${displayPort} <host>'), ` +
    `or add '${safeHost}' to allowedHosts with remoteAccess enabled. ` +
    `Note: Vite server.allowedHosts: true is ignored for /__pyric/* routes.`
  );
}

function remotePeerMessage(port: number | undefined): string {
  const displayPort = port ?? 5173;
  return (
    `pyric: refused connection from non-loopback peer (local-only guard). ` +
    `Use an SSH tunnel ('ssh -L ${displayPort}:localhost:${displayPort} <host>'), ` +
    `or opt in with remoteAccess.allowPeers / --allow-remote-peers (requires session authentication).`
  );
}

function schemeMismatchMessage(originHeader: string, effectiveScheme: 'http:' | 'https:' | undefined): string {
  const safeOrigin = sanitizeDiagnosticToken(originHeader);
  if (effectiveScheme === 'http:') {
    return (
      `pyric: refused cross-scheme Origin '${safeOrigin}' over plain HTTP listener. ` +
      `If behind a TLS-terminating reverse proxy on this machine, enable trustProxy: 'loopback' (--trust-proxy=loopback).`
    );
  }
  return `pyric: refused downgraded Origin '${safeOrigin}' over HTTPS listener.`;
}

function reject(
  status: 401 | 403,
  reason: GuardRejectionReason,
  message: string,
  unlockRequired = false,
): GuardRejectedDecision {
  return { ok: false, status, reason, message, unlockRequired };
}

/**
 * Evaluate peer, `Host`, `Origin`, `Sec-Fetch-Site`, and session capability token
 * checks against one canonical `RequestGuardPolicy`.
 */
export function evaluateGuard(
  req: GuardRequest,
  policy: RequestGuardPolicy,
  surface: GuardSurface,
  options?: EvaluateGuardOptions,
): GuardDecision {
  const isRemotePeer = isMarkedRemotePeer(req) || !isLoopbackAddress(req.socket?.remoteAddress);
  const displayPort = policy.boundPort ?? req.socket?.localPort;

  if (isRemotePeer && surface !== 'sdk') {
    if (surface === 'bridge-live' && !policy.allowLiveRemotePeers) {
      return reject(
        403,
        'live-remote-peer-refused',
        'pyric: refused non-loopback peer on live route. Pass allowLiveRemotePeers: true (--allow-remote-live) explicitly to admit remote peers in live mode.',
      );
    }
    if (!isAdmittedPeer(req, policy)) {
      return reject(403, 'remote-peer', remotePeerMessage(displayPort));
    }
  }

  const hostCtx = resolveRequestHostContext(req, policy);
  if (!hostCtx.ok) {
    return reject(403, 'disallowed-host', disallowedHostMessage(hostCtx.rejectedHost, displayPort));
  }

  const hostHeader = hostCtx.effectiveHost;
  const isExtraHost = hostCtx.isExtraHost;
  const isRemoteHost = hostCtx.isRemoteHost;
  const isRemoteRequest = isRemotePeer || isRemoteHost;
  const effectiveScheme = hostCtx.effectiveScheme;
  const authenticated =
    policy.sessionToken !== undefined &&
    policy.sessionToken.length > 0 &&
    isAllowedSessionToken(req, options?.url, policy.sessionToken);

  if (surface === 'unlock') {
    if (!policy.remoteAccessEnabled || !policy.browserUnlock) {
      return reject(403, 'disallowed-host', 'pyric: /__pyric/unlock is disabled on this server.');
    }
  } else if (surface !== 'sdk' && surface !== 'studio-api') {
    if (isExtraHost && !policy.remoteAccessEnabled && !policy.requireSessionToken) {
      return reject(403, 'disallowed-host', disallowedHostMessage(hostHeader, displayPort));
    }
    if (isExtraHost && !policy.remoteAccessEnabled && !authenticated) {
      return reject(403, 'disallowed-host', disallowedHostMessage(hostHeader, displayPort));
    }
  }

  const extraHosts = surface === 'sdk' || surface === 'unlock' || isExtraHost ? policy.allowedHosts : [];
  const appPorts = collectEffectiveAppPorts(req, policy, options?.extraAppPorts, policy.allowedHosts);
  const originHeader = getHeader(req, 'origin');
  if (originHeader !== undefined) {
    const allowedOrigin = isAllowedOriginOnPorts(
      originHeader,
      policy.boundHost,
      extraHosts,
      appPorts,
      effectiveScheme,
    );
    if (!allowedOrigin) {
      if (isOnlySchemeMismatch(originHeader, policy.boundHost, extraHosts, appPorts, effectiveScheme)) {
        return reject(403, 'scheme-mismatch', schemeMismatchMessage(originHeader, effectiveScheme));
      }
      return reject(
        403,
        'origin-mismatch',
        `pyric: refused cross-origin request from Origin '${sanitizeDiagnosticToken(originHeader)}'.`,
      );
    }
  }

  const secFetchSite = getHeader(req, 'sec-fetch-site')?.trim().toLowerCase();
  const isCrossOrSameSite = secFetchSite === 'cross-site' || secFetchSite === 'same-site';
  if (isCrossOrSameSite) {
    const navigationPermitted =
      (surface === 'html-bootstrap' || surface === 'studio-ui' || surface === 'unlock') &&
      isDocumentNavigation(req);
    const localAvatarPermitted = surface === 'avatar' && !isRemoteRequest;
    if (!navigationPermitted && !localAvatarPermitted) {
      if (isForeignFetchSite(req, policy.boundHost, appPorts, effectiveScheme, extraHosts)) {
        return reject(
          403,
          'cross-site-fetch',
          `pyric: refused ${secFetchSite} browser request (Sec-Fetch-Site guard).`,
        );
      }
    }
  }

  const requiresTokenForSurface =
    surface === 'bridge-live' ||
    surface === 'studio-api' ||
    isRemoteRequest ||
    (policy.requireSessionToken &&
      surface !== 'avatar' &&
      surface !== 'html-bootstrap' &&
      surface !== 'sdk' &&
      surface !== 'unlock');

  if (surface !== 'sdk' && surface !== 'unlock' && requiresTokenForSurface && !authenticated) {
    const presentedKind = presentedSessionTokenKind(req, options?.url);
    const canBrowserUnlock = isRemoteRequest && policy.remoteAccessEnabled && policy.browserUnlock;
    if (presentedKind === 'header') {
      return reject(
        401,
        'invalid-session-token',
        'pyric: invalid session capability token or cookie.',
        false,
      );
    }
    if (presentedKind === 'cookie') {
      let message = 'pyric: invalid session capability token or cookie.';
      if (canBrowserUnlock) {
        message = 'pyric: session cookie is no longer valid. Open /__pyric/unlock to pair this browser.';
      }
      return reject(401, 'invalid-session-token', message, canBrowserUnlock);
    }
    let message = 'pyric: session token required (x-pyric-session-token header or __pyric_session cookie).';
    if (canBrowserUnlock) {
      message = 'pyric: session unlock required. Open /__pyric/unlock to pair this browser.';
    }
    return reject(401, 'missing-session-token', message, canBrowserUnlock);
  }

  return {
    ok: true,
    effectiveScheme,
    isRemoteHost,
    isRemotePeer,
    isRemoteRequest,
    authenticated,
  };
}
