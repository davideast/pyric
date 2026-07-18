import {
  monitorFirebaseActivity,
  type ActivityFeed,
  type ActivityMonitor,
} from 'pyric/firestore/internal';

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
