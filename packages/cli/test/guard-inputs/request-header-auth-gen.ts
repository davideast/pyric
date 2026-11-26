/**
 * Cartesian-product generator and ground-truth specification predicates for
 * HTTP/WebSocket request header (`Host` x `Origin` x `Sec-Fetch-Site`) and
 * capability-token combinations across private HTTP Functions and
 * `functions-ephemeral-host`.
 */
import { cartesian3, cartesian4 } from './combinators.js';

type HostKind =
  | 'loopback-ip'
  | 'loopback-localhost'
  | 'evil-host'
  | 'foreign-port'
  | 'wildcard'
  | 'empty';

type OriginKind =
  | 'absent'
  | 'same-origin-ip'
  | 'same-origin-localhost'
  | 'cross-scheme-ip'
  | 'sibling-port'
  | 'foreign'
  | 'empty'
  | 'null-literal';

type SecFetchSiteKind =
  | 'absent'
  | 'same-origin'
  | 'none'
  | 'same-site'
  | 'cross-site';

type AuthTokenKind =
  | 'absent'
  | 'invalid-session'
  | 'valid-session'
  | 'valid-beacon';

interface HostVariant {
  readonly kind: HostKind;
  readonly headerValue: string;
}

interface OriginVariant {
  readonly kind: OriginKind;
  readonly headerValue: string | undefined;
}

interface SecFetchSiteVariant {
  readonly kind: SecFetchSiteKind;
  readonly headerValue: string | undefined;
}

interface AuthTokenVariant {
  readonly kind: AuthTokenKind;
  readonly headerName: 'x-pyric-session-token' | 'x-pyric-beacon-token' | undefined;
  readonly headerValue: string | undefined;
}

interface RequestHeaderVector {
  readonly id: string;
  readonly host: HostVariant;
  readonly origin: OriginVariant;
  readonly secFetchSite: SecFetchSiteVariant;
}

interface RequestHeaderAuthVector extends RequestHeaderVector {
  readonly auth: AuthTokenVariant;
}

function buildHostVariants(port: number): HostVariant[] {
  return [
    { kind: 'loopback-ip', headerValue: `127.0.0.1:${String(port)}` },
    { kind: 'loopback-localhost', headerValue: `localhost:${String(port)}` },
    { kind: 'evil-host', headerValue: 'evil.test' },
    { kind: 'foreign-port', headerValue: `attacker.example:${String(port)}` },
    { kind: 'wildcard', headerValue: `0.0.0.0:${String(port)}` },
    { kind: 'empty', headerValue: '' },
  ];
}

function buildOriginVariants(port: number): OriginVariant[] {
  return [
    { kind: 'absent', headerValue: undefined },
    { kind: 'same-origin-ip', headerValue: `http://127.0.0.1:${String(port)}` },
    { kind: 'same-origin-localhost', headerValue: `http://localhost:${String(port)}` },
    { kind: 'cross-scheme-ip', headerValue: `https://127.0.0.1:${String(port)}` },
    { kind: 'sibling-port', headerValue: `http://127.0.0.1:${String(port + 1)}` },
    { kind: 'foreign', headerValue: 'https://attacker.example' },
    { kind: 'empty', headerValue: '' },
    { kind: 'null-literal', headerValue: 'null' },
  ];
}

const SEC_FETCH_SITE_VARIANTS: readonly SecFetchSiteVariant[] = [
  { kind: 'absent', headerValue: undefined },
  { kind: 'same-origin', headerValue: 'same-origin' },
  { kind: 'none', headerValue: 'none' },
  { kind: 'same-site', headerValue: 'same-site' },
  { kind: 'cross-site', headerValue: 'cross-site' },
];

function buildAuthVariants(sessionToken: string): AuthTokenVariant[] {
  return [
    { kind: 'absent', headerName: undefined, headerValue: undefined },
    {
      kind: 'invalid-session',
      headerName: 'x-pyric-session-token',
      headerValue: 'invalid-token-value',
    },
    { kind: 'valid-session', headerName: 'x-pyric-session-token', headerValue: sessionToken },
    { kind: 'valid-beacon', headerName: 'x-pyric-beacon-token', headerValue: sessionToken },
  ];
}

/**
 * Independent ground-truth specification predicate (`isTrustedSameOriginLoopbackRequest`)
 * for an HTTP listener bound on `127.0.0.1:<port>` (`http:` scheme, no secondary proxy ports):
 *  1. `Host` must be a well-formed loopback authority (`127.0.0.1:<port>` or `localhost:<port>`).
 *  2. `Origin` must be omitted (non-browser caller) or a strictly serialized same-scheme,
 *     same-port loopback origin (`http://127.0.0.1:<port>` or `http://localhost:<port>`).
 *  3. `Sec-Fetch-Site` must NOT mark a foreign browser initiator (`same-site` or `cross-site`).
 */
