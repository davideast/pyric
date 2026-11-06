/**
 * The network guard under `@pyric/live/register`. In live mode the app's
 * installed Firestore, Auth, App Check, Realtime Database, AI Logic, Cloud
 * Storage and Cloud Messaging talk to Google from this process, and nothing
 * else should: pyric holds no production credential, and a Google client
 * library or a hand-written `fetch` to a Google API is traffic pyric neither
 * serves nor observes.
 *
 * It installs the register's hooks (`./net-guard.ts`: the undici dispatcher,
 * the socket backstop and the request check) with this verdict:
 *
 * - a token source (`../google-token-endpoints.ts`) is refused, as the
 *   register's guard refuses it;
 * - a host the Firestore, Auth, App Check, AI Logic, Cloud Storage and Cloud
 *   Messaging SDKs reach ({@link LIVE_ROW_HOSTS}) passes. Messaging's are
 *   Installations (`firebaseinstallations.googleapis.com`) and FCM
 *   registrations (`fcmregistrations.googleapis.com`); Remote Config,
 *   Analytics and Performance, which pass through, reach Installations too,
 *   so it passes for them as a live row host;
 * - a Realtime Database host ({@link DATABASE_ROW_HOSTS}), which the database
 *   row's SDK reaches, and a host of an import the register passes through
 *   ({@link passThroughHosts}), such as `firebase/functions`'s, pass only
 *   when the nearest caller is a file of the installed SDK the stop let load
 *   ({@link nearestCallerFile}): the database SDK opening its WebSocket
 *   through `faye-websocket`, or an SDK's own `fetch`. The app's own socket,
 *   `fetch` or `WebSocket` to that host is refused, so a database secret the
 *   app holds never goes out unobserved;
 * - when `firebase-admin` passes through, the hosts the Admin SDK needs
 *   besides the live row hosts ({@link ADMIN_TOKEN_HOSTS},
 *   {@link ADMIN_HOSTS}) pass only when the nearest caller is a file of the
 *   Admin SDK's tree ({@link PassedThrough.isAdminSdkFile}): the files the
 *   app's own `firebase-admin` import reached, directly or not,
 *   `google-auth-library` and `@google-cloud/firestore` among them. They are
 *   its token sources (OAuth 2.0, IAM credentials and the metadata server),
 *   Cloud Storage's JSON API and the public keys it verifies ID tokens with.
 *   The Admin SDK holds the app's own credential, so it fetches its token,
 *   and its calls go to production unobserved and bypass security rules. The
 *   app's own call to the same hosts is still refused, and so is a tree
 *   file's call to any other Google host. Firestore's gRPC sockets pass by
 *   host, as the live rows' do;
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
 * ({@link guardLiveRowRequests}). No SDK makes one: Auth, App Check,
 * Storage, Functions, AI Logic, Installations and Messaging call `fetch`,
 * Firestore reaches Google over gRPC, on HTTP/2, and Realtime Database over
 * a WebSocket on `tls.connect`. Only a `CONNECT` through a proxy, which gRPC sends to
 * tunnel to its host, passes.
 *
 * The socket seams pass a live row host from any caller, so a `WebSocket`
 * to one is not backstopped here. The one an SDK opens is the AI Live API's
 * (`wss://firebasevertexai.googleapis.com/...`, from `@firebase/ai`), and
 * `@pyric/live` refuses the Live API at its factory,
 * `getLiveGenerativeModel`, and at its classes, `new LiveGenerativeModel` and
 * `new LiveSession`, before that socket opens. The same holds for
 * Installations and FCM registrations: an app's own raw socket to either
 * passes the socket seams, while the `fetch` wrapper and the request check
 * refuse the app's own `fetch` and `http.request` to them.
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
import { AsyncLocalStorage } from 'node:async_hooks';
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
import { ADMIN_PASS_THROUGH, INSTALLED_SDK_SPECIFIERS } from '../serve/vite-supplied-rows.js';
import { joinedList } from './word-list.js';

/** Cloud Storage's host, which the Storage row's SDK reaches. */
const STORAGE_HOST = 'firebasestorage.googleapis.com';

/** The Installations host, which the Messaging SDK and the passed-through Remote Config, Analytics and Performance reach. */
const INSTALLATIONS_HOST = 'firebaseinstallations.googleapis.com';

/**
 * The hosts the Messaging rows' SDK reaches with `fetch`: Installations,
 * for the installation its token belongs to, and FCM registrations, which
 * issues and deletes the token.
 */
