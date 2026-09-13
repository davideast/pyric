import { sdkActivity } from 'pyric/sandbox/internal';
/**
 * Compatibility delivery hook for the runtime Flow correlator and Flow Studies.
 * SDK adapters report through the shared journal at the public callback/result
 * boundary. Worker records carry their transport id so existing outline lookup
 * can join backend attribution; in-page records use their activity id.
 * Synthetic reports remain available for the demonstration fixture.
 */

/** Called with the subscription id whose callback is about to run. */
export type ListenerDeliveryListener = (listenerId: string) => void;

const listeners = new Set<ListenerDeliveryListener>();

/** Watch for deliveries. Returns the function that stops watching. */
export function onListenerDelivery(listener: ListenerDeliveryListener): () => void {
  listeners.add(listener);
  const stopActivity = sdkActivity.subscribe(event => {
    if (event.phase === 'delivery') listener(event.record.transportId ?? event.record.id);
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
      listener(listenerId);
    } catch {
      /* a diagnostic must never break the application's delivery */
    }
  }
}
