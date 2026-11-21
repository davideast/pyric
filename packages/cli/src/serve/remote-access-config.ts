/**
 * Shared resolution, validation, and startup banner helpers for explicit
 * `remoteAccess` configuration across Vite, `pyric.json`, CLI flags, and env vars.
 */
import type { IncomingMessage } from 'node:http';
import {
  effectiveRequestScheme,
  isAdmittedPeer,
  parseAllowPeersSetting,
  parseTrustProxySetting,
  type RemoteAccessOptions,
} from './guard-policy.js';
import {
  getHeader,
  isAllowedHost,
  isAllowedSessionToken,
} from './loopback-guard.js';
import { parseAllowedHostsStrict } from './host-pattern.js';
import {
  parseAllowedHostsInput,
  parseAllowRemotePeersInput,
  parseTrustProxyInput,
} from './remote-access-parse.js';
import { UNLOCK_PATH } from './unlock-route.js';

export type RemoteAccessSetting = boolean | RemoteAccessOptions;

export interface ResolveRemoteAccessInput {
  /** Direct programmatic option (`pyric({ remoteAccess })` or CLI option). */
  option?: RemoteAccessSetting;
  /** Optional legacy `allowedHosts` array (e.g. CLI `--allowed-host`). */
  allowedHosts?: readonly string[];
  /** Optional `pyric.json` `allowedHosts` array. */
  configAllowedHosts?: readonly string[];
  /** Optional `pyric.json` `remoteAccess` block. */
  configRemoteAccess?: RemoteAccessOptions;
  /** Vite `server.allowedHosts`. NOTE: `true` is deliberately ignored on `/__pyric/*`. */
  viteAllowedHosts?: true | readonly string[];
  /** Process environment (`PYRIC_ALLOWED_HOSTS`, `PYRIC_ALLOW_REMOTE_PEERS`, `PYRIC_TRUST_PROXY`). */
  env?: NodeJS.ProcessEnv;
}

function appendUniqueHosts(target: string[], hosts: readonly string[] | undefined): void {
  if (hosts === undefined) return;
  for (const host of hosts) {
    const trimmed = host.trim();
    if (trimmed.length > 0 && !target.includes(trimmed)) {
      target.push(trimmed);
    }
  }
}

/**
 * Resolve normalized `RemoteAccessOptions` (or `undefined` when remote-access
 * mode is off). Validates every configured host entry, peer CIDR, and proxy
 * CIDR fail-closed at startup; ignores Vite `server.allowedHosts: true`.
 */
export function resolveRemoteAccessConfig(
  input: ResolveRemoteAccessInput,
): { allowedHosts: string[]; remoteAccess: RemoteAccessOptions | undefined } {
  const env = input.env ?? {};
  const mergedHosts: string[] = [];

  if (Array.isArray(input.viteAllowedHosts)) {
    appendUniqueHosts(mergedHosts, input.viteAllowedHosts);
  }
  if (input.configAllowedHosts !== undefined && input.configAllowedHosts.length > 0) {
    const parsedConfigHosts = parseAllowedHostsInput(input.configAllowedHosts);
    appendUniqueHosts(mergedHosts, parsedConfigHosts);
  }
  if (input.configRemoteAccess?.allowedHosts !== undefined) {
    const validated = parseAllowedHostsStrict(input.configRemoteAccess.allowedHosts);
    appendUniqueHosts(mergedHosts, validated.map((entry) => entry.raw));
  }
  const envAllowedRaw = env.PYRIC_ALLOWED_HOSTS?.trim();
  if (envAllowedRaw !== undefined && envAllowedRaw.length > 0) {
    appendUniqueHosts(mergedHosts, parseAllowedHostsInput(envAllowedRaw));
  }
  if (input.allowedHosts !== undefined && input.allowedHosts.length > 0) {
    const validated = parseAllowedHostsInput(input.allowedHosts);
    appendUniqueHosts(mergedHosts, validated);
  }

  const opt = input.option;
  if (opt === false) {
    return { allowedHosts: mergedHosts, remoteAccess: undefined };
  }

  const envPeersRaw = env.PYRIC_ALLOW_REMOTE_PEERS?.trim();
  const envTrustRaw = env.PYRIC_TRUST_PROXY?.trim();
  const hasEnvPeers = envPeersRaw !== undefined && envPeersRaw.length > 0;
  const hasEnvTrust = envTrustRaw !== undefined && envTrustRaw.length > 0;
  const hasOptionObject = typeof opt === 'object' && opt !== null;
  const hasExplicitEnable =
    opt === true ||
    hasOptionObject ||
    input.configRemoteAccess !== undefined ||
    hasEnvPeers ||
    hasEnvTrust;

  if (!hasExplicitEnable) {
    return { allowedHosts: mergedHosts, remoteAccess: undefined };
  }

  if (hasOptionObject && opt.allowedHosts !== undefined) {
    const validated = parseAllowedHostsStrict(opt.allowedHosts);
    appendUniqueHosts(mergedHosts, validated.map((entry) => entry.raw));
  }

  let allowPeers: RemoteAccessOptions['allowPeers'] = 'loopback';
  if (input.configRemoteAccess?.allowPeers !== undefined) {
    parseAllowPeersSetting(input.configRemoteAccess.allowPeers);
    allowPeers = input.configRemoteAccess.allowPeers;
  }
  if (hasEnvPeers && envPeersRaw !== undefined) {
    allowPeers = parseAllowRemotePeersInput(envPeersRaw);
  }
  if (hasOptionObject && opt.allowPeers !== undefined) {
    parseAllowPeersSetting(opt.allowPeers);
    allowPeers = opt.allowPeers;
  }

  let trustProxy: RemoteAccessOptions['trustProxy'] = opt === true ? 'loopback' : false;
  if (input.configRemoteAccess?.trustProxy !== undefined) {
    parseTrustProxySetting(input.configRemoteAccess.trustProxy);
    trustProxy = input.configRemoteAccess.trustProxy;
  }
  if (hasEnvTrust && envTrustRaw !== undefined) {
    trustProxy = parseTrustProxyInput(envTrustRaw);
  }
  if (hasOptionObject && opt.trustProxy !== undefined) {
    parseTrustProxySetting(opt.trustProxy);
    trustProxy = opt.trustProxy;
  }

  let browserUnlock = true;
  if (input.configRemoteAccess?.browserUnlock === false) {
    browserUnlock = false;
  }
  if (hasOptionObject && opt.browserUnlock !== undefined) {
    browserUnlock = opt.browserUnlock;
  }

  let allowLiveRemotePeers = false;
  if (input.configRemoteAccess?.allowLiveRemotePeers === true) {
    allowLiveRemotePeers = true;
  }
  if (hasOptionObject && opt.allowLiveRemotePeers !== undefined) {
    allowLiveRemotePeers = opt.allowLiveRemotePeers;
  }

  return {
    allowedHosts: mergedHosts,
    remoteAccess: {
      allowedHosts: mergedHosts,
      allowPeers,
      trustProxy,
      browserUnlock,
      allowLiveRemotePeers,
    },
  };
}

