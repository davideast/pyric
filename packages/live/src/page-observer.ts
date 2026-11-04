/**
 * The page plane's observer: each live record of a Firestore or Auth call
 * becomes the observed call the Node host writes to its event stream, with
 * production's answer. Records of `firebase/app` and `firebase/app-check`
 * calls stay in the page: the host's observed calls name Firestore and Auth
 * only. A call that returned synchronously, such as a listener's subscribe,
 * has no production answer and is not sent.
 *
 * Loaded in the page, so it imports only types from `@pyric/cli`.
 */
import type { ObservedCall, ObservedCallService, ProductionOutcome } from '@pyric/cli/vite/internal/supplied-rows';
import type { LiveCallOutcome, LiveCallRecord, LiveObserver } from './observe.js';

const SERVICES: ReadonlyMap<string, ObservedCallService> = new Map<string, ObservedCallService>([
  ['firebase/firestore', 'firestore'],
  ['firebase/auth', 'auth'],
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

/** The observed call for a record made at `at`, or null when the host takes no row for it. */
export function observedCallOf(record: LiveCallRecord, at: number): ObservedCall | null {
  const service = SERVICES.get(record.module);
  if (service === undefined) return null;
  const outcome = productionOutcome(record);
  if (outcome === null) return null;
  const project = record.projectId === undefined ? {} : { projectId: record.projectId };
  return { service, method: record.name, at, outcome, ...project };
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
