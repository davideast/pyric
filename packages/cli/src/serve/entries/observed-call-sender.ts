/**
 * Sends an observed call (`ObservedCall` in `pyric/sandbox`) from a page to
 * the Node host, as the `observe` frame, on the page's own control
 * connection. The host stamps the page's caller from that connection, so the
 * row shows as this page's.
 *
 * Only a module served through supplied rows imports this
 * (`../vite-supplied-rows.ts`); no `pyric()` entry does. It is served from
 * this folder so it shares the page runtime's one connection and request ids.
 *
 * It also journals the rows' Firestore listeners (`journalLiveListener`) in
 * the page's SDK activity, the journal pyric's own clients write, so the
 * runtime chip's Listeners view and Flow see a live listener as they see a
 * sandbox one.
 */
import type { ObservedCall } from 'pyric/sandbox';
import { sdkActivity } from 'pyric/sandbox/internal';
import { nextId, rpc } from '../worker/client/core.js';
import { deliverWithRegions } from '../worker/client/listener-delivery.js';
import { useHosted, workerDb } from './worker-runtime.js';

/** Sends one observed call. Rejects when the page has no Node host connection. */
export async function sendObservedCall(call: ObservedCall): Promise<void> {
  const db = workerDb;
  const hasHostConnection = useHosted && db !== null;
  if (!hasHostConnection) throw new Error('pyric: this page has no Node host connection to report observed calls on.');
  await rpc(db.port, { t: 'observe', id: nextId(), call });
}

/** A live row's Firestore listener, as `@pyric/live` names it (`LiveListenerSubject` there). */
export interface LiveListener {
  /** The Firestore instance the listener runs on: the journal's app identity. */
  readonly firestore: object;
  readonly method: string;
  readonly target: string;
  readonly isQuery: boolean;
  readonly key: string;
}

/** The listener's activity, as `@pyric/live` drives it (`LiveListenerActivity` there). */
export interface LiveListenerActivity {
  deliver(value: unknown, billedDocuments: number | undefined, run: () => unknown): unknown;
  fail(): void;
  close(): void;
}

/**
 * Opens a live listener's subscription in the page's SDK activity. Each
 * delivery is journaled immediately before the app's callback, with the
 * documents production billed it for, and the callback runs where the page
 * keeps the regions it changes, as a served listener's does, so Overview can
 * outline them.
 */
export function journalLiveListener(listener: LiveListener): LiveListenerActivity {
  const activity = sdkActivity.begin({
    app: listener.firestore,
    method: listener.method,
    kind: 'subscription',
    source: { service: 'firestore', target: listener.target, isQuery: listener.isQuery, key: listener.key },
  });
  return {
    deliver(value, billedDocuments, run) {
      const usage = billedDocuments === undefined ? undefined : { documentReads: billedDocuments };
      activity.delivered(value, usage);
      let returned: unknown;
      deliverWithRegions(activity.id, () => { returned = run(); });
      return returned;
    },
    fail: () => activity.fail(),
    close: () => activity.close(),
  };
}
