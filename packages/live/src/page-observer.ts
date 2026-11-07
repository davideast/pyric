/**
 * The page plane's observer: each live record of a Firestore, Auth, Realtime
 * Database, AI Logic, Cloud Storage or Cloud Messaging call becomes the
 * observed call the Node host writes to its event stream, with production's
 * answer. Records of `firebase/app` and `firebase/app-check` calls stay in
 * the page: the host's observed calls name Firestore, Auth, RTDB, AI Logic,
 * Storage and Messaging only. A call that returned synchronously, such as a
 * listener's subscribe, has no production answer and is not sent. A call
 * that ran signed in names its account: the uid, the claim names and, for
 * the host's local rules only, the claim values with emails left out; never
 * the token. A Firestore call also carries, for the same rules only, the data
 * a write sent and the document a `getDoc` returned. Those values go to the
 * host's memory, and to the live capture file once capture writes live
 * calls (#2305), nowhere else: no event, chip view or repro log holds
 * them. A Firestore list or listener names its query's shape: fields,
 * operators and directions, never a value, only the page's salted hash of
 * them. An RTDB call also names its instance and path, an AI Logic call its
 * model and production's token counts, a Storage call its bucket and, below
 * the root, its path, and a Messaging `getToken` or `deleteToken` the
 * Installations and FCM registration requests it made, as API and action
 * names. `firebase/messaging/sw` records come from a service worker, whose
 * observer sends them the same way. A resolved call the observer measured
 * carries its usage: counts only, never a value.
 *
 * Loaded in the page, so it imports only types from `@pyric/cli`.
 */
import type { ObservedCall, ObservedCallService, ProductionOutcome } from '@pyric/cli/vite/internal/supplied-rows';
import { UNREAD_MODEL } from './ai.js';
import { UNREAD_INSTANCE } from './database.js';
import { UNREAD_BUCKET } from './storage.js';
import type { LiveCallOutcome, LiveCallRecord, LiveObserver } from './observe.js';

const SERVICES: ReadonlyMap<string, ObservedCallService> = new Map<string, ObservedCallService>([
  ['firebase/firestore', 'firestore'],
  ['firebase/auth', 'auth'],
  ['firebase/database', 'rtdb'],
  ['firebase/ai', 'ai'],
  ['firebase/storage', 'storage'],
  ['firebase/messaging', 'messaging'],
  ['firebase/messaging/sw', 'messaging'],
]);

/** The most requests a host takes on one Messaging call. */
const MAX_REQUESTS = 4;

const ANSWERED: ReadonlySet<LiveCallOutcome> = new Set(['resolved', 'delivered']);
const FAILED: ReadonlySet<LiveCallOutcome> = new Set(['threw', 'rejected', 'listener-error']);

/** Production's answer in a record, or null for an outcome production did not give. */
function productionOutcome(record: LiveCallRecord): ProductionOutcome | null {
  if (ANSWERED.has(record.outcome)) return { status: 'ok' };
  const isFailure = FAILED.has(record.outcome);
  if (!isFailure) return null;
  return { status: 'error', code: record.code ?? 'unknown' };
}

/** The record's account as the host takes it: a fresh copy, or nothing for a call that ran signed out. */
function accountOf(record: LiveCallRecord): Pick<ObservedCall, 'account'> {
  const account = record.account;
  if (account === undefined) return {};
  const names = account.claimNames === undefined ? {} : { claimNames: [...account.claimNames] };
  const claims = account.claims === undefined ? names : { ...names, claims: { ...account.claims } };
  return { account: { uid: account.uid, ...claims } };
}

/** The record's write data and returned document, as the host takes them: Firestore only, a fresh copy of each. */
function valuesOf(service: ObservedCallService, record: LiveCallRecord): Pick<ObservedCall, 'writeData' | 'document'> {
  if (service !== 'firestore') return {};
  const written = record.writeData === undefined ? {} : { writeData: { ...record.writeData } };
  return record.document === undefined ? written : { ...written, document: { ...record.document } };
}

