/**
 * Listener incidents (feature: Listeners).
 *
 * Runs the shared `@pyric/ui/events` activity-incident collector over the event
 * history Studio already holds, surfacing the `duplicate-listener` and
 * `listener-churn` incidents that belong to a listener on screen.
 */

import {
  collectActivityIncidents,
  decodeActivityIncidentTarget,
} from '@pyric/ui/events';
import type { ActivityIncident } from 'pyric/firestore/internal';
import type { ActiveListenerTarget, SandboxEvent } from 'pyric/sandbox';

/** Every incident the monitor raises over one event snapshot. */
export function listenerIncidents(events: readonly SandboxEvent[]): readonly ActivityIncident[] {
  return collectActivityIncidents(events);
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
    const incidentTargetValue = decodeActivityIncidentTarget(incident.targetFingerprint);
    return incidentTargetValue !== null && targetsMatch(incidentTargetValue, target);
  });
}


