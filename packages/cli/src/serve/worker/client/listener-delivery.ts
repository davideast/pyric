/**
 * The moment a listener hands a snapshot to the application.
 *
 * The worker tells the page that a subscription produced data; the page is the
 * only side that knows when the application's own callback runs. Page-side
 * diagnostics that want to follow a delivery into the render it caused need
 * that moment, so the read paths report it here, immediately before invoking
 * the callback.
 *
 * The key is the worker subscription id, which is the same string the sandbox
 * records as a listener id on its attach and delivery events. So a subscriber
 * matches a delivery to a listener by identity and needs no mapping by target.
 *
 * Nothing is reported when nobody is listening, and a subscriber that throws
 * never reaches the application's callback.
 */

/** Called with the subscription id whose callback is about to run. */
export type ListenerDeliveryListener = (listenerId: string) => void;

const listeners = new Set<ListenerDeliveryListener>();

/** Watch for deliveries. Returns the function that stops watching. */
export function onListenerDelivery(listener: ListenerDeliveryListener): () => void {
  listeners.add(listener);
  return () => {
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
