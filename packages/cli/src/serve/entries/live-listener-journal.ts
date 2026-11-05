/**
 * Journals a live row's Firestore listener in the page's SDK activity, the
 * journal pyric's own clients write, so the runtime chip's Listeners view and
 * Flow see a live listener as they see a sandbox one. `@pyric/live`'s page
 * observer reaches it through the observed-call sender beside it
 * (`observed-call-sender.ts`), and takes these types from
 * `@pyric/cli/vite/internal/supplied-rows`.
 */
import { sdkActivity, type UsageEvidence } from 'pyric/sandbox/internal';
import { deliverWithRegions } from '../worker/client/listener-delivery.js';

/** A Firestore listener, as the journal names it: never a value, only where it listens. */
export interface LiveListener {
  /** The Firestore instance the listener runs on, which names the app it belongs to. */
  readonly firestore: object;
  /** The export the app called, such as `onSnapshot`. */
  readonly method: string;
  /** The document or collection path, or the collection group's id. */
  readonly target: string;
  /** False for a document listener. */
  readonly isQuery: boolean;
  /** The same for two listeners on the same document or query. */
  readonly key: string;
}

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

/** The usage a delivery carries: the documents production billed, or none, so the journal measures the snapshot itself. */
function billedUsage(billedDocuments: number | undefined): UsageEvidence | undefined {
  if (billedDocuments === undefined) return undefined;
  return { documentReads: billedDocuments };
}

/**
 * Opens a live listener's subscription. Each delivery is journaled
 * immediately before the app's callback, with the documents production billed
 * it for, and the callback runs where the page keeps the regions it changes,
 * as a served listener's does, so Overview can outline them.
 */
export function journalLiveListener(listener: LiveListener, journal: ActivityJournal = sdkActivity): LiveListenerActivity {
  const activity = journal.begin({
    app: listener.firestore,
    method: listener.method,
    kind: 'subscription',
    source: { service: 'firestore', target: listener.target, isQuery: listener.isQuery, key: listener.key },
  });
  return {
    deliver(value, billedDocuments, run) {
      activity.delivered(value, billedUsage(billedDocuments));
      let returned: unknown;
      deliverWithRegions(activity.id, () => { returned = run(); });
      return returned;
    },
    fail: () => activity.fail(),
    close: () => activity.close(),
  };
}
