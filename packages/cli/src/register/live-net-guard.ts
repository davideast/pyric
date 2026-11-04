/**
 * The network guard under `@pyric/live/register`. In live mode the app's
 * installed Firestore, Auth and App Check talk to Google from this process,
 * and nothing else should: pyric holds no production credential, and a Google
 * client library or a hand-written `fetch` to a Google API is traffic pyric
 * neither serves nor observes.
 *
 * It installs the register's hooks (`./net-guard.ts`: the undici dispatcher,
 * the socket backstop and the request check) with this verdict:
 *
 * - a token source (`../google-token-endpoints.ts`) is refused, as the
 *   register's guard refuses it;
 * - a host the four live rows' SDK reaches ({@link LIVE_ROW_HOSTS}) passes;
 * - every other Google endpoint, a host in `../google-endpoints.ts` or under
 *   `googleapis.com`, is refused.
 *
 * And it wraps `fetch`, which the Auth and App Check SDKs call: a `fetch` to
 * any Google endpoint, a live row host included, passes only when the code
 * that called it is a file of the installed SDK that the live rows loaded
 * (`isLiveSdkFile`, the stop's record of the files it allowed). So the app's
 * own `fetch` to `firestore.googleapis.com` is refused while Auth's sign-in
 * goes through.
 *
 * And it refuses every `http.request` and `https.request` to a live row host
 * ({@link guardLiveRowRequests}). The rows' SDK never makes one: Auth and App
 * Check call `fetch`, and Firestore reaches Google over gRPC, on HTTP/2. Only
 * a `CONNECT` through a proxy, which gRPC sends to tunnel to its host, passes.
 *
 * Firestore's gRPC sockets open later than the call that asked for them, so
 * the socket seams decide by host, and a gRPC client the app loads itself
 * looks the same there. The stop refuses `@google-cloud/firestore` at import
 * for that reason (`suppliedRowsStopFor` in `./swap-or-stop.ts`).
 *
 * `PYRIC_GUARD` plays no part: live mode's guard is always on.
 *
 * Loaded by the live register, so it imports node built-ins and
 * side-effect-free modules only.
 */
import { pathToFileURL } from 'node:url';
import { lookupGoogleEndpoint, matchesHostSuffix, normalizeHostname } from '../google-endpoints.js';
import { findTokenSource, tokenEndpointsFrom } from '../google-token-endpoints.js';
import {
  contextFrom,
  createReporter,
  evaluateEgress,
  installEgressHooks,
  type EgressHooks,
  type EgressRule,
  type EgressVerdict,
  type NetGuardHooks,
  type ReporterOptions,
} from './net-guard.js';
import { nodeAgentPrototypes, nodeClientRequestPrototypes } from './connect-prototypes.js';

/** The hosts the four live rows' SDK reaches in Node: Firestore, Auth, its token refresh, and App Check. */
export const LIVE_ROW_HOSTS: ReadonlySet<string> = new Set([
  'firestore.googleapis.com',
  'identitytoolkit.googleapis.com',
  'securetoken.googleapis.com',
  'content-firebaseappcheck.googleapis.com',
]);

const GOOGLE_APIS = 'googleapis.com';

const LOG_PREFIX = '@pyric/live/register: net-guard';
const TOKEN_REASON = "in live mode this process can't get a server-side Google access token";
const LIVE_REASON = "in live mode only @pyric/live's rows, Firestore, Auth and App Check, reach Google from this process";
const LIVE_REMEDY = 'Make this request from a process without @pyric/live/register';
const LIVE_FETCH_REASON = "in live mode a fetch to Google is made only by the installed SDK that @pyric/live's rows load";
const LIVE_REQUEST_REASON = "in live mode only the installed Firebase SDK, wrapped by @pyric/live's rows, reaches this host, " +
  'and it never sends an http.request, so pyric would not see this one';
const LIVE_REQUEST_REMEDY = 'Make the call through firebase/firestore, firebase/auth or firebase/app-check, ' +
  'so pyric observes it, or from a process without @pyric/live/register';

/** The service a Google endpoint belongs to, or null for a host that is not one. */
function googleServiceOf(host: string): string | null {
  const endpoint = lookupGoogleEndpoint(host);
  if (endpoint !== undefined) return endpoint.service;
  return matchesHostSuffix(host, GOOGLE_APIS) ? 'Google APIs' : null;
}

function liveVerdict(host: string, service: string, reason: string): EgressVerdict {
  return { verdict: 'block', permitted: false, host, service, reason, remedy: LIVE_REMEDY };
}

