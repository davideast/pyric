/**
 * Two-hop reverse-proxy host and scheme resolution for local app forwarders.
 *
 * Frameworks such as Next.js (`withPyric` dev rewrites) sit between an external
 * HTTPS reverse proxy and the local Pyric host. Because the local app server
 * runs under `@pyric/cli/register`, it marks requests from non-loopback peers
 * with `x-pyric-remote-peer: 1`, rewrites `Host` to `localhost:<pyric-port>`,
 * and forwards the browser's host and scheme in `X-Forwarded-Host` and
 * `X-Forwarded-Proto`.
 *
 * This module keeps single-hop `isTrustedProxyPeer` strict while allowing
 * remote-access-enabled Pyric routes to honor forwarded host and scheme from
 * an immediate loopback/CIDR forwarder once `allowPeers` has admitted the peer,
 * validating the forwarded host strictly against `allowedHosts` and preserving
 * mandatory session capability token enforcement (`isRemoteHost = true`).
 */
import type { IncomingHttpHeaders } from 'node:http';
import { isWildcardHostname, parseHostHeader } from './host-pattern.js';
import { getHeader, isAllowedHost, requestSocketScheme } from './loopback-guard.js';
import {
  isLocalPeer,
  isLoopbackAddress,
  matchesAnyCidr,
  REMOTE_PEER_HEADER,
  type ParsedCidr,
} from './peer.js';

export interface ForwardedRequestLike {
  readonly headers?: IncomingHttpHeaders | Record<string, string | string[] | undefined> | Headers;
  readonly socket?: {
    readonly remoteAddress?: string;
    readonly localPort?: number;
    readonly encrypted?: boolean;
  } | null;
}

export interface ForwardedProxyPolicy {
  readonly boundHost: string;
  readonly allowedHosts: readonly string[];
  readonly allowPeers: 'loopback' | 'any' | readonly ParsedCidr[];
  readonly trustProxy: false | 'loopback' | readonly ParsedCidr[];
  readonly remoteAccessEnabled: boolean;
}

export type ResolvedRequestHostContext =
  | {
      readonly ok: false;
      readonly rejectedHost: string | undefined;
    }
  | {
      readonly ok: true;
      readonly hostHeader: string | undefined;
      readonly forwardedHost: string | undefined;
      readonly effectiveHost: string | undefined;
      readonly effectiveScheme: 'http:' | 'https:' | undefined;
      readonly isLocalHost: boolean;
      readonly isExtraHost: boolean;
      readonly isRemoteHost: boolean;
      readonly trustedProxy: boolean;
    };