export function isTrustedSameOriginLoopbackRequest(vector: RequestHeaderVector): boolean {
  const hostTrusted =
    vector.host.kind === 'loopback-ip' || vector.host.kind === 'loopback-localhost';
  const originTrusted =
    vector.origin.kind === 'absent' ||
    vector.origin.kind === 'same-origin-ip' ||
    vector.origin.kind === 'same-origin-localhost';
  const fetchSiteTrusted =
    vector.secFetchSite.kind === 'absent' ||
    vector.secFetchSite.kind === 'same-origin' ||
    vector.secFetchSite.kind === 'none';
  return hostTrusted && originTrusted && fetchSiteTrusted;
}

/**
 * Ground-truth specification predicates for every endpoint of `functions-ephemeral-host`.
 */
export function expectedEphemeralHealthOutcome(vector: RequestHeaderAuthVector): {
  readonly status: 200 | 403;
  readonly exposesProject: boolean;
} {
  if (!isTrustedSameOriginLoopbackRequest(vector)) {
    return { status: 403, exposesProject: false };
  }
  return {
    status: 200,
    exposesProject: vector.auth.kind === 'valid-session',
  };
}

export function expectedEphemeralInitStatus(vector: RequestHeaderAuthVector): 200 | 401 | 403 {
  if (!isTrustedSameOriginLoopbackRequest(vector)) return 403;
  if (vector.auth.kind === 'valid-session') return 200;
  return 401;
}

export function expectedEphemeralBeaconStatus(vector: RequestHeaderAuthVector): 204 | 401 | 403 {
  if (!isTrustedSameOriginLoopbackRequest(vector)) return 403;
  if (vector.origin.kind !== 'absent') return 403;
  if (vector.auth.kind === 'valid-session' || vector.auth.kind === 'valid-beacon') return 204;
  return 401;
}

export function expectedEphemeralWsUpgraded(vector: RequestHeaderAuthVector): boolean {
  return isTrustedSameOriginLoopbackRequest(vector) && vector.auth.kind === 'valid-session';
}

export function toWireHeaders(
  vector: RequestHeaderVector | RequestHeaderAuthVector,
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const headers: Record<string, string> = {
    host: vector.host.headerValue,
    ...extra,
  };
  if (vector.origin.headerValue !== undefined) {
    headers.origin = vector.origin.headerValue;
  }
  if (vector.secFetchSite.headerValue !== undefined) {
    headers['sec-fetch-site'] = vector.secFetchSite.headerValue;
  }
  if (
    'auth' in vector &&
    vector.auth.headerName !== undefined &&
    vector.auth.headerValue !== undefined
  ) {
    headers[vector.auth.headerName] = vector.auth.headerValue;
  }
  return headers;
}

/**
 * Generates the full 240-combination `Host` x `Origin` x `Sec-Fetch-Site`
 * cartesian product for HTTP Functions origin/host guard verification.
 */
export function generateFunctionsHeaderCartesianProduct(port: number): RequestHeaderVector[] {
  return cartesian3(
    buildHostVariants(port),
    buildOriginVariants(port),
    SEC_FETCH_SITE_VARIANTS,
  ).map(([host, origin, secFetchSite]) => ({
    id: `${host.kind}__${origin.kind}__${secFetchSite.kind}`,
    host,
    origin,
    secFetchSite,
  }));
}

/**
 * Generates the cartesian product of `Host` x `Origin` x `Sec-Fetch-Site` x `Auth`
 * for `functions-ephemeral-host` HTTP routes and WebSocket upgrades.
 */
export function generateEphemeralHostCartesianProduct(
  port: number,
  sessionToken: string,
): RequestHeaderAuthVector[] {
  const hosts = buildHostVariants(port).filter((h) =>
    ['loopback-ip', 'evil-host', 'wildcard', 'empty'].includes(h.kind),
  );
  const origins = buildOriginVariants(port).filter((o) =>
    [
      'absent',
      'same-origin-ip',
      'cross-scheme-ip',
      'foreign',
      'empty',
      'null-literal',
    ].includes(o.kind),
  );
  const auths = buildAuthVariants(sessionToken);

  return cartesian4(hosts, origins, SEC_FETCH_SITE_VARIANTS, auths).map(
    ([host, origin, secFetchSite, auth]) => ({
      id: `${host.kind}__${origin.kind}__${secFetchSite.kind}__${auth.kind}`,
      host,
      origin,
      secFetchSite,
      auth,
    }),
  );
}
