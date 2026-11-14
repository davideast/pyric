import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AppPorts } from './app-ports.js';
import type { InitPayload } from './init-payload.js';
import {
  getHeader,
  isAllowedHost,
  isAllowedOriginOnPorts,
  isForeignFetchSite,
  isLocalPeer,
  requestSocketScheme,
} from './server.js';

interface NamespaceGuardOptions {
  boundHost?: string;
  allowedHosts?: string[];
  appPorts?: AppPorts;
}

const NO_ALLOWED_HOSTS: string[] = [];

function isAppOrigin(
  req: IncomingMessage,
  originHeader: string,
  opts: NamespaceGuardOptions,
  allowExtraHosts: boolean,
): boolean {
  const boundHost = opts.boundHost ?? 'localhost';
  let extra = NO_ALLOWED_HOSTS;
  if (allowExtraHosts && opts.allowedHosts !== undefined) {
    extra = opts.allowedHosts;
  }
  let ports = opts.appPorts?.forRequest(req);
  if (ports === undefined && req.socket?.localPort !== undefined) {
    ports = [req.socket.localPort];
  }
  return isAllowedOriginOnPorts(originHeader, boundHost, extra, ports, requestSocketScheme(req));
}

/**
 * What a client on another machine reads from init.json: no project data, no
 * capability, and the fields a page needs to say why it has no sandbox.
 * An allowlist, so a field added to the payload stays local until it is named here.
 */
export function remotePeerInitPayload(payload: InitPayload): InitPayload {
  return {
    instanceId: payload.instanceId,
    hosted: payload.hosted,
    remotePeer: true,
    rules: null,
    rulesHash: null,
    storageRules: null,
    storageRulesHash: null,
    bridgeUrl: null,
    seed: null,
  };
}

export function unauthenticatedInitPayload(payload: InitPayload): Record<string, unknown> {
  const out: Record<string, unknown> = {
    rulesHash: payload.rulesHash ?? null,
    databaseRulesHash: payload.databaseRulesHash ?? null,
    storageRulesHash: payload.storageRulesHash ?? null,
  };
  if (payload.instanceId !== undefined) out.instanceId = payload.instanceId;
  if (payload.hosted !== undefined) out.hosted = payload.hosted;
  return out;
}

/**
 * PUBLIC STATIC loopback guard for `GET /__pyric/assets/avatar/<uid>`.
 *
 * Avatar URLs are rendered directly in `<img src>`, which cannot attach a
 * session capability token, and inside opaque-origin `blob:` / `srcdoc` iframes,
 * which browsers mark `Sec-Fetch-Site: cross-site`. This guard still requires a
 * local loopback socket peer, a loopback/bound `Host` (never admitting
 * `--allowed-host` tunnel hostnames), and no foreign `Origin`, while
 * `avatar-route.ts` disables paid/disk `source` callbacks whenever
 * `Sec-Fetch-Site` is `cross-site` or `same-site`.
 */
export function guardAvatarLoopback(
  req: IncomingMessage,
  res: ServerResponse,
  opts: NamespaceGuardOptions,
): boolean {
  if (!isLocalPeer(req)) {
    res.writeHead(403, { 'content-type': 'text/plain' }).end('Forbidden: this route answers clients on this machine only');
    return false;
  }
  const hostHeader = getHeader(req, 'host');
  if (!isAllowedHost(hostHeader, opts.boundHost ?? 'localhost')) {
    res.writeHead(403, { 'content-type': 'text/plain' }).end('Forbidden: host not allowed');
    return false;
  }
  const originHeader = getHeader(req, 'origin');
  if (originHeader && !isAppOrigin(req, originHeader, opts, false)) {
    res.writeHead(403, { 'content-type': 'text/plain' }).end('Forbidden: origin mismatch');
    return false;
  }
  return true;
}

/**
 * Static `/__pyric/sdk/*` bundle guard.
 *
 * Pages opened from loopback or an explicit `--allowed-host` entry load these
 * static JS modules (which hold zero project data, rules, or credentials) so a
 * non-loopback client can run the client SDK and report why project state stays
 * on this machine. Rejects wildcard/unlisted `Host` headers, foreign `Origin`
 * headers, and `cross-site`/`same-site` Fetch Metadata (`Sec-Fetch-Site`), while
 * bootstrapping the session capability cookie strictly on local loopback peers.
 */
export function guardSdkRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: NamespaceGuardOptions,
): boolean {
  const boundHost = opts.boundHost ?? 'localhost';
  const hostHeader = getHeader(req, 'host');
  if (!isAllowedHost(hostHeader, boundHost, opts.allowedHosts)) {
    res.writeHead(403, { 'content-type': 'text/plain' }).end('Forbidden: host not allowed');
    return false;
  }
  const originHeader = getHeader(req, 'origin');
  if (originHeader && !isAppOrigin(req, originHeader, opts, true)) {
    res.writeHead(403, { 'content-type': 'text/plain' }).end('Forbidden: origin mismatch');
    return false;
  }
  let ports = opts.appPorts?.forRequest(req);
  if (ports === undefined && req.socket?.localPort) {
    ports = [req.socket.localPort];
  }
  if (isForeignFetchSite(req, boundHost, ports)) {
    res.writeHead(403, { 'content-type': 'text/plain' }).end('Forbidden: cross-site request rejected');
    return false;
  }
  return true;
}

export function canBootstrapSdkSession(req: IncomingMessage, opts: NamespaceGuardOptions): boolean {
  if (!isLocalPeer(req)) return false;
  const boundHost = opts.boundHost ?? 'localhost';
  if (!isAllowedHost(getHeader(req, 'host'), boundHost)) return false;
  const originHeader = getHeader(req, 'origin');
  if (originHeader && !isAppOrigin(req, originHeader, opts, false)) return false;
  return getHeader(req, 'sec-fetch-site')?.trim().toLowerCase() === 'same-origin';
}

export function guardLoopback(
  req: IncomingMessage,
  res: ServerResponse,
  opts: NamespaceGuardOptions,
  allowExtraHosts = false,
): boolean {
  // First, and whatever the headers say: a client chooses its own headers.
  const isRemotePeer = !isLocalPeer(req);
  if (isRemotePeer) {
    res.writeHead(403, { 'content-type': 'text/plain' }).end('Forbidden: this route answers clients on this machine only');
    return false;
  }
  const hostHeader = getHeader(req, 'host');
  const originHeader = getHeader(req, 'origin');
  const extra = allowExtraHosts ? opts.allowedHosts : undefined;
  if (!isAllowedHost(hostHeader, opts.boundHost ?? 'localhost', extra)) {
    res.writeHead(403, { 'content-type': 'text/plain' }).end('Forbidden: host not allowed');
    return false;
  }
  if (originHeader && !isAppOrigin(req, originHeader, opts, allowExtraHosts)) {
    res.writeHead(403, { 'content-type': 'text/plain' }).end('Forbidden: origin mismatch');
    return false;
  }
  let ports = opts.appPorts?.forRequest(req);
  if (ports === undefined && req.socket?.localPort) {
    ports = [req.socket.localPort];
  }
  if (isForeignFetchSite(req, opts.boundHost ?? 'localhost', ports)) {
    res.writeHead(403, { 'content-type': 'text/plain' }).end('Forbidden: cross-site request rejected');
    return false;
  }
  return true;
}
