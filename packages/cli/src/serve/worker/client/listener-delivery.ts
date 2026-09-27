import { recordEffectRegions, sdkActivity } from 'pyric/sandbox/internal';
import { listenerKey, type ListenerKey } from '../../runtime/listener-key.js';
/**
 * Delivery hooks between the page's SDK client and the runtime chip.
 *
 * SDK adapters report through the shared journal at the public callback/result
 * boundary, and a delivery names its listener by the activity id on every
 * transport. Synthetic reports remain available for the demonstration fixture.
 *
 * The page regions a served listener's callback changed are kept here too. An
 * in-page sandbox records them itself, around the callback it runs, and puts
 * them on the delivery event. A served listener's callback runs in the page
 * while its sandbox runs elsewhere, so the page records them and keeps the
 * latest selectors per activity id for the chip to read.
 */

/** Called with the key of the listener whose callback is about to run. */
export type ListenerDeliveryListener = (listenerId: ListenerKey) => void;

const listeners = new Set<ListenerDeliveryListener>();

/** Watch for deliveries. Returns the function that stops watching. */
export function onListenerDelivery(listener: ListenerDeliveryListener): () => void {
  listeners.add(listener);
  const stopActivity = sdkActivity.subscribe(event => {
    if (event.phase === 'delivery' || event.phase === 'progress') listener(listenerKey(event.record.id));
  });
  return () => {
    stopActivity();
    listeners.delete(listener);
  };
}

/** Report that this subscription is about to invoke the application's callback. */
export function reportListenerDelivery(listenerId: string): void {
  if (listeners.size === 0) return;
  for (const listener of [...listeners]) {
    try {
      listener(listenerKey(listenerId));
    } catch {
      /* a diagnostic must never break the application's delivery */
    }
  }
}

type ActivityJournal = Pick<typeof sdkActivity, 'subscribe'>;

/** The latest page regions each served listener's callback changed. */
export interface DeliveredRegionStore {
  /**
   * Run the application's callback and keep the selectors of the elements it
   * changed. A callback that changed nothing keeps the previous selectors:
   * the listener's data is still where the last change put it. Anything the
   * callback throws propagates unchanged.
   */
  record(activityId: string, run: () => void): void;
  /** The selectors, empty when no delivery changed the page. */
  regions(activityId: string): readonly string[];
  /** Called after any activity's selectors change. */
  subscribe(listener: () => void): () => void;
  dispose(): void;
}

/** A store that forgets an activity when the journal removes its record. */
export function createDeliveredRegionStore(journal: ActivityJournal): DeliveredRegionStore {
  const regions = new Map<string, readonly string[]>();
  const subscribers = new Set<() => void>();
  const notify = (): void => {
    for (const subscriber of [...subscribers]) {
      try { subscriber(); } catch { /* a diagnostic must never break the application's delivery */ }
    }
  };
  const stopJournal = journal.subscribe(event => {
    const isRemoval = event.phase === 'remove';
    if (isRemoval) regions.delete(event.record.id);
  });
  return {
    record(activityId, run) {
      const owner = recordEffectRegions(run);
      const changedNothing = owner === undefined || owner.kind !== 'regions';
      if (changedNothing) return;
      regions.set(activityId, Object.freeze([...owner.selectors]));
      notify();
    },
    regions: activityId => regions.get(activityId) ?? [],
    subscribe(listener) {
      subscribers.add(listener);
      return () => { subscribers.delete(listener); };
    },
    dispose() {
      stopJournal();
      regions.clear();
      subscribers.clear();
    },
  };
}

/** The SDK client and the runtime chip may load separate copies of this module. */
const STORE_KEY = Symbol.for('pyric.delivered-regions');
const globalStore = globalThis as { [STORE_KEY]?: DeliveredRegionStore };
const pageStore = globalStore[STORE_KEY] ?? (globalStore[STORE_KEY] = createDeliveredRegionStore(sdkActivity));

/** Run a served listener's callback and keep the page regions it changed. */
export function deliverWithRegions(activityId: string, run: () => void): void {
  pageStore.record(activityId, run);
}

/** The page regions this activity's latest changing delivery touched. */
export function deliveredRegions(activityId: string): readonly string[] {
  return pageStore.regions(activityId);
}

/** Watch for new delivered regions. Returns the function that stops watching. */
export function onDeliveredRegions(listener: () => void): () => void {
  return pageStore.subscribe(listener);
}
