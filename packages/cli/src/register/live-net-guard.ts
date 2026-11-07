/**
 * The network report in a live process: a Node process under
 * `@pyric/live/register`, and the Vite dev server with `pyricLive()`. In live
 * mode pyric observes and never blocks at the network (ADR 0022, amendment
 * 2026-11-07): every request goes out as it would without pyric, so live mode
 * is never riskier than running the same app without it.
 *
 * What it does is say which Google and Firebase calls no live row observed.
 * It installs the register's hooks (`./net-guard.ts`: the undici dispatcher
 * and the socket backstop) with a rule that never refuses, plus its own check
 * on each `http.request`. A call to a Google or Firebase host
 * ({@link liveUnobservedService}) that no row's SDK makes is unobserved: the
 * first one to each host prints one line, and the host joins the list a
 * health report reads ({@link liveUnobservedHosts}).
 *
 * Which calls a row observes is read from the call itself, by host and
 * transport, never from the stack:
 *
 * - a socket or a `fetch` to a host the live rows' SDK reaches
 *   ({@link LIVE_ROW_HOSTS}) or to a Realtime Database host, and, with the
 *   Admin rows on, to Cloud Storage's JSON API, is observed;
 * - an `http.request` is observed only to a host an Admin row's SDK sends
 *   one to, with the Admin rows on: Firestore's REST fallback, Auth, Cloud
 *   Storage and Realtime Database. The client SDK never sends one, so an
 *   `http.request` to any other Google host is unobserved;
 * - every other Google host, a host in `../google-endpoints.ts`, under
 *   `googleapis.com` or a token source, is unobserved: a token exchange,
 *   Vertex AI, Cloud Trace, App Check's public keys, a passed-through
 *   import's own host.
 *
 * The check reads the host, so an app's own raw call to a row's host reads
 * as observed. The calls themselves are the rows' records; this list only
 * names what the rows can't show.
 *
 * Loaded by the live register, so it imports node built-ins and
 * side-effect-free modules only.
 */
import {
  FIREBASE_AI_LOGIC_HOST,
  GOOGLE_ENDPOINT_CATALOG,
  lookupGoogleEndpoint,
  matchesHostSuffix,
  normalizeHostname,
} from '../google-endpoints.js';
import { findTokenSource, tokenEndpointsFrom, type TokenEndpoints } from '../google-token-endpoints.js';
import { contextFrom, installEgressHooks, type EgressHooks, type NetGuardHooks, type ReporterOptions } from './net-guard.js';
import { nodeClientRequestPrototypes } from './connect-prototypes.js';

/** Cloud Storage's host, which the Storage row's SDK reaches. */
const STORAGE_HOST = 'firebasestorage.googleapis.com';

/**
 * The hosts the live rows' SDK reaches in Node: Firestore, Auth, its token
 * refresh, App Check, AI Logic, Cloud Storage, and Installations and FCM
 * registrations, which the Messaging rows' SDK calls.
 */
export const LIVE_ROW_HOSTS: ReadonlySet<string> = new Set([
  'firestore.googleapis.com',
  'identitytoolkit.googleapis.com',
  'securetoken.googleapis.com',
  'content-firebaseappcheck.googleapis.com',
  FIREBASE_AI_LOGIC_HOST,
  STORAGE_HOST,
  'firebaseinstallations.googleapis.com',
  'fcmregistrations.googleapis.com',
]);

/** Cloud Storage's JSON API, which the Admin Storage row's SDK reaches. */
const ADMIN_STORAGE_HOST = 'storage.googleapis.com';

/** FCM's send API, which the Admin Messaging row's SDK reaches over HTTP/2 or an `http.request`. */
const ADMIN_FCM_HOST = 'fcm.googleapis.com';

/**
 * The hosts an Admin row's SDK sends an `http.request` to: Firestore's REST
 * fallback, Auth, Cloud Storage, and FCM sends and Instance ID topic calls.
 */
