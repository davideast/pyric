/**
 * What the live-messaging rows know about `firebase/messaging` and
 * `firebase/messaging/sw`: where a call's app and project sit on the SDK's
 * Messaging instance, which Installations and FCM registration requests a
 * `getToken` or `deleteToken` made, how production's answer is read from
 * them and from the SDK's error, and which calls made no request at all.
 *
 * The observed calls are `getToken` and `deleteToken` on the page, and the
 * deliveries of `onMessage` (page) and `onBackgroundMessage` (service
 * worker), one record per message the SDK hands the app. The subscribe call
 * itself has no production answer. `getMessaging`, `isSupported` and
 * `experimentalSetDeliveryMetricsExportedToBigQueryEnabled` are the SDK's
 * own values and make no record: `isSupported` checks browser APIs and sends
 * no request.
 *
 * The requests behind a call come from Resource Timing, which the browser
 * keeps for the SDK's own `fetch` in the page and the service worker without
 * touching the request. A `PerformanceObserver` on `resource` entries starts
 * at the realm's first `getToken` or `deleteToken`, and each call takes the
 * entries for `firebaseinstallations.googleapis.com` and
 * `fcmregistrations.googleapis.com` that started between the call and its
 * settlement. Each becomes an API, an action and production's HTTP status:
 * the URL's project, installation id (FID) and token are dropped as the entry
 * is read, and the status is left out when the browser reports 0. A call
 * keeps its last four requests: another service's concurrent Installations
 * call can land in the window. Two Messaging calls running at once in one
 * realm each take the other's requests too.
 *
 * A call that settles with no such entry made no request: the stored token
 * was valid, there was none to delete, or the SDK failed locally
 * (`messaging/permission-blocked`, `unsupported-browser`). It makes no
 * record. An error that carries production's status (an Installations
 * `customData.serverCode`) is recorded even when the browser kept no entry
 * for it. A `messaging/token-*` failure carries none: the SDK throws it when
 * production refused and when `fetch` itself threw, so with no entry it
 * makes no record. Where the realm has no `PerformanceObserver`, every
 * settled call is recorded, without requests.
 *
 * The FID registration calls (`register`, `unregister`, `onRegistered` and
 * `onUnregistered`, the last two in both entries) are not observed yet. Each
 * throws live mode's refusal before the SDK runs, so no registration request
 * leaves and no installation id reaches a record.
 *
 * A record never carries the token, the VAPID key, the push subscription's
 * endpoint or keys, the FID, or any payload field. Reading never calls the
 * app's code and never throws. This file imports no Firebase SDK.
 */
import { aiCode } from './ai.js';
import type { RefusalCheck } from './modules.js';
import { UNOBSERVED, type CallContext, type LiveRequest, type ObservedSite, type RejectionReading, type ResultReading } from './observe.js';
import type { RefusedCall } from './refusal.js';

type Fields = Record<string, unknown>;

/** The one-shot `firebase/messaging` calls the row observes. */
export const MESSAGING_CALLS = ['getToken', 'deleteToken'] as const;

/** The most requests a host takes on one call. */
export const MAX_REQUESTS = 4;

/** The most recent entries a watcher keeps between calls. */
const KEPT_ENTRIES = 32;

const API_BY_HOST: ReadonlyMap<string, LiveRequest['api']> = new Map([
  ['firebaseinstallations.googleapis.com', 'installations'],
  ['fcmregistrations.googleapis.com', 'registrations'],
]);

/** What a request's path says it did, read before the path is dropped. A registration path names a token or a FID, which is not kept. */
type PathShape = 'installations' | 'authToken' | 'registrations' | 'registration';

const PATH_SHAPES: readonly (readonly [RegExp, PathShape])[] = [
  [/^\/v1\/projects\/[^/]+\/installations$/, 'installations'],
  [/^\/v1\/projects\/[^/]+\/installations\/[^/]+\/authTokens:generate$/, 'authToken'],
  [/^\/v1\/projects\/[^/]+\/registrations$/, 'registrations'],
  [/^\/v1\/projects\/[^/]+\/registrations\/[^/]+$/, 'registration'],
];

/** One watched entry: its shape, when it started, and production's status, if the browser reported one. */
interface SeenRequest {
  readonly shape: PathShape;
  readonly startTime: number;
  readonly status?: number;
}

interface Watcher {
  /** The entries kept so far, with any the browser has queued but not yet delivered. */
  take(): readonly SeenRequest[];
}

type PerformanceObserverClass = new (callback: (list: { getEntries(): unknown[] }) => void) => {
  observe(options: { type: string; buffered?: boolean }): void;
  takeRecords(): unknown[];
};

