/**
 * The network guard under `@pyric/live/register`. In live mode the app's
 * installed Firestore, Auth, App Check and Realtime Database talk to Google
 * from this process, and nothing else should: pyric holds no production
 * credential, and a Google client library or a hand-written `fetch` to a
 * Google API is traffic pyric neither serves nor observes.
 *
 * It installs the register's hooks (`./net-guard.ts`: the undici dispatcher,
 * the socket backstop and the request check) with this verdict:
 *
 * - a token source (`../google-token-endpoints.ts`) is refused, as the
 *   register's guard refuses it;
 * - a host the Firestore, Auth and App Check rows' SDK reaches
 *   ({@link LIVE_ROW_HOSTS}) passes;
 * - a Realtime Database host ({@link DATABASE_ROW_HOSTS}), which the database
 *   row's SDK reaches, and a host of an import the register passes through
 *   ({@link passThroughHosts}), such as `firebase/functions`'s, pass only
 *   when the nearest caller is a file of the installed SDK the stop let load
 *   ({@link nearestCallerFile}): the database SDK opening its WebSocket
 *   through `faye-websocket`, or an SDK's own `fetch`. The app's own socket,
 *   `fetch` or `WebSocket` to that host is refused, so a database secret the
 *   app holds never goes out unobserved;
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
 * And it refuses every `http.request` and `https.request` to a live row host,
 * a Realtime Database host or a passed-through host
 * ({@link guardLiveRowRequests}). Neither SDK makes
 * one: Auth, App Check, Storage, Functions and AI Logic call `fetch`,
 * Firestore reaches Google over gRPC, on HTTP/2, and Realtime Database over a
 * WebSocket on `tls.connect`. Only a `CONNECT` through a proxy, which gRPC
 * sends to tunnel to its host, passes.
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
import { isBuiltin } from 'node:module';
import { pathToFileURL } from 'node:url';
import {
  FIREBASE_AI_LOGIC_HOST,
  GOOGLE_ENDPOINT_CATALOG,
  lookupGoogleEndpoint,
  matchesHostSuffix,
  normalizeHostname,
} from '../google-endpoints.js';
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
import { INSTALLED_SDK_SPECIFIERS } from '../serve/vite-supplied-rows.js';

/** The hosts the Firestore, Auth and App Check rows' SDK reaches in Node: Firestore, Auth, its token refresh, and App Check. */
export const LIVE_ROW_HOSTS: ReadonlySet<string> = new Set([
  'firestore.googleapis.com',
  'identitytoolkit.googleapis.com',
  'securetoken.googleapis.com',
  'content-firebaseappcheck.googleapis.com',
]);

/**
 * The host suffixes the database row's SDK reaches, the catalog's Realtime
 * Database hosts: the legacy `<name>.firebaseio.com` and the regional
 * `<name>.<region>.firebasedatabase.app`. Unlike {@link LIVE_ROW_HOSTS}, they
 * are always caller-checked: the SDK opens its WebSocket from its own files,
 * and the app's own socket to them is refused.
 */
const DATABASE_ROW_HOSTS: readonly string[] = GOOGLE_ENDPOINT_CATALOG
  .filter((endpoint) => endpoint.service === 'Realtime Database')
  .map((endpoint) => endpoint.host);

const GOOGLE_APIS = 'googleapis.com';

const INSTALLATIONS_HOST = 'firebaseinstallations.googleapis.com';
const MESSAGING_HOSTS = ['fcmregistrations.googleapis.com', INSTALLATIONS_HOST];

/**
 * The Google hosts each import the register can pass through reaches, by
 * host suffix: the service's own and, for the services that need one, the
 * Installations ID. Its calls go to production unobserved, as the app asked.
 */
const PASS_THROUGH_HOSTS: Readonly<Record<string, readonly string[]>> = {
  'firebase/ai': [FIREBASE_AI_LOGIC_HOST],
  'firebase/storage': ['firebasestorage.googleapis.com'],
  'firebase/functions': ['cloudfunctions.net'],
  'firebase/messaging': MESSAGING_HOSTS,
  'firebase/messaging/sw': MESSAGING_HOSTS,
  'firebase/remote-config': ['firebaseremoteconfig.googleapis.com', INSTALLATIONS_HOST],
  'firebase/analytics': [INSTALLATIONS_HOST],
  'firebase/performance': [INSTALLATIONS_HOST],
};

/** The host suffixes the passed-through imports reach, each once. */
export function passThroughHosts(passThrough: Iterable<string>): string[] {
  const hosts = [...passThrough].flatMap((specifier) => PASS_THROUGH_HOSTS[specifier] ?? []);
  return [...new Set(hosts)];
}