function trailingForwardedToken(headerValue: string | undefined): string | undefined {
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

function isLoopbackHostValue(hostHeader: string | undefined): boolean {
  if (hostHeader === undefined) return true;
  const parsed = parseHostHeader(hostHeader);
  if (parsed === null || isWildcardHostname(parsed.hostname)) return false;
  return parsed.hostname === 'localhost' || isLoopbackAddress(parsed.hostname);
}

function socketMatchesTrustProxy(
  remoteAddress: string | undefined,
  trustProxy: ForwardedProxyPolicy['trustProxy'],
): boolean {
  if (trustProxy === false) return false;
  if (trustProxy === 'loopback') {
    return isLoopbackAddress(remoteAddress);
  }
  return matchesAnyCidr(remoteAddress, trustProxy);
}

function peerAdmittedForForwarder(
  req: ForwardedRequestLike,
  allowPeers: ForwardedProxyPolicy['allowPeers'],
): boolean {
  const markedRemote = getHeader(req, REMOTE_PEER_HEADER) !== undefined;
  if (!markedRemote && isLocalPeer({ socket: req.socket ?? undefined })) {
    return true;
  }
  if (allowPeers === 'loopback') return false;
  if (allowPeers === 'any') return true;
  if (markedRemote) return false;
  return matchesAnyCidr(req.socket?.remoteAddress, allowPeers);
}

/**
 * True when the immediate TCP peer is trusted to supply forwarded host/scheme
 * headers: either an unmarked trusted proxy hop, or a loopback/CIDR local app
 * forwarder carrying `x-pyric-remote-peer` whose peer has been explicitly
 * admitted under `remoteAccessEnabled` + `allowPeers`.
 */
export function isTrustedForwardingHop(
  req: ForwardedRequestLike,
  policy: Pick<ForwardedProxyPolicy, 'allowPeers' | 'trustProxy' | 'remoteAccessEnabled'>,
): boolean {
  if (policy.trustProxy === false) return false;
  if (!socketMatchesTrustProxy(req.socket?.remoteAddress, policy.trustProxy)) return false;
  const markedRemote = getHeader(req, REMOTE_PEER_HEADER) !== undefined;
  if (!markedRemote) return true;
  if (!policy.remoteAccessEnabled) return false;
  return peerAdmittedForForwarder(req, policy.allowPeers);
}

/** Resolve effective HTTP scheme (`http:` / `https:`) honoring trusted local forwarders. */
export function resolveForwardedScheme(
  req: ForwardedRequestLike,
  policy: Pick<ForwardedProxyPolicy, 'allowPeers' | 'trustProxy' | 'remoteAccessEnabled'>,
): 'http:' | 'https:' | undefined {
  const socketScheme = requestSocketScheme(req);
  if (socketScheme === 'https:') return 'https:';
  if (isTrustedForwardingHop(req, policy)) {
    const forwardedProto = trailingForwardedToken(getHeader(req, 'x-forwarded-proto'));
    if (forwardedProto === 'https') return 'https:';
    if (forwardedProto === 'http') return 'http:';
  }
  return socketScheme;
}

/** Return the validated trailing `X-Forwarded-Host` from a trusted forwarding hop. */
export function resolveForwardedHost(
  req: ForwardedRequestLike,
  policy: Pick<ForwardedProxyPolicy, 'allowPeers' | 'trustProxy' | 'remoteAccessEnabled'>,
): string | undefined {
  if (!isTrustedForwardingHop(req, policy)) return undefined;
  const token = trailingForwardedToken(getHeader(req, 'x-forwarded-host'));
  if (token === undefined) return undefined;
  const parsed = parseHostHeader(token);
  if (parsed === null || isWildcardHostname(parsed.hostname)) return undefined;
  return token;
}

/**
 * Validate `Host` (and, when a trusted local forwarder rewrote `Host` to
 * loopback, `X-Forwarded-Host`) against `boundHost` and `allowedHosts`.
 * Fails closed if an external `X-Forwarded-Host` is not in `allowedHosts`.
 */
export function resolveRequestHostContext(
  req: ForwardedRequestLike,
  policy: ForwardedProxyPolicy,
): ResolvedRequestHostContext {
  const hostHeader = getHeader(req, 'host');
  const rawLocalHost = isAllowedHost(hostHeader, policy.boundHost, []);
  const rawExtraHost = !rawLocalHost && isAllowedHost(hostHeader, policy.boundHost, policy.allowedHosts);
  if (!rawLocalHost && !rawExtraHost) {
    return { ok: false, rejectedHost: hostHeader };
  }

  const trustedProxy = isTrustedForwardingHop(req, policy);
  const effectiveScheme = resolveForwardedScheme(req, policy);
  const forwardedHost = resolveForwardedHost(req, policy);

  if (rawLocalHost && forwardedHost !== undefined && !isLoopbackHostValue(forwardedHost)) {
    const forwardedAllowed = isAllowedHost(forwardedHost, policy.boundHost, policy.allowedHosts);
    if (!forwardedAllowed) {
      return { ok: false, rejectedHost: forwardedHost };
    }
    const forwardedLocal = isAllowedHost(forwardedHost, policy.boundHost, []);
    return {
      ok: true,
      hostHeader,
      forwardedHost,
      effectiveHost: forwardedHost,
      effectiveScheme,
      isLocalHost: forwardedLocal,
      isExtraHost: !forwardedLocal,
      isRemoteHost: true,
      trustedProxy,
    };
  }

  return {
    ok: true,
    hostHeader,
    forwardedHost,
    effectiveHost: hostHeader,
    effectiveScheme,
    isLocalHost: rawLocalHost,
    isExtraHost: rawExtraHost,
    isRemoteHost: !isLoopbackHostValue(hostHeader),
    trustedProxy,
  };
}

/** True when a local reverse proxy rewrote `Host` while supplying a distinct `X-Forwarded-Host`. */
export function isRewrittenForwarderRequest(req: ForwardedRequestLike): boolean {
  const hostHeader = getHeader(req, 'host')?.trim().toLowerCase();
  const forwardedHost = trailingForwardedToken(getHeader(req, 'x-forwarded-host'));
  if (hostHeader === undefined || forwardedHost === undefined) return false;
  return hostHeader !== forwardedHost;
}