/**
 * True when an incoming HTML document request from a non-loopback peer or
 * allowed remote host already carries a valid per-boot session capability
 * token and passes peer, host, and fetch-site checks. Never true without a
 * valid session token, and rejects cross-site non-navigation fetches.
 */
export function isAuthenticatedRemoteHtmlRequest(
  req: IncomingMessage,
  opts: {
    boundHost: string;
    allowedHosts: readonly string[];
    remoteAccess?: RemoteAccessOptions;
    sessionToken: string | undefined;
  },
): boolean {
  if (opts.remoteAccess === undefined) return false;
  if (opts.sessionToken === undefined || opts.sessionToken.length === 0) return false;
  const allowPeers = parseAllowPeersSetting(opts.remoteAccess.allowPeers);
  if (!isAdmittedPeer(req, { allowPeers })) return false;
  if (!isAllowedHost(req.headers.host, opts.boundHost, opts.allowedHosts)) return false;
  const secFetchSite = getHeader(req, 'sec-fetch-site')?.trim().toLowerCase();
  const secFetchMode = getHeader(req, 'sec-fetch-mode')?.trim().toLowerCase();
  if (
    (secFetchSite === 'cross-site' || secFetchSite === 'same-site') &&
    secFetchMode !== 'navigate'
  ) {
    return false;
  }
  return isAllowedSessionToken(req, undefined, opts.sessionToken);
}

/** Resolve the effective scheme for `appendSetCookieHeader` (`; Secure`). */
export function resolveHtmlCookieScheme(
  req: IncomingMessage,
  remoteAccess?: RemoteAccessOptions,
): 'http:' | 'https:' | undefined {
  const trustProxy = parseTrustProxySetting(remoteAccess?.trustProxy);
  return effectiveRequestScheme(req, trustProxy);
}

/**
 * Format crisp terminal lines announcing the browser unlock route (`#code=`
 * fragment only, never a query string) and any plain-HTTP `Secure Context`
 * caveat for remote origins.
 */
export function formatRemoteAccessStartupLines(input: {
  remoteAccess: RemoteAccessOptions;
  sessionToken: string;
  https: boolean;
  prefix?: string;
}): string[] {
  const prefix = input.prefix ?? '  ';
  const lines: string[] = [];
  if (input.remoteAccess.browserUnlock !== false) {
    lines.push(
      `${prefix}unlock   open ${UNLOCK_PATH}#code=${input.sessionToken} on the allowed remote host to pair a browser`,
    );
  }
  const hasTlsProxy = input.remoteAccess.trustProxy !== undefined && input.remoteAccess.trustProxy !== false;
  if (!input.https && !hasTlsProxy) {
    lines.push(
      `${prefix}warning  plain HTTP on a non-localhost origin carries session cookies in cleartext and disables browser ServiceWorker APIs (messaging/sw, storage/sw); prefer an HTTPS reverse proxy or SSH tunnel.`,
    );
  }
  return lines;
}