/** One watcher for each `PerformanceObserver` class the realm has had. */
const WATCHERS = new WeakMap<object, Watcher>();

function isObject(value: unknown): value is Fields {
  return (typeof value === 'object' || typeof value === 'function') && value !== null;
}

function valueAt(value: unknown, keys: readonly string[]): unknown {
  let current = value;
  for (const key of keys) {
    if (!isObject(current)) return undefined;
    current = current[key];
  }
  return current;
}

function stringAt(value: unknown, keys: readonly string[]): string | undefined {
  const found = valueAt(value, keys);
  return typeof found === 'string' && found !== '' ? found : undefined;
}

function isHttpStatus(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599;
}

/** An entry as the watcher keeps it, or undefined for one that is not an Installations or registrations request. */
function seenOf(entry: unknown): SeenRequest | undefined {
  const name = stringAt(entry, ['name']);
  const startTime = valueAt(entry, ['startTime']);
  if (name === undefined || typeof startTime !== 'number') return undefined;
  let url: URL;
  try {
    url = new URL(name);
  } catch {
    return undefined;
  }
  if (!API_BY_HOST.has(url.hostname)) return undefined;
  const shape = PATH_SHAPES.find(([pattern]) => pattern.test(url.pathname))?.[1];
  if (shape === undefined) return undefined;
  const status = valueAt(entry, ['responseStatus']);
  return { shape, startTime, ...(isHttpStatus(status) ? { status } : {}) };
}

function keep(seen: SeenRequest[], entries: readonly unknown[]): void {
  for (const entry of entries) {
    const request = seenOf(entry);
    if (request !== undefined) seen.push(request);
  }
  if (seen.length > KEPT_ENTRIES) seen.splice(0, seen.length - KEPT_ENTRIES);
}

function startWatcher(Observer: PerformanceObserverClass): Watcher {
  const seen: SeenRequest[] = [];
  const observer = new Observer((list) => keep(seen, list.getEntries()));
  observer.observe({ type: 'resource', buffered: true });
  return {
    take() {
      keep(seen, observer.takeRecords());
      return seen;
    },
  };
}

/** The realm's watcher, started on first use, or null where the realm has no `PerformanceObserver`. */
function watcher(): Watcher | null {
  try {
    const Observer = (globalThis as { PerformanceObserver?: unknown }).PerformanceObserver;
    if (typeof Observer !== 'function') return null;
    const existing = WATCHERS.get(Observer);
    if (existing !== undefined) return existing;
    const started = startWatcher(Observer as PerformanceObserverClass);
    WATCHERS.set(Observer, started);
    return started;
  } catch {
    // A realm whose observer cannot start records every settled call, without requests.
    return null;
  }
}