const ADMIN_REQUEST_HOSTS: ReadonlySet<string> = new Set([
  'firestore.googleapis.com',
  'identitytoolkit.googleapis.com',
  ADMIN_STORAGE_HOST,
  ADMIN_FCM_HOST,
  'iid.googleapis.com',
]);

/** The hosts an Admin row's SDK opens a socket to itself: Cloud Storage, and FCM over HTTP/2. */
const ADMIN_SOCKET_HOSTS: ReadonlySet<string> = new Set([ADMIN_STORAGE_HOST, ADMIN_FCM_HOST]);

/** The catalog's Realtime Database host suffixes: `<name>.firebaseio.com` and `<name>.<region>.firebasedatabase.app`. */
const DATABASE_HOSTS: readonly string[] = GOOGLE_ENDPOINT_CATALOG
  .filter((endpoint) => endpoint.service === 'Realtime Database')
  .map((endpoint) => endpoint.host);

const GOOGLE_APIS = 'googleapis.com';

function isDatabaseHost(host: string): boolean {
  return DATABASE_HOSTS.some((suffix) => matchesHostSuffix(host, suffix));
}

/** How a call left the process: a socket or a `fetch` dispatch, or an `http.request`. */
export type LiveTransport = 'socket' | 'request';

/** Whether a live row observes a call to `host` by `transport`. `adminRows` says the Admin rows are on. */
export function isLiveObservedHost(host: string, transport: LiveTransport, adminRows: boolean): boolean {
  if (transport === 'request') return adminRows && (ADMIN_REQUEST_HOSTS.has(host) || isDatabaseHost(host));
  if (LIVE_ROW_HOSTS.has(host) || isDatabaseHost(host)) return true;
  return adminRows && ADMIN_SOCKET_HOSTS.has(host);
}

/**
 * The service a call to `host` at `path` belongs to when it is a Google or
 * Firebase call no live row observes, or null for an observed one or any
 * other host.
 */
export function liveUnobservedService(
  host: string,
  path: string | undefined,
  transport: LiveTransport,
  options: { adminRows: boolean; endpoints?: TokenEndpoints },
): string | null {
  const endpoints = options.endpoints ?? tokenEndpointsFrom({ env: {} });
  const token = findTokenSource(endpoints, host, path);
  if (token !== undefined) return token.service;
  const service = lookupGoogleEndpoint(host)?.service ?? (matchesHostSuffix(host, GOOGLE_APIS) ? 'Google APIs' : null);
  if (service === null) return null;
  return isLiveObservedHost(host, transport, options.adminRows) ? null : service;
}

/** The process's unobserved hosts, in first-call order, shared by every copy of this module. */
const LEDGER = Symbol.for('pyric.live.unobservedHosts');

function ledger(): string[] {
  const scope = globalThis as unknown as Record<symbol, string[] | undefined>;
  scope[LEDGER] ??= [];
  return scope[LEDGER];
}

/** The Google and Firebase hosts this process called that no live row observed, each once, in first-call order. */
export function liveUnobservedHosts(): readonly string[] {
  return [...ledger()];
}

/** The line for the first unobserved call to `host`. */
export function liveUnobservedLine(prefix: string, host: string, service: string): string {
  return `${prefix}: unobserved call to ${host} (${service}). Live mode lets it through, and no row records it. ` +
    'Later calls to this host are not listed.';
}

/** A host in `normalizeHostname`'s spelling, from a bare host, `host:port`, or a proxy's absolute-form target. */
function hostOf(target: string): string {
  const isUrl = target.includes('://');
  if (isUrl) {
    try {
      return normalizeHostname(new URL(target).hostname);
    } catch {
      return normalizeHostname(target);
    }
  }
  const isBracketed = target.startsWith('[');
  const withoutPort = isBracketed ? target : target.replace(/:\d+$/, '');
  return normalizeHostname(withoutPort);
}

