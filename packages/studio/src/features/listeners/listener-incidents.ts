/**
 * Listener incidents (feature: Listeners).
 *
 * Runs the same activity monitor the sandbox tool's `activity` method uses
 * (`pyric/firestore/internal`), over the event history Studio already holds,
 * to surface the `duplicate-listener` and `listener-churn` incidents that
 * belong to a listener on screen.
 * The monitor is a pure fold over a fixed feed; Studio recomputes it whenever
 * its event snapshot changes rather than keeping a live subscription, since
 * `useStudioEvents` already re-renders on every new event.
 */

import { monitorFirebaseActivity, type ActivityFeed, type ActivityIncident } from 'pyric/firestore/internal';
import type { ActiveListenerTarget, SandboxEvent } from 'pyric/sandbox';

function historyFeed(history: readonly SandboxEvent[]): ActivityFeed {
  return {
    history: () => history,
    subscribe: () => () => {},
  };
}

/** Every incident the monitor raises over one event snapshot. */
export function listenerIncidents(events: readonly SandboxEvent[]): readonly ActivityIncident[] {
  const monitor = monitorFirebaseActivity(historyFeed(events), () => {});
  try {
    return monitor.report().incidents;
  } finally {
    monitor.dispose();
  }
}

/** The incident's target, decoded from its public fingerprint (a JSON string
 *  naming a doc path or a query's collection with an opaque query id), or
 *  `null` when the fingerprint doesn't parse. */
function incidentTarget(incident: ActivityIncident): ActiveListenerTarget | null {
  try {
    const parsed = JSON.parse(incident.targetFingerprint) as {
      kind?: unknown;
      path?: unknown;
      collection?: unknown;
    };
    if (parsed.kind === 'doc' && typeof parsed.path === 'string') return parsed.path;
    if (parsed.kind === 'query' && typeof parsed.collection === 'string') {
      return { collection: parsed.collection, query: true };
    }
  } catch {
    // Malformed or non-listener fingerprint: no match.
  }
  return null;
}

function targetsMatch(a: ActiveListenerTarget, b: ActiveListenerTarget): boolean {
  if (typeof a === 'string' || typeof b === 'string') return a === b;
  return a.collection === b.collection;
}

/** The duplicate-listener / listener-churn incidents whose target matches
 *  any listener in a group. */
export function incidentsForTarget(
  incidents: readonly ActivityIncident[],
  target: ActiveListenerTarget,
): readonly ActivityIncident[] {
  return incidents.filter((incident) => {
    if (incident.pattern !== 'duplicate-listener' && incident.pattern !== 'listener-churn') {
      return false;
    }
    const incidentTargetValue = incidentTarget(incident);
    return incidentTargetValue !== null && targetsMatch(incidentTargetValue, target);
  });
}

