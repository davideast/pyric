/**
 * The activity incidents that mark a listener outline's badge.
 *
 * The chip holds the page's event history already, so it raises incidents the
 * same way a read-only bridge method does: a transient monitor over a fixed
 * history, reported once and disposed. No warning is delivered from here; the
 * incidents are read for their pattern and count alone.
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
