import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AppPorts } from './app-ports.js';
import {
  createGuardPolicy,
  effectiveRequestScheme,
  evaluateGuard,
  parseTrustProxySetting,
  type GuardDecision,
  type GuardSurface,
  type RemoteAccessOptions,
  type RequestGuardPolicy,
} from './guard-policy.js';
import type { InitPayload } from './init-payload.js';
import {
  getHeader,
  isAllowedHost,
  isAllowedOriginOnPorts,
  isLocalPeer,
} from './loopback-guard.js';

export interface NamespaceGuardOptions {
  boundHost?: string;
  allowedHosts?: readonly string[];
  appPorts?: AppPorts;
  sessionToken?: string;
  requireSessionToken?: boolean;
  remoteAccess?: RemoteAccessOptions;
  /** True when `remoteAccess` features (`/unlock`, `allowPeers`, `trustProxy`) are active. */
  remoteAccessEnabled?: boolean;
}

/** Merge `NamespaceOptions.allowedHosts` and `remoteAccess.allowedHosts` preserving order. */
export function resolveNamespaceAllowedHosts(opts: NamespaceGuardOptions): readonly string[] {
  const merged: string[] = [];
  for (const host of opts.allowedHosts ?? []) {
    if (!merged.includes(host)) merged.push(host);
  }
  for (const host of opts.remoteAccess?.allowedHosts ?? []) {
    if (!merged.includes(host)) merged.push(host);
  }
  return merged;
}

/** True when remote-access mode is explicitly configured on a namespace handler. */
function isRemoteAccessActive(opts: NamespaceGuardOptions): boolean {
  if (opts.remoteAccessEnabled === true) return true;
  return opts.remoteAccess !== undefined;
}

/** Build a reusable `RequestGuardPolicy` from namespace options. */
function buildNamespaceGuardPolicy(
  opts: NamespaceGuardOptions,
  overrides?: {
    sessionToken?: string;
    requireSessionToken?: boolean;
    allowedHosts?: readonly string[];
    remoteAccessEnabled?: boolean;
  },
): RequestGuardPolicy {
  const remoteAccess = opts.remoteAccess;
  const remoteAccessEnabled = overrides?.remoteAccessEnabled ?? isRemoteAccessActive(opts);
  const allowedHosts = overrides?.allowedHosts ?? resolveNamespaceAllowedHosts(opts);
  return createGuardPolicy({
    boundHost: opts.boundHost ?? 'localhost',
    allowedHosts,
    allowPeers: remoteAccess?.allowPeers,
    trustProxy: remoteAccess?.trustProxy,
    browserUnlock: remoteAccess?.browserUnlock,
    allowLiveRemotePeers: remoteAccess?.allowLiveRemotePeers,
    sessionToken: overrides?.sessionToken ?? opts.sessionToken,
    requireSessionToken: overrides?.requireSessionToken ?? opts.requireSessionToken,
    remoteAccessEnabled,
  });
}

/** Resolve effective HTTP scheme for cookie `; Secure` and proxy checks. */
export function namespaceRequestScheme(
  req: IncomingMessage,
  opts: NamespaceGuardOptions,
): 'http:' | 'https:' | undefined {
  const trustProxy = parseTrustProxySetting(opts.remoteAccess?.trustProxy);
  return effectiveRequestScheme(req, trustProxy);
}

/**
 * Write a structured `401` / `403` response for a rejected `GuardDecision`.
 * When `unlockRequired` is true on JSON routes, responds with the canonical
 * `{ error: 'unlock_required', unlockPath, message }` payload.
 */