/** The record's query shape, as the host takes it: Firestore only, each clause copied. */
function queryOf(service: ObservedCallService, record: LiveCallRecord): Pick<ObservedCall, 'query'> {
  const query = record.query;
  const hasQuery = service === 'firestore' && query !== undefined;
  if (!hasQuery) return {};
  const filters = query.filters === undefined ? {} : { filters: query.filters.map((filter) => ({ ...filter })) };
  const orderBy = query.orderBy === undefined ? {} : { orderBy: query.orderBy.map((order) => ({ ...order })) };
  const limit = query.limit === undefined ? {} : { limit: query.limit };
  const fingerprint = query.fingerprint === undefined ? {} : { fingerprint: query.fingerprint };
  return { query: { scope: query.scope, ...filters, ...orderBy, ...limit, ...fingerprint } };
}

/**
 * The record's instance, bucket and path, as the host takes them. The host
 * requires an instance on every RTDB call and a bucket on every Storage call,
 * so an RTDB record without an instance names the unread instance, and a
 * Storage record without a bucket the unread bucket, rather than drop out of
 * Traffic.
 */
function placeOf(service: ObservedCallService, record: LiveCallRecord): Pick<ObservedCall, 'instance' | 'bucket' | 'path'> {
  const namedInstance = record.instance ?? (service === 'rtdb' ? UNREAD_INSTANCE : undefined);
  const namedBucket = record.bucket ?? (service === 'storage' ? UNREAD_BUCKET : undefined);
  const instance = namedInstance === undefined ? {} : { instance: namedInstance };
  const bucket = namedBucket === undefined ? instance : { ...instance, bucket: namedBucket };
  return record.path === undefined ? bucket : { ...bucket, path: record.path };
}

/**
 * The record's model and token counts, as the host takes them: a fresh copy.
 * The host requires them on every AI Logic call and refuses them on any
 * other, so an AI record without them names the unread model.
 */
function aiOf(service: ObservedCallService, record: LiveCallRecord): Pick<ObservedCall, 'ai'> {
  if (service !== 'ai') return {};
  const ai = record.ai ?? { model: UNREAD_MODEL };
  const reported = ai.reportedModel === undefined ? {} : { reportedModel: ai.reportedModel };
  const usage = ai.usage === undefined ? {} : { usage: { ...ai.usage } };
  const timing = ai.firstChunkMs === undefined ? {} : { firstChunkMs: ai.firstChunkMs };
  return { ai: { model: ai.model, ...reported, ...usage, ...timing } };
}

/**
 * The record's Messaging requests, as the host takes them: a fresh copy of
 * each, the last four at most. The host refuses them on any other service.
 */
function requestsOf(service: ObservedCallService, record: LiveCallRecord): Pick<ObservedCall, 'requests'> {
  const requests = record.requests;
  const hasRequests = service === 'messaging' && requests !== undefined && requests.length > 0;
  if (!hasRequests) return {};
  return { requests: requests.slice(-MAX_REQUESTS).map((request) => ({ ...request })) };
}

/** The observed call for a record made at `at`, or null when the host takes no row for it. */
export function observedCallOf(record: LiveCallRecord, at: number): ObservedCall | null {
  const service = SERVICES.get(record.module);
  if (service === undefined) return null;
  const outcome = productionOutcome(record);
  if (outcome === null) return null;
  const project = record.projectId === undefined ? {} : { projectId: record.projectId };
  const account = accountOf(record);
  const billed = record.billedDocuments === undefined ? {} : { billedDocuments: record.billedDocuments };
  const usage = record.usage === undefined ? {} : { usage: { ...record.usage } };
  return { service, method: record.name, at, outcome, ...project, ...account, ...billed, ...usage, ...placeOf(service, record), ...aiOf(service, record), ...requestsOf(service, record), ...valuesOf(service, record), ...queryOf(service, record) };
}

/** Sends one observed call to the host. Its rejection is the recorder's, never the app's. */
export type ObservedCallSend = (call: ObservedCall) => Promise<unknown>;

/** The observer a page's live modules share: each record that has a row is sent with the time it was made. */
export function pageObserver(send: ObservedCallSend, now: () => number = Date.now): LiveObserver {
  return (record) => {
    const call = observedCallOf(record, now());
    if (call === null) return undefined;
    return send(call);
  };
}