/** The parts of an `http.ClientRequest` the report reads. */
interface RequestLike {
  method?: unknown;
  path?: unknown;
  host?: unknown;
}

/** Matches an absolute-form request target, `http://host/...`. */
const ABSOLUTE_FORM = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * The host and path a request is for: the URL a forward-proxy request names
 * in its path, else the request's own. Null for a `CONNECT`, the tunnel gRPC
 * opens through a proxy, whose socket the socket seams read.
 */
function requestTarget(request: RequestLike): { host: string; path: string | undefined } | null {
  const method = typeof request.method === 'string' ? request.method.toUpperCase() : '';
  if (method === 'CONNECT') return null;
  const path = typeof request.path === 'string' ? request.path : undefined;
  if (path !== undefined && ABSOLUTE_FORM.test(path)) {
    try {
      const url = new URL(path);
      return { host: normalizeHostname(url.hostname), path: `${url.pathname}${url.search}` };
    } catch {
      return null;
    }
  }
  return typeof request.host === 'string' ? { host: hostOf(request.host), path } : null;
}

/** An `onSocket`-bearing object: `http.ClientRequest.prototype` in production, a stand-in under test. */
type RequestPrototype = { onSocket?: unknown };

export interface LiveNetReportOptions extends NetGuardHooks {
  /** Whether the Admin rows are on in this process, so their hosts read as observed. */
  readonly adminRows?: boolean;
  /** What each line starts with. Defaults to `@pyric/live/register`. */
  readonly logPrefix?: string;
  /** Called after each host joins the unobserved list, so the register can send the list to the live host. */
  readonly onUnobserved?: () => void;
}

/** The installed report. */
export interface LiveNetReport extends EgressHooks {
  /** The Google and Firebase hosts this install saw called that no live row observed, in first-call order. */
  unobserved(): readonly string[];
}

/** Installs the live network report in this thread. It never refuses a call. */
export function installLiveNetGuard(options: LiveNetReportOptions = {}): LiveNetReport {
  const endpoints = tokenEndpointsFrom({ env: options.env ?? process.env });
  const adminRows = options.adminRows === true;
  const prefix = options.logPrefix ?? '@pyric/live/register';
  const write = options.write ?? ((line: string) => void process.stderr.write(line));
  const listed: string[] = [];
  const note = (target: string, path: string | undefined, transport: LiveTransport): void => {
    const host = hostOf(target);
    if (listed.includes(host)) return;
    const service = liveUnobservedService(host, path, transport, { adminRows, endpoints });
    if (service === null) return;
    listed.push(host);
    const shared = ledger();
    if (!shared.includes(host)) shared.push(host);
    write(`${liveUnobservedLine(prefix, host, service)}\n`);
    options.onUnobserved?.();
  };
  const reporterOptions: ReporterOptions = {
    mode: 'block',
    endpoints,
    rule: (target, path) => {
      note(target, path, 'socket');
      return null;
    },
    write,
    context: contextFrom(options.argv ?? process.argv),
    reported: new Set(),
  };
  // The request seam is this module's own, so an `http.request` reads by its own transport.
  const installed = installEgressHooks({ ...options, requestPrototypes: [] }, reporterOptions);
  for (const prototype of options.requestPrototypes ?? nodeClientRequestPrototypes()) noteRequests(prototype, note);
  return { ...installed, unobserved: () => [...listed] };
}

/** Notes each `http.request` before its request line is written, and lets it go on as it was. */
function noteRequests(prototype: RequestPrototype, note: (target: string, path: string | undefined, transport: LiveTransport) => void): void {
  const original = prototype.onSocket;
  if (typeof original !== 'function') return;
  prototype.onSocket = function (this: RequestLike, ...args: unknown[]): unknown {
    try {
      const target = requestTarget(this);
      if (target !== null) note(target.host, target.path, 'request');
    } catch {
      // The report never stands between a request and its socket.
    }
    return Reflect.apply(original, this, args);
  };
}
