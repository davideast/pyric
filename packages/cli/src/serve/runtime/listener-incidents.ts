/**
 * The activity incidents that mark a listener outline's badge.
 *
 * Snapshot callers fold a fixed history; the live chip retains its monitor
 * across batches. Neither emits warnings: outlines read patterns and counts.
 */
import { monitorFirebaseActivity, type ActivityFeed, type ActivityIncident } from 'pyric/firestore/internal';
import type { SandboxEvent } from 'pyric/sandbox';

/** A feed over a fixed history. The monitor also asks to subscribe; a
 * snapshot read has no live event to offer, so the subscription delivers
 * nothing. */
function historyFeed(history: readonly SandboxEvent[]): ActivityFeed {
  return {
    history: () => history,
    subscribe: () => () => {},
  };
}

/** Every incident this event history raises, listener patterns included. */
export function incidentsFromEvents(events: readonly SandboxEvent[]): readonly ActivityIncident[] {
  const monitor = monitorFirebaseActivity(historyFeed(events), () => {});
  try {
    return monitor.report().incidents;
  } finally {
    monitor.dispose();
  }
}

/** Preserve the monitor across batches; historical hydration uses the same fold. */
export function createListenerIncidents() {
  let observe: (event: SandboxEvent) => void = () => {};
  const monitor = monitorFirebaseActivity({
    history: () => [],
    subscribe(listener) {
      observe = listener;
      return () => { observe = () => {}; };
    },
  }, () => {});
  return {
    append(events: readonly SandboxEvent[]) {
      for (const event of events) observe(event);
    },
    read: () => monitor.report().incidents,
    dispose: () => monitor.dispose(),
  };
}
