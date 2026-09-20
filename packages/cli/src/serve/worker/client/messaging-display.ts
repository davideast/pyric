import type { DeliveryStage } from 'pyric/messaging/internal';

type Reporter = (stage: DeliveryStage) => void;
const observers = new Map<string, Set<Reporter>>();
const installed = new WeakSet<ServiceWorkerRegistration>();

/** Correlate native display with the FCM message ID used as the notification tag. */
export function observeMessageDisplay(messageId: string, report: Reporter): () => void {
  const worker = globalThis as typeof globalThis & { registration?: ServiceWorkerRegistration };
  const registration = worker.registration;
  const unavailable = registration === undefined;
  if (unavailable) return () => {};
  const needsObserver = !installed.has(registration);
  if (needsObserver) {
    try {
      const show = registration.showNotification.bind(registration);
      registration.showNotification = async (title, options) => {
        const reporters = [...(observers.get(options?.tag ?? '') ?? [])];
        for (const reporter of reporters) reporter('display-requested');
        try {
          await show(title, options);
          for (const reporter of reporters) reporter('display-accepted');
        } catch (error) {
          for (const reporter of reporters) reporter('display-rejected');
          throw error;
        }
      };
      installed.add(registration);
    } catch {
      // Diagnostic instrumentation must not prevent delivery on a read-only API.
      return () => {};
    }
  }
  const reporters = observers.get(messageId) ?? new Set<Reporter>();
  observers.set(messageId, reporters);
  reporters.add(report);
  const oldest = observers.keys().next();
  const overCapacity = observers.size > 32 && !oldest.done;
  if (overCapacity) observers.delete(oldest.value);
  return () => {
    reporters.delete(report);
    const finished = reporters.size === 0;
    if (finished) observers.delete(messageId);
  };
}