const MESSAGING_HOSTS: ReadonlySet<string> = new Set([INSTALLATIONS_HOST, 'fcmregistrations.googleapis.com']);

/**
 * The hosts the live rows' SDK reaches in Node by host: Firestore, Auth, its
 * token refresh, App Check, AI Logic, which the AI row's `firebase/ai` calls
 * with `fetch`, Cloud Storage, which the Storage row's `firebase/storage`
 * calls with `fetch`, and Installations and FCM registrations, which the
 * Messaging rows' `firebase/messaging` and `firebase/messaging/sw` call with
 * `fetch`.
 */
export const LIVE_ROW_HOSTS: ReadonlySet<string> = new Set([
  'firestore.googleapis.com',
  'identitytoolkit.googleapis.com',
  'securetoken.googleapis.com',
  'content-firebaseappcheck.googleapis.com',
  FIREBASE_AI_LOGIC_HOST,
  STORAGE_HOST,
  ...MESSAGING_HOSTS,
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

/**
 * The Google hosts each import the register can pass through reaches, by
 * host suffix, besides the live row hosts: the service's own. Its calls go
 * to production unobserved, as the app asked. The Installations host that
 * Remote Config, Analytics and Performance also reach is a live row host
 * (the Messaging SDK's), so it is not listed here.
 */
const PASS_THROUGH_HOSTS: Readonly<Record<string, readonly string[]>> = {
  'firebase/functions': ['cloudfunctions.net'],
  'firebase/remote-config': ['firebaseremoteconfig.googleapis.com'],
};

/** The host suffixes the passed-through imports reach, each once. */
export function passThroughHosts(passThrough: Iterable<string>): string[] {
  const hosts = [...passThrough].flatMap((specifier) => PASS_THROUGH_HOSTS[specifier] ?? []);
  return [...new Set(hosts)];
}

/** The live rows that reach Google, one import each: every row but `firebase/app`, which reaches nothing itself. */
const GOOGLE_ROW_IMPORTS = [...INSTALLED_SDK_SPECIFIERS].filter((specifier) => specifier !== 'firebase/app');

const LOG_PREFIX = '@pyric/live/register: net-guard';
const TOKEN_REASON = "in live mode this process can't get a server-side Google access token";
const LIVE_REASON = `in live mode only the imports @pyric/live serves (${joinedList(GOOGLE_ROW_IMPORTS, 'and')}) reach Google from this process`;
const LIVE_REMEDY = 'Make this request from a process without @pyric/live/register';
const LIVE_FETCH_REASON = "in live mode a fetch to Google is made only by the installed SDK that @pyric/live's rows load";
const LIVE_REQUEST_REASON = "in live mode only the installed Firebase SDK, wrapped by @pyric/live's rows, reaches this host, " +
  'and it never sends an http.request, so pyric would not see this one';
/** For a request to a Firestore, Auth or App Check host, which only these three imports' SDKs reach. */
const LIVE_REQUEST_REMEDY = 'Make the call through firebase/auth, firebase/firestore or firebase/app-check, ' +
  'so pyric observes it, or from a process without @pyric/live/register';
const AI_REQUEST_REASON = 'in live mode only the installed AI Logic SDK, firebase/ai, reaches this host, ' +
  'and it calls fetch, never http.request; its one other path is the Live API WebSocket, ' +
  'which @pyric/live refuses at the factory and at new LiveGenerativeModel and new LiveSession';
/** For a request to the AI Logic host, which only `firebase/ai`'s SDK reaches. */
const AI_REQUEST_REMEDY = 'Make the call through firebase/ai, or from a process without @pyric/live/register';
const STORAGE_REQUEST_REASON = 'in live mode only the installed Cloud Storage SDK, firebase/storage, reaches this host, ' +
  'and it calls fetch, never http.request';
/** For a request to the Cloud Storage host, which only `firebase/storage`'s SDK reaches. */
const STORAGE_REQUEST_REMEDY = 'Make the call through firebase/storage, or from a process without @pyric/live/register';
const MESSAGING_REQUEST_REASON = 'in live mode only the installed Firebase SDK reaches this host: Cloud Messaging, ' +
  'and for Installations also the Remote Config, Analytics and Performance SDKs; each calls fetch, never http.request';
/** For a request to the Installations or FCM registrations host. */
const MESSAGING_REQUEST_REMEDY = 'Make the call through firebase/messaging, or the Firebase SDK the app imports, ' +
  'or from a process without @pyric/live/register';
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
  /**
   * Whether a file URL is one of the passed-through Admin SDK's files; absent
   * unless `firebase-admin` passes through.
   */
  readonly isAdminSdkFile?: (url: string) => boolean;
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
 * The token sources a file of the passed-through Admin SDK's tree may reach:
 * the OAuth 2.0 token endpoint, IAM credentials, which signs custom tokens
 * without a private key, and the metadata server, by every spelling the
 * token list refuses it under. Every other token source stays refused.
 */
const ADMIN_TOKEN_HOSTS: ReadonlySet<string> = new Set([
  'oauth2.googleapis.com',
  'iamcredentials.googleapis.com',
  '169.254.169.254',
  'metadata.google.internal',
  'metadata',
  'fd20:ce::254',
]);

const METADATA_SERVER = 'GCE metadata server';

/** The host whose public-key paths the Admin SDK reads to verify ID tokens and session cookies. */
const ADMIN_KEYS_HOST = 'www.googleapis.com';
const ADMIN_KEYS_PATH = '/robot/v1/metadata/x509/';

/** Cloud Storage's JSON API, which `firebase-admin/storage` reaches through `@google-cloud/storage`. */
const ADMIN_STORAGE_HOST = 'storage.googleapis.com';

/** The Google hosts besides the live row hosts and token sources that a file of the Admin SDK's tree may reach. */
const ADMIN_HOSTS: ReadonlySet<string> = new Set([ADMIN_STORAGE_HOST, ADMIN_KEYS_HOST]);

/** Whether a refused token source is one the Admin SDK's tree may reach. */
function isAdminTokenSource(verdict: EgressVerdict): boolean {
  return ADMIN_TOKEN_HOSTS.has(verdict.host) || verdict.service === METADATA_SERVER;
}

/**
 * Whether the Admin SDK's tree may reach `host` at `path`: Cloud Storage, or
 * a public-key path on `www.googleapis.com`. A socket names no path, so it
 * passes there by host; the dispatch and request seams, which see the path,
 * hold `www.googleapis.com` to its key paths.
 */
function isAdminHost(host: string, path: string | undefined): boolean {
  if (!ADMIN_HOSTS.has(host)) return false;
  const isKeysHost = host === ADMIN_KEYS_HOST;
  const isKeysPath = path === undefined || path.startsWith(ADMIN_KEYS_PATH);
  return !isKeysHost || isKeysPath;
}

/**
 * The `fetch` calls a file of the Admin SDK's tree made, as they run.
 * undici dispatches and connects after `fetch` returns, so those seams no
 * longer see the Admin SDK's frame on the stack; they read this instead. A
 * `fetch` the app makes never runs in it, since the wrapper decides by the
 * caller before it starts one.
 */
const adminFetches = new AsyncLocalStorage<true>();

/**
 * Whether `firebase-admin` passes through and this is its call: the nearest
 * caller is a file of its tree, or a `fetch` such a file made is running.
 */
function isAdminCaller(passed: PassedThrough): boolean {
  const isAdminSdkFile = passed.isAdminSdkFile;
  if (isAdminSdkFile === undefined) return false;
  return adminFetches.getStore() === true || isLiveSdkCaller(isAdminSdkFile);
}

/**
 * Live mode's verdict for a socket or a dispatch: token sources and every
 * Google endpoint but the live rows' hosts, and Realtime Database's hosts
 * and the hosts of the imports the register passes through when the nearest
 * caller is a file the stop let load. With `firebase-admin` passed through,
 * its token sources and hosts ({@link ADMIN_TOKEN_HOSTS}, {@link ADMIN_HOSTS})
 * pass from a file of its tree.
 */
export function liveEgressRule(endpoints = tokenEndpointsFrom({ env: {} }), passed: PassedThrough = NOTHING_PASSED): EgressRule {
  return (hostname, path) => {
    const tokenRefusal = evaluateEgress(hostname, { mode: 'block', endpoints }, path);
    if (tokenRefusal !== null) {
      const isAdminToken = isAdminTokenSource(tokenRefusal) && isAdminCaller(passed);
      if (isAdminToken) return null;
      return { ...tokenRefusal, reason: TOKEN_REASON, remedy: LIVE_REMEDY };
    }
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
    if (service === null) return null;
    const isAdminCall = isAdminHost(host, path) && isAdminCaller(passed);
    return isAdminCall ? null : liveVerdict(host, service, LIVE_REASON);
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

/**
 * `fetch`, refusing a Google request from any caller but a file of the
 * installed SDK the stop let load, or of the passed-through Admin SDK's tree.
 */
function guardedFetch(real: Fetch, passed: PassedThrough, options: ReporterOptions): Fetch {
  const reporter = createReporter(options);
  const endpoints = options.endpoints ?? tokenEndpointsFrom({ env: {} });
  const rule = options.rule ?? liveEgressRule(endpoints);
  const guarded = function fetch(this: unknown, input: Parameters<Fetch>[0], init?: Parameters<Fetch>[1]): ReturnType<Fetch> {
    const url = fetchUrl(input);
    const isGoogle = url !== null && isGoogleRequest(url, endpoints);
    if (!isGoogle) return Reflect.apply(real, this, [input, init]) as ReturnType<Fetch>;
    const isFromLiveSdk = isLiveSdkCaller(passed.isLiveSdkFile);
    const isFromAdmin = !isFromLiveSdk && isAdminCaller(passed);
    const host = normalizeHostname(url.hostname);
    const isFromSdk = isFromLiveSdk || isFromAdmin;
    const refusedCaller = isFromSdk ? null : liveVerdict(host, googleServiceOf(host) ?? 'Google APIs', LIVE_FETCH_REASON);
    const verdict = rule(host, url.pathname) ?? refusedCaller;
    const send = (): ReturnType<Fetch> => Reflect.apply(real, this, [input, init]) as ReturnType<Fetch>;
    if (verdict === null) return isFromAdmin ? adminFetches.run(true, send) : send();
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
 * request. The passed-through Admin SDK reaches the live row hosts, such as
 * Auth's, with `https.request`, so a request to one from a file of its tree
 * passes. Its requests to the other hosts here stay refused.
 */
function liveRowRequestVerdict(request: RequestLike, passed: PassedThrough): EgressVerdict | null {
  const verdict = liveRowHostVerdict(request, passed);
  if (verdict === null) return null;
  const isAdminRowRequest = LIVE_ROW_HOSTS.has(verdict.host) && isAdminCaller(passed);
  return isAdminRowRequest ? null : verdict;
}

/** The refusal for an `http.request` to a live row host, a Realtime Database host or a passed-through host. */
function liveRowHostVerdict(request: RequestLike, passed: PassedThrough): EgressVerdict | null {
  const host = requestHost(request);
  if (host === null) return null;
  const service = googleServiceOf(host) ?? 'Google APIs';
  if (host === FIREBASE_AI_LOGIC_HOST) {
    return { verdict: 'block', permitted: false, host, service, reason: AI_REQUEST_REASON, remedy: AI_REQUEST_REMEDY };
  }
  if (host === STORAGE_HOST) {
    return { verdict: 'block', permitted: false, host, service, reason: STORAGE_REQUEST_REASON, remedy: STORAGE_REQUEST_REMEDY };
  }
  if (MESSAGING_HOSTS.has(host)) {
    return { verdict: 'block', permitted: false, host, service, reason: MESSAGING_REQUEST_REASON, remedy: MESSAGING_REQUEST_REMEDY };
  }
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
  /**
   * Whether a file URL is one of the passed-through Admin SDK's files. Read
   * only when `passThrough` lists `firebase-admin`.
   */
  readonly isAdminSdkFile?: (url: string) => boolean;
}

/** The Admin SDK's file check, when `firebase-admin` passes through. */
function adminSdkFileCheck(passThrough: readonly string[], isAdminSdkFile: ((url: string) => boolean) | undefined): { isAdminSdkFile?: (url: string) => boolean } {
  const passesAdmin = passThrough.includes(ADMIN_PASS_THROUGH) && isAdminSdkFile !== undefined;
  return passesAdmin ? { isAdminSdkFile } : {};
}

/** Installs live mode's guard in this thread. */
export function installLiveNetGuard(options: LiveNetGuardOptions): EgressHooks {
  // The environment can only add token sources (`GCE_METADATA_*`), never let one through.
  const endpoints = tokenEndpointsFrom({ env: options.env ?? process.env });
  const passThrough = [...(options.passThrough ?? [])];
  const passed: PassedThrough = {
    hosts: passThroughHosts(passThrough),
    isLiveSdkFile: options.isLiveSdkFile,
    ...adminSdkFileCheck(passThrough, options.isAdminSdkFile),
  };
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
  if (typeof real === 'function') fetchScope.fetch = guardedFetch(real, passed, reporterOptions);
  return installed;
}