/** Live mode's verdict for a socket or a dispatch: token sources and every Google endpoint but the live rows' hosts. */
export function liveEgressRule(endpoints = tokenEndpointsFrom({ env: {} })): EgressRule {
  return (hostname, path) => {
    const tokenRefusal = evaluateEgress(hostname, { mode: 'block', endpoints }, path);
    if (tokenRefusal !== null) return { ...tokenRefusal, reason: TOKEN_REASON, remedy: LIVE_REMEDY };
    const host = hostOf(hostname);
    if (LIVE_ROW_HOSTS.has(host)) return null;
    const service = googleServiceOf(host);
    return service === null ? null : liveVerdict(host, service, LIVE_REASON);
  };
}

/** A host in `normalizeHostname`'s spelling, from a bare host or a proxy's absolute-form target. */
function hostOf(hostname: string): string {
  const isUrl = hostname.includes('://');
  if (!isUrl) return normalizeHostname(hostname);
  try {
    return normalizeHostname(new URL(hostname).hostname);
  } catch {
    return normalizeHostname(hostname);
  }
}

/** The address a `fetch` input names: a string, a URL, or a `Request`'s `url`. */
function fetchHref(input: unknown): string | null {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  const url: unknown = (input as { url?: unknown } | null)?.url;
  return typeof url === 'string' ? url : null;
}

/** The URL a `fetch` call names, or null when it names none this guard can read. */
function fetchUrl(input: unknown): URL | null {
  const href = fetchHref(input);
  if (href === null) return null;
  try {
    return new URL(href);
  } catch {
    return null;
  }
}

/** Whether a fetch to `url` reaches a Google endpoint or a token source. */
function isGoogleRequest(url: URL, endpoints: ReturnType<typeof tokenEndpointsFrom>): boolean {
  const host = normalizeHostname(url.hostname);
  const isTokenSource = findTokenSource(endpoints, host, url.pathname) !== undefined;
  return isTokenSource || LIVE_ROW_HOSTS.has(host) || googleServiceOf(host) !== null;
}

type CallSite = { getFileName(): string | null | undefined };

/**
 * The file of the code that called `fn`, as a file URL, or null when the
 * stack names none. Reads one structured frame and restores the stack
 * settings it borrowed.
 */
function callerFileOf(fn: (...args: never[]) => unknown): string | null {
  const previousPrepare = Error.prepareStackTrace;
  const previousLimit = Error.stackTraceLimit;
  const holder: { stack?: unknown } = {};
  try {
    Error.stackTraceLimit = 1;
    Error.prepareStackTrace = (_error, sites) => sites;
    Error.captureStackTrace(holder, fn);
    const site = (holder.stack as CallSite[] | undefined)?.[0];
    const file = site?.getFileName() ?? null;
    if (file === null) return null;
    return file.startsWith('file:') ? file : pathToFileURL(file).href;
  } catch {
    return null;
  } finally {
    Error.prepareStackTrace = previousPrepare;
    Error.stackTraceLimit = previousLimit;
  }
}

type Fetch = typeof fetch;

/** `fetch`, refusing a Google request from any caller but a file of the live rows' SDK. */
function guardedFetch(real: Fetch, isLiveSdkFile: (url: string) => boolean, options: ReporterOptions): Fetch {
  const reporter = createReporter(options);
  const endpoints = options.endpoints ?? tokenEndpointsFrom({ env: {} });
  const rule = options.rule ?? liveEgressRule(endpoints);
  const guarded = function fetch(this: unknown, input: Parameters<Fetch>[0], init?: Parameters<Fetch>[1]): ReturnType<Fetch> {
    const url = fetchUrl(input);
    const isGoogle = url !== null && isGoogleRequest(url, endpoints);
    if (!isGoogle) return Reflect.apply(real, this, [input, init]) as ReturnType<Fetch>;
    const caller = callerFileOf(guarded);
    const isFromSdk = caller !== null && isLiveSdkFile(caller);
    const host = normalizeHostname(url.hostname);
    const refusedCaller = isFromSdk ? null : liveVerdict(host, googleServiceOf(host) ?? 'Google APIs', LIVE_FETCH_REASON);
    const verdict = rule(host, url.pathname) ?? refusedCaller;
    if (verdict === null) return Reflect.apply(real, this, [input, init]) as ReturnType<Fetch>;
    // A refused fetch rejects as undici's does: `TypeError: fetch failed`, with the guard's error as its cause.
    return Promise.reject(new TypeError('fetch failed', { cause: reporter.refuse(verdict, 'fetch') }));
  };
  return Object.assign(guarded, { preconnect: real.preconnect }) as Fetch;
}

/** The parts of an `http.ClientRequest` this guard reads. */
interface RequestLike {
  method?: unknown;
  path?: unknown;
  host?: unknown;
}

/** Matches an absolute-form request target, `http://host/...`. */
const ABSOLUTE_FORM = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * The host a request is for: the URL a forward-proxy request names in its
 * path, else the request's own host. Null for a `CONNECT`, the tunnel gRPC
 * opens through a proxy, which the request check in `./net-guard.ts` decides
 * by its target alone.
 */
