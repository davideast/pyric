/**
 * Journals a live row's Firestore or Realtime Database listener in the
 * page's SDK activity, the
 * journal pyric's own clients write, so the runtime chip's Listeners view and
 * Flow see a live listener as they see a sandbox one. `@pyric/live`'s page
 * observer reaches it through the observed-call sender beside it
 * (`observed-call-sender.ts`), and takes these types from
 * `@pyric/cli/vite/internal/supplied-rows`.
 */
import { sdkActivity, type SdkActivitySource, type UsageEvidence } from 'pyric/sandbox/internal';
import { deliverWithRegions } from '../worker/client/listener-delivery.js';

/** What both services' listeners name: never a value, only where they listen. */
interface ListenerPlace {
  /** The export the app called, such as `onSnapshot` or `onValue`. */
  readonly method: string;
  /** The Firestore document or collection path, the collection group's id, or the database path. */
  readonly target: string;
  /** False for a document listener, or a database listener on its default query. */
  readonly isQuery: boolean;
  /** The same for two listeners on the same document, query or database query. */
  readonly key: string;
}

/** A Firestore listener. */
export interface FirestoreLiveListener extends ListenerPlace {
  readonly service?: 'firestore';
  /** The Firestore instance the listener runs on, which names the app it belongs to. */
  readonly firestore: object;
}

/** A Realtime Database listener. */
export interface DatabaseLiveListener extends ListenerPlace {
  readonly service: 'database';
  /** The SDK's repo for the listener's instance, which names the app and instance it belongs to. */
  readonly database: object;
}

/** A listener, as the journal names it. */
export type LiveListener = FirestoreLiveListener | DatabaseLiveListener;

/** One listener's activity in the page's journal. */
export interface LiveListenerActivity {
  /**
   * Reports a delivery of `value`, which production billed for
   * `billedDocuments`, then runs the app's callback and returns what it
   * returned. Anything the callback throws propagates.
   */
  deliver(value: unknown, billedDocuments: number | undefined, run: () => unknown): unknown;
  /** The listener was handed an error. */
  fail(): void;
  /** The app unsubscribed. */
  close(): void;
}

/** The journal the listener is opened in; the page's own by default. */
type ActivityJournal = Pick<typeof sdkActivity, 'begin'>;

/**
 * The usage a delivery carries: the documents production billed, or none, so
 * the journal measures the snapshot itself. A database delivery bills its
 * payload, which the journal measures.
 */
function billedUsage(listener: LiveListener, billedDocuments: number | undefined): UsageEvidence | undefined {
  const isMeasuredByJournal = listener.service === 'database' || billedDocuments === undefined;
  if (isMeasuredByJournal) return undefined;
  return { documentReads: billedDocuments };
}

/** The app the journal files the listener under, and the source it opens. */
function sourceOf(listener: LiveListener): { app: object; source: SdkActivitySource } {
  const place = { target: listener.target, isQuery: listener.isQuery, key: listener.key };
  if (listener.service === 'database') return { app: listener.database, source: { service: 'database', ...place } };
  return { app: listener.firestore, source: { service: 'firestore', ...place } };
}

/**
 * Opens a live listener's subscription. Each delivery is journaled
 * immediately before the app's callback, with the documents production billed
 * it for, and the callback runs where the page keeps the regions it changes,
 * as a served listener's does, so Overview can outline them.
 */
export function journalLiveListener(listener: LiveListener, journal: ActivityJournal = sdkActivity): LiveListenerActivity {
  const activity = journal.begin({ ...sourceOf(listener), method: listener.method, kind: 'subscription' });
  return {
    deliver(value, billedDocuments, run) {
      activity.delivered(value, billedUsage(listener, billedDocuments));
      let returned: unknown;
      deliverWithRegions(activity.id, () => { returned = run(); });
      return returned;
    },
    fail: () => activity.fail(),
    close: () => activity.close(),
  };
}
