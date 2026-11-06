/**
 * The page plane's observer: each live record of a Firestore, Auth, Realtime
 * Database or AI Logic call becomes the observed call the Node host writes to
 * its event stream, with production's answer. Records of `firebase/app` and
 * `firebase/app-check` calls stay in the page: the host's observed calls name
 * Firestore, Auth, RTDB and AI Logic only. A call that returned synchronously, such as
 * a listener's subscribe, has no production answer and is not sent. A call
 * that ran signed in names its account: the uid and claim names, never the
 * token. An RTDB call also names its instance and path, and an AI Logic call
 * its model and production's token counts.
 *
 * Loaded in the page, so it imports only types from `@pyric/cli`.
 */
import type { ObservedCall, ObservedCallService, ProductionOutcome } from '@pyric/cli/vite/internal/supplied-rows';
import { UNREAD_MODEL } from './ai.js';
import { UNREAD_INSTANCE } from './database.js';
import type { LiveCallOutcome, LiveCallRecord, LiveObserver } from './observe.js';

const SERVICES: ReadonlyMap<string, ObservedCallService> = new Map<string, ObservedCallService>([
  ['firebase/firestore', 'firestore'],
  ['firebase/auth', 'auth'],
  ['firebase/database', 'rtdb'],
  ['firebase/ai', 'ai'],
]);

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
  const claims = account.claimNames === undefined ? {} : { claimNames: [...account.claimNames] };
  return { account: { uid: account.uid, ...claims } };
}

/**
 * The record's instance and path, as the host takes them. The host requires
 * an instance on every RTDB call, so an RTDB record without one names the
 * unread instance rather than drop out of Traffic.
 */
function placeOf(service: ObservedCallService, record: LiveCallRecord): Pick<ObservedCall, 'instance' | 'path'> {
  const named = record.instance ?? (service === 'rtdb' ? UNREAD_INSTANCE : undefined);
  const instance = named === undefined ? {} : { instance: named };
  return record.path === undefined ? instance : { ...instance, path: record.path };
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

/** The observed call for a record made at `at`, or null when the host takes no row for it. */
export function observedCallOf(record: LiveCallRecord, at: number): ObservedCall | null {
  const service = SERVICES.get(record.module);
  if (service === undefined) return null;
  const outcome = productionOutcome(record);
  if (outcome === null) return null;
  const project = record.projectId === undefined ? {} : { projectId: record.projectId };
  const account = accountOf(record);
  const billed = record.billedDocuments === undefined ? {} : { billedDocuments: record.billedDocuments };
  return { service, method: record.name, at, outcome, ...project, ...account, ...billed, ...placeOf(service, record), ...aiOf(service, record) };
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
