/**
 * The incident over one listener (feature: Listeners).
 *
 * Shared by the tab's inspector and the listener page, and first in both: an
 * incident is the reason a reader opened the listener, so it sits above the
 * facts rather than under them. One line states what happened, and one line
 * per attach states where it was opened and what it paints.
 *
 * Churn lists one attach: forty reattaches of one line of code are forty
 * copies of the same line, and the count in the first line is the fact.
 */

import type { ActivityIncident } from 'pyric/firestore/internal';
import type { ActiveListener, SandboxEvent } from 'pyric/sandbox';
import { attachSites } from './listener-attaches.js';
import { elementLabel } from './listener-element.js';
import { incidentLine } from './listener-facts.js';
import { groupIdentityFor } from './listener-groups.js';
import { formatAgo } from './listener-vocabulary.js';

export function IncidentBlock({
  incident,
  listener,
  events,
  now,
}: {
  incident: ActivityIncident;
  listener: ActiveListener;
  events: readonly SandboxEvent[];
  now: number;
}) {
  const owner = groupIdentityFor(listener).label;
  const sites = attachSites(events, listener.target, owner);
  const listed = incident.pattern === 'listener-churn' ? sites.slice(-1) : sites;
  const ages =
    incident.pattern === 'listener-churn' ? [] : sites.map((site) => formatAgo(site.at, now));
  const fallback = elementLabel(listener.owners);
  const detailed = listed.filter(
    (site) => site.frame !== undefined || (site.element ?? fallback) !== undefined,
  );
  return (
    <div className="traffic__listener-incident" data-pyric-incident-block="">
      <p className="traffic__listener-incident-line">
        <span aria-hidden="true">⚠</span> {incidentLine(incident, owner, ages)}
      </p>
      {detailed.map((site, index) => {
        const element = site.element ?? fallback;
        return (
          <p
            className="traffic__listener-incident-attach"
            key={`${site.at}|${index}`}
            data-pyric-incident-attach=""
          >
            {site.frame === undefined ? null : <span>{site.frame}</span>}
            {site.frame !== undefined && element !== undefined ? <span> · </span> : null}
            {element === undefined ? null : <span data-pyric-element="">{element}</span>}
          </p>
        );
      })}
    </div>
  );
}
