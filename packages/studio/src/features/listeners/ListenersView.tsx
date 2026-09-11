/**
 * Listeners view (feature: Listeners). Presentational: takes the event
 * snapshot and the deep-link inputs as props so it can be rendered without
 * Studio's environment/dev-seed wiring in tests. `ListenersSurface.tsx` is
 * the thin wrapper that reads the live stream and the deep link and renders
 * this.
 */

import { useEffect, useRef, useState } from 'react';
import { activeListeners, type ActiveListener, type SandboxEvent } from 'pyric/sandbox';
import {
  formatListenerTarget,
  groupListeners,
  type ListenerFilters,
} from './listener-groups.js';
import {
  incidentsForTarget,
  listenerIncidents,
  repeatedReadIncidents,
} from './listener-incidents.js';
import { formatAuthLens } from './listener-identity.js';
import './listeners.css';

function formatWhen(at: number): string {
  return new Date(at).toLocaleTimeString();
}

function regionsFor(listener: ActiveListener): string[] {
  for (const owner of listener.owners ?? []) {
    if (owner.kind === 'regions') return owner.selectors;
  }
  return [];
}

/** `incidentsForTarget` only ever returns these two patterns; the third
 *  (`repeated-read`) still types here since it shares `ActivityIncident`. */
function incidentLabel(pattern: 'duplicate-listener' | 'listener-churn' | 'repeated-read'): string {
  if (pattern === 'duplicate-listener') return 'duplicate listener';
  if (pattern === 'listener-churn') return 'listener churn';
  return 'repeated read';
}

/** Assemble the group filters from the two filter controls' current values.
 *  Built explicitly (no conditional spread) so presence is a plain
 *  if/else decision rather than truthiness. */
function listenerFiltersFor(
  service: ActiveListener['service'] | '',
  targetPrefix: string,
): ListenerFilters {
  const filters: { service?: ActiveListener['service']; targetPrefix?: string } = {};
  if (service !== '') filters.service = service;
  if (targetPrefix !== '') filters.targetPrefix = targetPrefix;
  return filters;
}

export interface ListenersViewProps {
  events: readonly SandboxEvent[];
  highlightListenerId?: string;
  initialTargetPrefix?: string;
}

export function ListenersView({
  events,
  highlightListenerId,
  initialTargetPrefix,
}: ListenersViewProps) {
  const [service, setService] = useState<ActiveListener['service'] | ''>('');
  const [targetPrefix, setTargetPrefix] = useState(initialTargetPrefix ?? '');
  const highlightRef = useRef<HTMLLIElement | null>(null);

  useEffect(() => {
    if (highlightListenerId) highlightRef.current?.scrollIntoView({ block: 'center' });
  }, [highlightListenerId]);

  const listeners = activeListeners(events);
  const incidents = listenerIncidents(events);
  const repeatedReads = repeatedReadIncidents(incidents);

  const groups = groupListeners(listeners, listenerFiltersFor(service, targetPrefix));

  return (
    <section className="listeners" aria-labelledby="listeners-title">
      <header className="listeners__head">
        <h2 id="listeners-title" className="listeners__title">
          Listeners
        </h2>
        <span className="listeners__count">{listeners.length}</span>
      </header>

      {repeatedReads.length > 0 ? (
        <div className="listeners__incident listeners__incident--repeated-read" data-testid="repeated-read-incident">
          {`repeated read ×${repeatedReads.reduce((sum, incident) => sum + incident.count, 0)}`}
        </div>
      ) : null}

      <div className="listeners__filters">
        <label className="listeners__filter">
          Service
          <select
            value={service}
            onChange={(event) => setService(event.target.value as ActiveListener['service'] | '')}
          >
            <option value="">All</option>
            <option value="firestore">Firestore</option>
            <option value="database">Database</option>
          </select>
        </label>
        <label className="listeners__filter">
          Target prefix
          <input
            type="text"
            value={targetPrefix}
            onChange={(event) => setTargetPrefix(event.target.value)}
            placeholder="collection or path"
          />
        </label>
      </div>

      {groups.length === 0 ? (
        <p className="listeners__empty">No active listeners match this filter.</p>
      ) : (
        groups.map((group) => (
          <section key={group.identity.key} className="listeners__group">
            <header className="listeners__group-head">
              <span className="listeners__group-label">{group.identity.label}</span>
              {group.identity.subtitle ? (
                <span className="listeners__group-subtitle">{group.identity.subtitle}</span>
              ) : null}
              <span className="listeners__group-count">{group.listeners.length}</span>
            </header>
            <ul className="listeners__rows">
              {group.listeners.map((listener) => {
                const rowIncidents = incidentsForTarget(incidents, listener.target);
                const highlighted = listener.id === highlightListenerId;
                return (
                  <li
                    key={listener.id}
                    ref={highlighted ? highlightRef : undefined}
                    className={
                      highlighted ? 'listeners__row listeners__row--highlight' : 'listeners__row'
                    }
                    data-testid={`listener-row-${listener.id}`}
                  >
                    <span className="listeners__cell listeners__cell--service">{listener.service}</span>
                    <span className="listeners__cell listeners__cell--target">
                      {formatListenerTarget(listener.target)}
                    </span>
                    <span className="listeners__cell listeners__cell--identity">
                      {formatAuthLens(listener.authLens)}
                    </span>
                    <span className="listeners__cell listeners__cell--attached">
                      {formatWhen(listener.attachedAt)}
                    </span>
                    <span className="listeners__cell listeners__cell--deliveries">
                      {listener.deliveryCount} deliveries
                    </span>
                    <span className="listeners__cell listeners__cell--suppressed">
                      {listener.suppressedCount} suppressed
                    </span>
                    {listener.lastDeliveryAt !== undefined ? (
                      <span className="listeners__cell listeners__cell--last-delivery">
                        last {formatWhen(listener.lastDeliveryAt)}
                      </span>
                    ) : null}
                    {regionsFor(listener).length > 0 ? (
                      <span className="listeners__cell listeners__cell--regions">
                        paints {regionsFor(listener).join(', ')}
                      </span>
                    ) : null}
                    {rowIncidents.map((incident) => (
                      <span
                        key={incident.fingerprint}
                        className="listeners__incident listeners__incident--inline"
                      >
                        {`${incidentLabel(incident.pattern)} ×${incident.count}`}
                      </span>
                    ))}
                  </li>
                );
              })}
            </ul>
          </section>
        ))
      )}
    </section>
  );
}