/** The live rows that reach Google, one import each: every row but `firebase/app`, which reaches nothing itself. */
const GOOGLE_ROW_IMPORTS = [...INSTALLED_SDK_SPECIFIERS].filter((specifier) => specifier !== 'firebase/app');

/** `a, b and c`, or `a, b or c`. */
function joinedList(items: readonly string[], conjunction: 'and' | 'or'): string {
  if (items.length < 2) return items.join('');
  return `${items.slice(0, -1).join(', ')} ${conjunction} ${items.at(-1)}`;
}

const LOG_PREFIX = '@pyric/live/register: net-guard';
const TOKEN_REASON = "in live mode this process can't get a server-side Google access token";
const LIVE_REASON = `in live mode only @pyric/live's rows, ${joinedList(GOOGLE_ROW_IMPORTS, 'and')}, reach Google from this process`;
const LIVE_REMEDY = 'Make this request from a process without @pyric/live/register';
const LIVE_FETCH_REASON = "in live mode a fetch to Google is made only by the installed SDK that @pyric/live's rows load";
const LIVE_REQUEST_REASON = "in live mode only the installed Firebase SDK, wrapped by @pyric/live's rows, reaches this host, " +
  'and it never sends an http.request, so pyric would not see this one';
const LIVE_REQUEST_REMEDY = `Make the call through ${joinedList(GOOGLE_ROW_IMPORTS, 'or')}, ` +
  'so pyric observes it, or from a process without @pyric/live/register';
const PASSED_REASON = 'in live mode only the installed SDK of an import that passes through reaches this host, ' +
  'from its own files, and pyric does not observe it';
const PASSED_REQUEST_REASON = `${PASSED_REASON}; that SDK never sends an http.request`;
const PASSED_REMEDY = 'Make the call through the Firebase SDK the app imports, or from a process without @pyric/live/register';
const DATABASE_REASON = 'in live mode only the installed Realtime Database SDK, which @pyric/live\'s database row loads, ' +
  'reaches this host, from its own files';
const DATABASE_REQUEST_REASON = `${DATABASE_REASON}; that SDK never sends an http.request`;
const DATABASE_REMEDY = 'Make the call through firebase/database, or from a process without @pyric/live/register';

/** The imports the register passes through, as the guard checks them. */
export interface PassedThrough {
  /** The host suffixes the passed-through imports reach ({@link passThroughHosts}). */
  readonly hosts: readonly string[];
  /** Whether a file URL is one of the installed SDK's files the stop let load. */
  readonly isLiveSdkFile: (url: string) => boolean;
}

const NOTHING_PASSED: PassedThrough = { hosts: [], isLiveSdkFile: () => false };

function isPassedHost(host: string, passed: PassedThrough): boolean {
  return passed.hosts.some((suffix) => matchesHostSuffix(host, suffix));
}

function isDatabaseHost(host: string): boolean {
  return DATABASE_ROW_HOSTS.some((suffix) => matchesHostSuffix(host, suffix));
}

/** The service a Google endpoint belongs to, or null for a host that is not one. */
function googleServiceOf(host: string): string | null {
  const endpoint = lookupGoogleEndpoint(host);
  if (endpoint !== undefined) return endpoint.service;
  return matchesHostSuffix(host, GOOGLE_APIS) ? 'Google APIs' : null;
}

function liveVerdict(host: string, service: string, reason: string): EgressVerdict {
  return { verdict: 'block', permitted: false, host, service, reason, remedy: LIVE_REMEDY };
}

/**
 * Live mode's verdict for a socket or a dispatch: token sources and every
 * Google endpoint but the live rows' hosts, and Realtime Database's hosts
 * and the hosts of the imports the register passes through when the nearest
 * caller is a file the stop let load.
 */