function requestHost(request: RequestLike): string | null {
  const method = typeof request.method === 'string' ? request.method.toUpperCase() : '';
  if (method === 'CONNECT') return null;
  const path = typeof request.path === 'string' ? request.path : '';
  if (ABSOLUTE_FORM.test(path)) return hostOf(path);
  return typeof request.host === 'string' ? hostOf(request.host) : null;
}

/** The refusal for an `http.request` to a live row host, or null for any other request. */
function liveRowRequestVerdict(request: RequestLike): EgressVerdict | null {
  const host = requestHost(request);
  const isLiveRowHost = host !== null && LIVE_ROW_HOSTS.has(host);
  if (!isLiveRowHost) return null;
  const service = googleServiceOf(host) ?? 'Google APIs';
  return { verdict: 'block', permitted: false, host, service, reason: LIVE_REQUEST_REASON, remedy: LIVE_REQUEST_REMEDY };
}

type OnSocket = (this: RequestLike, socket: unknown, error?: unknown) => unknown;
type ClientRequestLike = RequestLike & { onSocket: OnSocket };

/** An `addRequest`-bearing object: `http.Agent.prototype` in production, a stand-in under test. */
type AgentPrototype = { addRequest?: unknown };
/** An `onSocket`-bearing object: `http.ClientRequest.prototype` in production, a stand-in under test. */
type RequestPrototype = { onSocket?: unknown };

/**
 * Refuses every `http.request` and `https.request` to a live row host. The
 * Agent's `addRequest` is checked first, so a request through an Agent fails
 * before any socket opens; `onSocket` catches the rest, a request with its
 * own `createConnection`, before its request line is written. The refusal
 * reaches the request as its socket error, as the request check in
 * `./net-guard.ts` fails one: the request emits `error` with the guard's error.
 */
function guardLiveRowRequests(
  reporter: ReturnType<typeof createReporter>,
  agents: readonly AgentPrototype[],
  requests: readonly RequestPrototype[],
): void {
  for (const prototype of agents) {
    // `https.Agent` inherits `http.Agent`'s `addRequest`: patch it once, where it is defined.
    const isOwn = Object.hasOwn(prototype, 'addRequest');
    const original = prototype.addRequest;
    if (!isOwn || typeof original !== 'function') continue;
    prototype.addRequest = function (this: unknown, request: ClientRequestLike, ...rest: unknown[]): unknown {
      const verdict = liveRowRequestVerdict(request);
      if (verdict === null) return Reflect.apply(original, this, [request, ...rest]);
      return request.onSocket(null, reporter.refuse(verdict, 'socket'));
    };
  }
  for (const prototype of requests) {
    const original = prototype.onSocket;
    if (typeof original !== 'function') continue;
    prototype.onSocket = function (this: RequestLike, socket: unknown, error?: unknown): unknown {
      const hasError = error !== undefined && error !== null;
      const verdict = hasError ? null : liveRowRequestVerdict(this);
      const refusal = verdict === null ? error : reporter.refuse(verdict, 'socket');
      return Reflect.apply(original, this, [socket, refusal]);
    };
  }
}

export interface LiveNetGuardOptions extends NetGuardHooks {
  /** Whether a file URL is one of the installed SDK's files the live rows loaded. */
  readonly isLiveSdkFile: (url: string) => boolean;
  /** Holds `fetch`. Defaults to `globalThis`. */
  readonly fetchScope?: { fetch?: Fetch };
  /** Prototypes whose `addRequest` is checked. Defaults to the `http.Agent` and `https.Agent` prototypes. */
  readonly liveAgentPrototypes?: readonly AgentPrototype[];
}

/** Installs live mode's guard in this thread. */
export function installLiveNetGuard(options: LiveNetGuardOptions): EgressHooks {
  // The environment can only add token sources (`GCE_METADATA_*`), never let one through.
  const endpoints = tokenEndpointsFrom({ env: options.env ?? process.env });
  const reporterOptions: ReporterOptions = {
    mode: 'block',
    endpoints,
    rule: liveEgressRule(endpoints),
    write: options.write ?? ((line: string) => void process.stderr.write(line)),
    context: contextFrom(options.argv ?? process.argv),
    reported: new Set(),
    logPrefix: LOG_PREFIX,
  };
  const installed = installEgressHooks(options, reporterOptions);
  const agents = options.liveAgentPrototypes ?? nodeAgentPrototypes();
  guardLiveRowRequests(createReporter(reporterOptions), agents, options.requestPrototypes ?? nodeClientRequestPrototypes());
  const fetchScope = options.fetchScope ?? (globalThis as { fetch?: Fetch });
  const real = fetchScope.fetch;
  if (typeof real === 'function') fetchScope.fetch = guardedFetch(real, options.isLiveSdkFile, reporterOptions);
  return installed;
}