export function writeGuardRejection(
  res: ServerResponse,
  decision: Extract<GuardDecision, { ok: false }>,
  options?: { json?: boolean; nextPath?: string },
): void {
  if (options?.json === true) {
    res.writeHead(decision.status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    if (decision.unlockRequired) {
      let unlockPath = '/__pyric/unlock';
      if (options.nextPath !== undefined && options.nextPath.startsWith('/') && !options.nextPath.startsWith('//')) {
        unlockPath = `/__pyric/unlock?next=${encodeURIComponent(options.nextPath)}`;
      }
      res.end(
        JSON.stringify({
          error: 'unlock_required',
          reason: decision.reason,
          unlockPath,
          message: decision.message,
        }),
      );
      return;
    }
    res.end(JSON.stringify({ error: decision.message, reason: decision.reason }));
    return;
  }
  res.writeHead(decision.status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(decision.message);
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

function extraAppPortsForRequest(req: IncomingMessage, opts: NamespaceGuardOptions): readonly number[] | undefined {
  const learned = opts.appPorts?.forRequest(req);
  if (learned !== undefined && learned.length > 0) return learned;
  const localPort = req.socket?.localPort;
  if (localPort !== undefined && localPort > 0) return [localPort];
  return undefined;
}

/**
 * Guard for `GET /__pyric/assets/avatar/<uid>`.
 *
 * Local loopback `<img>` loads (including opaque-origin `blob:` / `srcdoc`
 * iframes) remain tokenless with `sourceAllowed: false` on cross-site/same-site
 * requests. Remote hosts and admitted non-loopback peers are served ONLY when
 * already authenticated via session token or HttpOnly session cookie, and cross-site
 * requests to remote avatars are refused with `403`.
 */
export function guardAvatarLoopback(
  req: IncomingMessage,
  res: ServerResponse,
  opts: NamespaceGuardOptions,
  url?: URL,
): boolean {
  const policy = buildNamespaceGuardPolicy(opts);
  const decision = evaluateGuard(req, policy, 'avatar', {
    url,
    extraAppPorts: extraAppPortsForRequest(req, opts),
  });
  if (!decision.ok) {
    writeGuardRejection(res, decision);
    return false;
  }
  return true;
}

/**
 * Static `/__pyric/sdk/*` bundle guard.
 *
 * Pages opened from loopback or an explicit `allowedHosts` entry load these
 * static JS modules (which hold zero project data, rules, or credentials).
 */
export function guardSdkRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: NamespaceGuardOptions,
): boolean {
  const policy = buildNamespaceGuardPolicy(opts);
  const decision = evaluateGuard(req, policy, 'sdk', {
    extraAppPorts: extraAppPortsForRequest(req, opts),
  });
  if (!decision.ok) {
    writeGuardRejection(res, decision);
    return false;
  }
  return true;
}

export function canBootstrapSdkSession(req: IncomingMessage, opts: NamespaceGuardOptions): boolean {
  if (!isLocalPeer(req)) return false;
  const boundHost = opts.boundHost ?? 'localhost';
  if (!isAllowedHost(getHeader(req, 'host'), boundHost)) return false;
  const originHeader = getHeader(req, 'origin');
  const ports = extraAppPortsForRequest(req, opts);
  const scheme = namespaceRequestScheme(req, opts);
  if (originHeader !== undefined && !isAllowedOriginOnPorts(originHeader, boundHost, [], ports, scheme)) {
    return false;
  }
  return getHeader(req, 'sec-fetch-site')?.trim().toLowerCase() === 'same-origin';
}

export function evaluateNamespaceSurface(
  req: IncomingMessage,
  opts: NamespaceGuardOptions,
  surface: GuardSurface,
  url?: URL,
  requireTokenOverride?: boolean,
): GuardDecision {
  const policy = buildNamespaceGuardPolicy(opts, {
    requireSessionToken: requireTokenOverride ?? opts.requireSessionToken,
  });
  return evaluateGuard(req, policy, surface, {
    url,
    extraAppPorts: extraAppPortsForRequest(req, opts),
  });
}

export function guardLoopback(
  req: IncomingMessage,
  res: ServerResponse,
  opts: NamespaceGuardOptions,
  allowExtraHosts = false,
): boolean {
  const effectiveHosts = allowExtraHosts ? resolveNamespaceAllowedHosts(opts) : [];
  const surface: GuardSurface = allowExtraHosts && opts.sessionToken === undefined ? 'studio-api' : 'namespace';
  const policy = buildNamespaceGuardPolicy(opts, {
    allowedHosts: effectiveHosts,
    requireSessionToken: allowExtraHosts,
    remoteAccessEnabled: isRemoteAccessActive(opts),
  });
  const decision = evaluateGuard(req, policy, surface, {
    extraAppPorts: extraAppPortsForRequest(req, opts),
  });
  if (!decision.ok) {
    if (decision.status === 401 && !isRemoteAccessActive(opts) && opts.sessionToken === undefined) {
      return true;
    }
    writeGuardRejection(res, decision);
    return false;
  }
  return true;
}