export function liveEgressRule(endpoints = tokenEndpointsFrom({ env: {} }), passed: PassedThrough = NOTHING_PASSED): EgressRule {
  return (hostname, path) => {
    const tokenRefusal = evaluateEgress(hostname, { mode: 'block', endpoints }, path);
    if (tokenRefusal !== null) return { ...tokenRefusal, reason: TOKEN_REASON, remedy: LIVE_REMEDY };
    const host = hostOf(hostname);
    if (LIVE_ROW_HOSTS.has(host)) return null;
    if (isDatabaseHost(host)) {
      const isFromSdk = isLiveSdkCaller(passed.isLiveSdkFile);
      if (isFromSdk) return null;
      return { ...liveVerdict(host, googleServiceOf(host) ?? 'Realtime Database', DATABASE_REASON), remedy: DATABASE_REMEDY };
    }
    if (isPassedHost(host, passed)) {
      const isFromSdk = isLiveSdkCaller(passed.isLiveSdkFile);
      if (isFromSdk) return null;
      return { ...liveVerdict(host, googleServiceOf(host) ?? 'Google APIs', PASSED_REASON), remedy: PASSED_REMEDY };
    }
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

type CallSite = { getFileName(): string | null | undefined; isEval?(): boolean; isNative?(): boolean };

/** What a frame of code made by `eval` or `new Function` reads as: a caller, never a file the stop let load. */
const EVAL_FRAME = 'eval:';

/** What a native frame reads as: one with no script at all, such as `new Promise` or `Array.prototype.map`. */
const NATIVE_FRAME = 'native:';

/** How many frames the caller check reads: past the guard's own, the runtime's and a transport's. */
const STACK_DEPTH = 64;

/** This guard's own files, `net-guard` and `live-net-guard`, built or in the workspace. */
const GUARD_DIR = new URL('./', import.meta.url).href;
const GUARD_FILE = /^(live-)?net-guard\.[jt]s$/;

/**
 * The packages an SDK opens its socket through, below the SDK's own frame:
 * the Realtime Database SDK's WebSocket client (`faye-websocket`, on
 * `websocket-driver`).
 */
const TRANSPORT_PACKAGES = ['/node_modules/faye-websocket/', '/node_modules/websocket-driver/'];

/**
 * A frame of the runtime itself: native, `node:internal/...` (undici's
 * among them) or a built-in module such as `node:net`. Any other frame that
 * is not a file, such as a `vm` script's `evalmachine.<anonymous>` or the
 * name passed as its `filename`, is the app's and stops the walk.
 */
function isRuntimeFrame(file: string): boolean {
  const isInternal = file.startsWith('node:internal/');
  const isBuiltinModule = file.startsWith('node:') && isBuiltin(file);
  return file === NATIVE_FRAME || isInternal || isBuiltinModule;
}

function frameFileOf(site: CallSite): string {
  if (site.isEval?.() === true) return EVAL_FRAME;
  const file = site.getFileName();
  const isNative = site.isNative?.() === true || file === null || file === undefined;
  return isNative ? NATIVE_FRAME : fileUrlOf(file);
}

function isGuardFrame(file: string): boolean {
  return file.startsWith(GUARD_DIR) && GUARD_FILE.test(file.slice(GUARD_DIR.length));
}

function isTransportFrame(file: string): boolean {
  return TRANSPORT_PACKAGES.some((folder) => file.includes(folder));
}

function fileUrlOf(file: string): string {
  const isPath = file.startsWith('/');
  return isPath ? pathToFileURL(file).href : file;
}

/** The files of the current stack, innermost first, as file URLs where they are files. */
function stackFiles(): string[] {
  const previousPrepare = Error.prepareStackTrace;
  const previousLimit = Error.stackTraceLimit;
  const holder: { stack?: unknown } = {};
  try {
    Error.stackTraceLimit = STACK_DEPTH;
    Error.prepareStackTrace = (_error, sites) => sites;
    Error.captureStackTrace(holder);
    const sites = (holder.stack as CallSite[] | undefined) ?? [];
    // Code an app builds with `eval` or `new Function` has no file, but it is the app's: it stops the walk.
    return sites.map(frameFileOf);
  } catch {
    return [];
  } finally {
    Error.prepareStackTrace = previousPrepare;
    Error.stackTraceLimit = previousLimit;
  }
}

/**
 * The file of the nearest caller that is not this guard, the runtime (so
 * not `fetch`, undici or `tls.connect` either) or an SDK's socket transport,
 * as a file URL, or null when the stack names none. For a `fetch` it is the
 * code that called `fetch`; for a socket, the code that asked for it. An app
 * callback the SDK runs is its own nearest caller, so it never borrows the
 * SDK's frame.
 */
export function nearestCallerFile(): string | null {
  for (const file of stackFiles()) {
    const isSkipped = isRuntimeFrame(file) || isGuardFrame(file) || isTransportFrame(file);
    if (!isSkipped) return file;
  }
  return null;
}

/** Whether the nearest caller is a file of the installed SDK the stop let load. */
function isLiveSdkCaller(isLiveSdkFile: (url: string) => boolean): boolean {
  const caller = nearestCallerFile();
  return caller !== null && isLiveSdkFile(caller);
}

type Fetch = typeof fetch;

/** `fetch`, refusing a Google request from any caller but a file of the installed SDK the stop let load. */
function guardedFetch(real: Fetch, isLiveSdkFile: (url: string) => boolean, options: ReporterOptions): Fetch {
  const reporter = createReporter(options);
  const endpoints = options.endpoints ?? tokenEndpointsFrom({ env: {} });
  const rule = options.rule ?? liveEgressRule(endpoints);
  const guarded = function fetch(this: unknown, input: Parameters<Fetch>[0], init?: Parameters<Fetch>[1]): ReturnType<Fetch> {
    const url = fetchUrl(input);
    const isGoogle = url !== null && isGoogleRequest(url, endpoints);
    if (!isGoogle) return Reflect.apply(real, this, [input, init]) as ReturnType<Fetch>;
    const isFromSdk = isLiveSdkCaller(isLiveSdkFile);
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

/**
 * The refusal for an `http.request` to a live row host, a Realtime Database
 * host or a passed-through host, from any caller, or null for any other
 * request.
 */
function liveRowRequestVerdict(request: RequestLike, passed: PassedThrough): EgressVerdict | null {
  const host = requestHost(request);
  if (host === null) return null;
  const service = googleServiceOf(host) ?? 'Google APIs';
  if (LIVE_ROW_HOSTS.has(host)) {
    return { verdict: 'block', permitted: false, host, service, reason: LIVE_REQUEST_REASON, remedy: LIVE_REQUEST_REMEDY };
  }
  if (isDatabaseHost(host)) {
    return { verdict: 'block', permitted: false, host, service, reason: DATABASE_REQUEST_REASON, remedy: DATABASE_REMEDY };
  }
  if (isPassedHost(host, passed)) {
    return { verdict: 'block', permitted: false, host, service, reason: PASSED_REQUEST_REASON, remedy: PASSED_REMEDY };
  }
  return null;
}

type OnSocket = (this: RequestLike, socket: unknown, error?: unknown) => unknown;
type ClientRequestLike = RequestLike & { onSocket: OnSocket };

/** An `addRequest`-bearing object: `http.Agent.prototype` in production, a stand-in under test. */
type AgentPrototype = { addRequest?: unknown };
/** An `onSocket`-bearing object: `http.ClientRequest.prototype` in production, a stand-in under test. */
type RequestPrototype = { onSocket?: unknown };

/**
 * Refuses every `http.request` and `https.request` to a live row host, a
 * Realtime Database host or a passed-through host. The
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
  passed: PassedThrough,
): void {
  for (const prototype of agents) {
    // `https.Agent` inherits `http.Agent`'s `addRequest`: patch it once, where it is defined.
    const isOwn = Object.hasOwn(prototype, 'addRequest');
    const original = prototype.addRequest;
    if (!isOwn || typeof original !== 'function') continue;
    prototype.addRequest = function (this: unknown, request: ClientRequestLike, ...rest: unknown[]): unknown {
      const verdict = liveRowRequestVerdict(request, passed);
      if (verdict === null) return Reflect.apply(original, this, [request, ...rest]);
      return request.onSocket(null, reporter.refuse(verdict, 'socket'));
    };
  }
  for (const prototype of requests) {
    const original = prototype.onSocket;
    if (typeof original !== 'function') continue;
    prototype.onSocket = function (this: RequestLike, socket: unknown, error?: unknown): unknown {
      const hasError = error !== undefined && error !== null;
      const verdict = hasError ? null : liveRowRequestVerdict(this, passed);
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
  /** The imports the register passes through, whose hosts pass ({@link passThroughHosts}). */
  readonly passThrough?: Iterable<string>;
}

/** Installs live mode's guard in this thread. */
export function installLiveNetGuard(options: LiveNetGuardOptions): EgressHooks {
  // The environment can only add token sources (`GCE_METADATA_*`), never let one through.
  const endpoints = tokenEndpointsFrom({ env: options.env ?? process.env });
  const passed: PassedThrough = { hosts: passThroughHosts(options.passThrough ?? []), isLiveSdkFile: options.isLiveSdkFile };
  const reporterOptions: ReporterOptions = {
    mode: 'block',
    endpoints,
    rule: liveEgressRule(endpoints, passed),
    write: options.write ?? ((line: string) => void process.stderr.write(line)),
    context: contextFrom(options.argv ?? process.argv),
    reported: new Set(),
    logPrefix: LOG_PREFIX,
  };
  const installed = installEgressHooks(options, reporterOptions);
  const agents = options.liveAgentPrototypes ?? nodeAgentPrototypes();
  guardLiveRowRequests(createReporter(reporterOptions), agents, options.requestPrototypes ?? nodeClientRequestPrototypes(), passed);
  const fetchScope = options.fetchScope ?? (globalThis as { fetch?: Fetch });
  const real = fetchScope.fetch;
  if (typeof real === 'function') fetchScope.fetch = guardedFetch(real, options.isLiveSdkFile, reporterOptions);
  return installed;
}
