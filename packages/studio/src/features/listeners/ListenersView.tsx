/**
 * Listeners view (feature: Listeners), the Traffic tab strip's fourth view.
 *
 * Presentational: takes the event snapshot and the deep-link inputs as props
 * so it can be rendered without Studio's environment/dev-seed wiring in
 * tests. `ListenersSurface.tsx` is the thin wrapper that reads the live
 * stream and the routed query and renders this.
 *
 * One table across both services, one row per target within an owner group.
 * The header stays pinned while the rows scroll, every column sorts on a
 * click, and a selected row opens the detail pane beneath the table.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { activeListeners, type ActiveListener, type SandboxEvent } from 'pyric/sandbox';
import {
  componentOwnerOf,
  elementOf,
  formatListenerTarget,
  frameOwnerOf,
  groupListeners,
  regionsOf,
  tagOwnerOf,
  type ListenerFilters,
} from './listener-groups.js';
import {
  COLLAPSE_GROUPS_ABOVE,
  formatListenerCounts,
  listenerCounts,
  listenerRowGroups,
  nextListenerSort,
  type ListenerRow,
  type ListenerSort,
  type ListenerSortColumn,
} from './listener-rows.js';
import { deliverySparkline, deliveryTimestamps } from './listener-deliveries.js';
import {
  formatActor,
  formatAttached,
  formatDeliveries,
  formatDuplicateRow,
  formatIncident,
  formatLastDelivery,
  formatSuppressed,
} from './listener-vocabulary.js';
import { listenerIncidents, repeatedReadIncidents } from './listener-incidents.js';
import { formatAuthLens } from './listener-identity.js';
import './listeners.css';

const COLUMNS: ReadonlyArray<{ id: ListenerSortColumn; label: string }> = [
  { id: 'target', label: 'Target' },
  { id: 'service', label: 'Service' },
  { id: 'actor', label: 'Actor' },
  { id: 'attached', label: 'Attached' },
  { id: 'deliveries', label: 'Deliveries' },
  { id: 'suppressed', label: 'Suppressed' },
  { id: 'lastDelivery', label: 'Last delivery' },
  { id: 'incident', label: 'Incident' },
];

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

function ariaSortFor(sort: ListenerSort | undefined, column: ListenerSortColumn) {
  if (sort?.column !== column) return 'none' as const;
  return sort.direction === 'asc' ? ('ascending' as const) : ('descending' as const);
}

/** The delivery history of the selected row, as a small inline polyline. */
function DeliverySparkline({
  events,
  listenerId,
}: {
  events: readonly SandboxEvent[];
  listenerId: string;
}) {
  const shape = useMemo(
    () => deliverySparkline(deliveryTimestamps(events, listenerId)),
    [events, listenerId],
  );
  if (shape.points === '') {
    return <p className="listeners__detail-empty">No deliveries in this session yet.</p>;
  }
  return (
    <svg
      className="listeners__sparkline"
      viewBox="0 0 120 24"
      preserveAspectRatio="none"
      role="img"
      aria-label={`Delivery history, peak ${shape.peak} per interval`}
      data-testid="listener-sparkline"
    >
      <polyline points={shape.points} fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

/** Every owner of one listener, written out in full. */
function ListenerOwners({ listener }: { listener: ActiveListener }) {
  const component = componentOwnerOf(listener.owners);
  const tag = tagOwnerOf(listener.owners);
  const frame = frameOwnerOf(listener.owners);
  const regions = regionsOf(listener.owners);
  const element = elementOf(listener.owners);
  return (
    <dl className="listeners__owners">
      {component ? (
        <>
          <dt>Component</dt>
          <dd>
            {component.name}
            {component.path && component.path.length > 0 ? (
              <span className="listeners__owner-path">{component.path.join(' › ')}</span>
            ) : null}
          </dd>
        </>
      ) : null}
      {tag ? (
        <>
          <dt>Tag</dt>
          <dd>{tag.name}</dd>
        </>
      ) : null}
      {element !== undefined ? (
        <>
          <dt>Element</dt>
          <dd className="listeners__mono">{element}</dd>
        </>
      ) : null}
      {frame ? (
        <>
          <dt>Frame</dt>
          <dd className="listeners__mono">{`${frame.file}:${frame.line}`}</dd>
        </>
      ) : null}
      {regions.length > 0 ? (
        <>
          <dt>Regions</dt>
          <dd className="listeners__mono">{regions.join(', ')}</dd>
        </>
      ) : null}
      <dt>Target</dt>
      <dd className="listeners__mono">{formatListenerTarget(listener.target)}</dd>
      <dt>Identity</dt>
      <dd>{formatAuthLens(listener.authLens)}</dd>
    </dl>
  );
}

function ListenerDetail({
  listener,
  events,
}: {
  listener: ActiveListener;
  events: readonly SandboxEvent[];
}) {
  return (
    <section className="listeners__detail" data-testid="listener-detail">
      <h3 className="listeners__detail-title">{formatListenerTarget(listener.target)}</h3>
      <ListenerOwners listener={listener} />
      <div className="listeners__detail-slot">
        <h4 className="listeners__detail-heading">Delivery history</h4>
        <DeliverySparkline events={events} listenerId={listener.id} />
      </div>
      <div className="listeners__detail-slot" data-testid="listener-rendered-components">
        <h4 className="listeners__detail-heading">Components that rendered after each delivery</h4>
        <p className="listeners__detail-empty">Not recorded yet.</p>
      </div>
    </section>
  );
}

export interface ListenersViewProps {
  events: readonly SandboxEvent[];
  selectedListenerId?: string;
  initialTargetPrefix?: string;
  /** The clock the relative times are read against; defaults to now. Tests
   *  pass a fixed value so `attached 12s ago` is a fact, not a race. */
  now?: number;
}

export function ListenersView({
  events,
  selectedListenerId,
  initialTargetPrefix,
  now,
}: ListenersViewProps) {
  const [service, setService] = useState<ActiveListener['service'] | ''>('');
  const [targetPrefix, setTargetPrefix] = useState(initialTargetPrefix ?? '');
  const [sort, setSort] = useState<ListenerSort | undefined>(undefined);
  const [selectedId, setSelectedId] = useState<string | undefined>(selectedListenerId);
  const [expandedRows, setExpandedRows] = useState<readonly string[]>([]);
  const [collapsedGroups, setCollapsedGroups] = useState<readonly string[] | null>(null);
  const selectedRef = useRef<HTMLTableRowElement | null>(null);

  useEffect(() => {
    if (selectedListenerId === undefined) return;
    setSelectedId(selectedListenerId);
    selectedRef.current?.scrollIntoView({ block: 'center' });
  }, [selectedListenerId]);

  const listeners = activeListeners(events);
  const incidents = listenerIncidents(events);
  const repeatedReads = repeatedReadIncidents(incidents);
  const groups = groupListeners(listeners, listenerFiltersFor(service, targetPrefix));
  const rowGroups = listenerRowGroups(groups, incidents, sort);
  const counts = listenerCounts(listeners, incidents);
  const clock = now ?? Date.now();

  // Past the threshold the group labels carry the table, so groups arrive
  // closed; a reader who opens one keeps it open (the explicit set below
  // takes over from the default the moment they touch anything).
  const startsCollapsed = rowGroups.length > COLLAPSE_GROUPS_ABOVE;
  const isCollapsed = (key: string) =>
    collapsedGroups === null ? startsCollapsed : collapsedGroups.includes(key);
  const toggleGroup = (key: string) => {
    const current = collapsedGroups ?? (startsCollapsed ? rowGroups.map((g) => g.identity.key) : []);
    setCollapsedGroups(
      current.includes(key) ? current.filter((k) => k !== key) : [...current, key],
    );
  };

  const toggleRowExpanded = (key: string) =>
    setExpandedRows((current) =>
      current.includes(key) ? current.filter((k) => k !== key) : [...current, key],
    );

  const selected = listeners.find((listener) => listener.id === selectedId);

  function renderRow(row: ListenerRow, listener: ActiveListener, nested: boolean) {
    const isSelected = listener.id === selectedId;
    const className = [
      'listeners__row',
      nested ? 'listeners__row--nested' : '',
      isSelected ? 'listeners__row--selected' : '',
    ]
      .filter((part) => part !== '')
      .join(' ');
    return (
      <tr
        key={nested ? `${row.key}|${listener.id}` : row.key}
        ref={isSelected ? selectedRef : undefined}
        className={className}
        aria-selected={isSelected}
        data-testid={nested ? `listener-duplicate-row-${listener.id}` : `listener-row-${listener.id}`}
        onClick={() => setSelectedId(isSelected ? undefined : listener.id)}
      >
        <td className="listeners__cell listeners__cell--target">
          <span className="listeners__mono">{row.target}</span>
          {!nested && row.count > 1 ? (
            <button
              type="button"
              className="listeners__duplicate"
              data-testid={`listener-duplicate-${row.key}`}
              aria-expanded={expandedRows.includes(row.key)}
              onClick={(event) => {
                event.stopPropagation();
                toggleRowExpanded(row.key);
              }}
            >
              {formatDuplicateRow(row.count)}
            </button>
          ) : null}
        </td>
        <td className="listeners__cell">{listener.service}</td>
        <td className="listeners__cell">{formatActor(listener)}</td>
        <td className="listeners__cell">{formatAttached(listener.attachedAt, clock)}</td>
        <td className="listeners__cell listeners__cell--number">
          {formatDeliveries(nested ? listener.deliveryCount : row.deliveryCount)}
        </td>
        <td className="listeners__cell listeners__cell--number">
          {formatSuppressed(nested ? listener.suppressedCount : row.suppressedCount)}
        </td>
        <td className="listeners__cell">
          {formatLastDelivery(nested ? listener.lastDeliveryAt : row.lastDeliveryAt, clock)}
        </td>
        <td className="listeners__cell listeners__cell--incident">
          {nested
            ? null
            : row.incidents.map((incident) => (
                <span key={incident.fingerprint} className="listeners__incident">
                  {formatIncident(incident)}
                </span>
              ))}
        </td>
      </tr>
    );
  }

  return (
    <section className="listeners" aria-labelledby="listeners-title">
      <header className="listeners__head">
        <h2 id="listeners-title" className="listeners__title">
          Listeners
        </h2>
        <span className="listeners__counts" data-testid="listener-counts">
          {formatListenerCounts(counts)}
        </span>
      </header>

      {repeatedReads.length > 0 ? (
        <div className="listeners__banner" data-testid="repeated-read-incident">
          {repeatedReads.map((incident) => formatIncident(incident)).join(' · ')}
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

      {rowGroups.length === 0 ? (
        <p className="listeners__empty">No active listeners match this filter.</p>
      ) : (
        <div className="listeners__scroll">
          <table className="listeners__table">
            <thead className="listeners__thead">
              <tr>
                {COLUMNS.map((column) => (
                  <th
                    key={column.id}
                    scope="col"
                    className="listeners__th"
                    aria-sort={ariaSortFor(sort, column.id)}
                  >
                    <button
                      type="button"
                      className="listeners__sort"
                      onClick={() => setSort((current) => nextListenerSort(current, column.id))}
                    >
                      {column.label}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            {rowGroups.map((group) => (
              <tbody key={group.identity.key} className="listeners__group">
                <tr className="listeners__group-row">
                  <th scope="colgroup" colSpan={COLUMNS.length} className="listeners__group-head">
                    <button
                      type="button"
                      className="listeners__group-toggle"
                      aria-expanded={!isCollapsed(group.identity.key)}
                      onClick={() => toggleGroup(group.identity.key)}
                    >
                      <span className="listeners__group-label">{group.identity.label}</span>
                      {group.identity.subtitle !== undefined ? (
                        <span className="listeners__group-subtitle">{group.identity.subtitle}</span>
                      ) : null}
                      <span className="listeners__group-count">{group.listenerCount}</span>
                    </button>
                  </th>
                </tr>
                {isCollapsed(group.identity.key)
                  ? null
                  : group.rows.flatMap((row) => {
                      const rows = [renderRow(row, row.listener, false)];
                      if (row.count > 1 && expandedRows.includes(row.key)) {
                        for (const listener of row.listeners) {
                          rows.push(renderRow(row, listener, true));
                        }
                      }
                      return rows;
                    })}
              </tbody>
            ))}
          </table>
        </div>
      )}

      {selected ? <ListenerDetail listener={selected} events={events} /> : null}
    </section>
  );
}