function timelineNow(): number | undefined {
  try {
    return typeof performance === 'object' && typeof performance.now === 'function' ? performance.now() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The record context of one Messaging call or listener, from its Messaging
 * instance (`args[0]`): the app, whose Auth names the account, and its
 * project. A `getToken` or `deleteToken` also starts the realm's watcher
 * and notes when it started on the performance timeline.
 */
export function messagingContext(name: string, args: readonly unknown[]): CallContext {
  const app = valueAt(args[0], ['app']);
  const projectId = stringAt(app, ['options', 'projectId']);
  const context: CallContext = { ...(isObject(app) ? { subject: app } : {}), ...(projectId === undefined ? {} : { projectId }) };
  const isCall = (MESSAGING_CALLS as readonly string[]).includes(name);
  if (!isCall || watcher() === null) return context;
  const timelineStart = timelineNow();
  return timelineStart === undefined ? context : { ...context, timelineStart };
}

/**
 * The action of each request, in order. A `/registrations/<x>` entry is a
 * `delete` in `deleteToken`; in `getToken` it is an `update`, or a `delete`
 * when the next registrations request creates one, as the SDK deletes a
 * stale token before it subscribes again.
 */
function requestsOf(name: string, seen: readonly SeenRequest[]): LiveRequest[] {
  return seen.map((request, index) => {
    const status = request.status === undefined ? {} : { status: request.status };
    if (request.shape === 'installations') return { api: 'installations', action: 'create', ...status };
    if (request.shape === 'authToken') return { api: 'installations', action: 'generateAuthToken', ...status };
    if (request.shape === 'registrations') return { api: 'registrations', action: 'create', ...status };
    const nextRegistration = seen.slice(index + 1).find((later) => later.shape === 'registrations' || later.shape === 'registration');
    const isReplaced = name === 'deleteToken' || nextRegistration?.shape === 'registrations';
    return { api: 'registrations', action: isReplaced ? 'delete' : 'update', ...status };
  });
}

/** Lets the browser report the entry of the call's last request, which can land just after the SDK settles. */
function afterSettling(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** The requests the call at `site` made, at most four, or undefined where the realm has no watcher. */
async function callRequests(site: ObservedSite): Promise<LiveRequest[] | undefined> {
  const start = site.timelineStart;
  const realm = watcher();
  if (start === undefined || realm === null) return undefined;
  await afterSettling();
  const seen = realm.take().filter((request) => request.startTime >= start);
  return requestsOf(site.name, seen).slice(-MAX_REQUESTS);
}

/** A record's requests, or nothing for none. */
function requestsField(requests: readonly LiveRequest[] | undefined): Pick<CallContext, 'requests'> {
  return requests === undefined || requests.length === 0 ? {} : { requests };
}

/** What a resolved `getToken` or `deleteToken` adds: the requests it made, or no record when it made none. */
export async function messagingResult(site: ObservedSite): Promise<ResultReading> {
  const requests = await callRequests(site);
  const isLocal = requests !== undefined && requests.length === 0;
  return isLocal ? UNOBSERVED : requestsField(requests);
}

/** The codes `readObservedCall` takes. */
const CODE_PATTERN = /^[a-z0-9_/-]{1,100}$/;

/** Production's canonical name for an HTTP status, by AI Logic's mapping (`aiCode`). */
function statusCode(status: number): string {
  return aiCode({ customErrorData: { status } });
}

/** The status production sent, lowercased, as an Installations error keeps it in `customData.serverStatus`. */
function serverStatusOf(error: unknown): string | undefined {
  const status = stringAt(error, ['customData', 'serverStatus'])?.toLowerCase();
  return status !== undefined && CODE_PATTERN.test(status) ? status : undefined;
}

/**
 * Whether the SDK's error carries production's status, so a request reached
 * it even when the browser kept no entry. A `messaging/token-*` code alone
 * does not: the SDK throws it when `fetch` itself threw, too.
 */
function carriesAnswer(error: unknown): boolean {
  return isHttpStatus(valueAt(error, ['customData', 'serverCode']));
}

/** The status of the last request production refused, if any. */
function lastFailingStatus(requests: readonly LiveRequest[]): number | undefined {
  for (let index = requests.length - 1; index >= 0; index--) {
    const status = requests[index]?.status;
    if (status !== undefined && status >= 400) return status;
  }
  return undefined;
}

/**
 * Production's answer for a failed Messaging call, read in order: the
 * canonical name of the last failing request's status, then the status an
 * Installations error kept, then the SDK's code.
 */
export function messagingCode(error: unknown, requests: readonly LiveRequest[] = []): string {
  try {
    const failing = lastFailingStatus(requests);
    if (failing !== undefined) return statusCode(failing);
    const serverStatus = serverStatusOf(error);
    if (serverStatus !== undefined) return serverStatus;
    return stringAt(error, ['code']) ?? stringAt(error, ['name']) ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/** What a rejected `getToken` or `deleteToken` adds: its requests and production's code, or no record when it failed locally. */
export async function messagingRejection(site: ObservedSite, error: unknown): Promise<RejectionReading> {
  const requests = await callRequests(site);
  const isLocal = requests !== undefined && requests.length === 0 && !carriesAnswer(error);
  if (isLocal) return UNOBSERVED;
  return { ...requestsField(requests), code: messagingCode(error, requests) };
}

/** What live mode serves of `firebase/messaging` and `firebase/messaging/sw`, which each refusal names. */
const MESSAGING_SERVES = 'only getToken, deleteToken, onMessage and onBackgroundMessage';

function refusedRegistration(call: string): RefusalCheck {
  const refused: RefusedCall = { call, reaches: 'FCM registration by Firebase Installation ID', serves: MESSAGING_SERVES };
  return () => refused;
}

/**
 * The FID registration calls of `firebase/messaging`, which the row does not
 * observe yet. `register` and `unregister` send FCM registration requests,
 * and `onRegistered` and `onUnregistered` hand the app the installation id,
 * so each throws live mode's refusal before the SDK runs.
 */
export const MESSAGING_REFUSED_CALLS: Readonly<Record<string, RefusalCheck>> = {
  register: refusedRegistration('register'),
  unregister: refusedRegistration('unregister'),
  onRegistered: refusedRegistration('onRegistered'),
  onUnregistered: refusedRegistration('onUnregistered'),
};

/** The FID registration listeners `firebase/messaging/sw` exports, refused as the page's are. */
export const MESSAGING_SW_REFUSED_CALLS: Readonly<Record<string, RefusalCheck>> = {
  onRegistered: refusedRegistration('onRegistered'),
  onUnregistered: refusedRegistration('onUnregistered'),
};
