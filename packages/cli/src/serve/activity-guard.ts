import {
  monitorFirebaseActivity,
  type ActivityFeed,
  type ActivityMonitor,
  type ActivityReport,
} from 'pyric/firestore/internal';
import type { SandboxEvent } from 'pyric/sandbox';

export type ActivityEventBatchSubscriber = (
  callback: (events: readonly SandboxEvent[], batch: { readonly history: boolean }) => void,
) => () => void;

/** Browser-safe reporter shared by the SharedWorker and in-page pyric dev paths. */
export function setupFirebaseActivityGuard(
  feed: ActivityFeed,
  fetchFn: typeof fetch,
  activityToken: string,
): ActivityMonitor {
  return monitorFirebaseActivity(feed, (incident) => {
    try {
      void fetchFn('/__pyric/activity', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-pyric-activity-token': activityToken,
        },
        body: JSON.stringify(incident),
      }).catch(() => {
        /* Diagnostics are best-effort and must never affect app behavior. */
      });
    } catch {
      /* An injected or unavailable fetch must never affect app behavior. */
    }
  });
}

/**
 * Monitor a streamed SandboxEvent source (such as hosted mode's worker-port
 * event stream) where the initial batch and any reconnect batch carry
 * `{ history: true }` and subsequent batches carry live events.
 */
export function setupStreamedFirebaseActivityGuard(
  subscribeEvents: ActivityEventBatchSubscriber,
  fetchFn: typeof fetch,
  activityToken: string,
): ActivityMonitor {
  let activeMonitor: ActivityMonitor | null = null;
  let forwardEvent: ((event: SandboxEvent) => void) | null = null;
  let disposed = false;

  const startMonitor = (initialHistory: readonly SandboxEvent[]): void => {
    if (activeMonitor !== null) {
      activeMonitor.dispose();
    }
    forwardEvent = null;
    const feed: ActivityFeed = {
      history: () => initialHistory,
      subscribe: (listener) => {
        forwardEvent = listener;
        return () => {
          if (forwardEvent === listener) {
            forwardEvent = null;
          }
        };
      },
    };
    activeMonitor = setupFirebaseActivityGuard(feed, fetchFn, activityToken);
  };

  const unsubscribeStream = subscribeEvents((events, batch) => {
    if (disposed) {
      return;
    }
    if (batch.history || activeMonitor === null) {
      startMonitor(events);
      return;
    }
    const listener = forwardEvent;
    if (listener === null) {
      return;
    }
    for (const event of events) {
      listener(event);
    }
  });

  const emptyReport: ActivityReport = Object.freeze({ incidents: Object.freeze([]) });

  return {
    report(): ActivityReport {
      if (activeMonitor !== null) {
        return activeMonitor.report();
      }
      return emptyReport;
    },
    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      unsubscribeStream();
      if (activeMonitor !== null) {
        activeMonitor.dispose();
        activeMonitor = null;
      }
      forwardEvent = null;
    },
  };
}
