/**
 * Listeners view (feature: Listeners), the Traffic tab strip's fourth view.
 *
 * Built as a Traffic data journal, the same shape the Billable metrics and
 * Rules tabs use (`traffic/TrafficMetricsViews.tsx`): the headline leads, the
 * card strip states the direct totals and doubles as the row filter, the
 * delivery chart is supporting evidence, the list is the detail, and the
 * source boundary sits in the footer with the methodology on demand. It is
 * styled by `traffic/traffic.css`, not a stylesheet of its own.
 *
 * The list is one grid: the header, each owner's row, and each listener's row
 * share one track list, so a column label sits over its own numbers. An owner
 * heads the run of rows it holds and states its count at the right edge; a
 * target attached more than once is one row carrying `×N`. The inspector opens
 * under the clicked row at the log's full width.
 *
 * Presentational: takes the event snapshot, the window, and the deep-link
 * inputs as props so it renders without Studio's environment wiring in tests.
 * `ListenersSurface.tsx` is the thin wrapper that reads the live stream and
 * the routed query.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  TrafficLineChart,
  TrafficMetricCards,
  type MetricSeries,
  type TimeWindow,
} from '@pyric/ui/traffic';
import { activeListeners, type ActiveListener, type SandboxEvent } from 'pyric/sandbox';
import { pushPath } from '../../shell/router.js';
import { groupListeners, groupIdentityFor, type ListenerFilters } from './listener-groups.js';
import {
  cardKeysForRow,
  listenerCardTotals,
  listenerFold,
  listenerRowGroups,
  nextListenerSort,
  type ListenerRow,
  type ListenerRowGroup,
  type ListenerSort,
  type ListenerSortColumn,
} from './listener-rows.js';
import {
  LISTENER_CARD_DEFS,
  deliveryCountsInWindow,
  deliveryMetrics,
  listenerCardSeries,
} from './listener-metrics.js';
import { deliverySparkline, deliveryTimestamps } from './listener-deliveries.js';
import {
  distinctDeliveredPaths,
  listenerDeliveryHistory,
} from './listener-delivery-docs.js';
import { DeliveryBlock } from './DeliveryBlock.js';
import { IncidentBlock } from './IncidentBlock.js';
import { elementLabel } from './listener-element.js';
import { listenerDrillTarget } from './listener-links.js';
import {
  listenerFactLine,
  listenerHeadline,
  listenerOwnerFact,
  serviceWord,
} from './listener-facts.js';
import { formatAgo } from './listener-vocabulary.js';
import { listenerIncidents } from './listener-incidents.js';

const countFormatter = new Intl.NumberFormat();
const timeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit',
});

function formatCount(value: number): string {
  return countFormatter.format(value);
}

function formatTime(value: number): string {
  return timeFormatter.format(value);
}

/** The grid's columns, in order. The incident mark heads an unlabelled
 *  column: a `⚠` needs no word over it, and it still sorts. */
const COLUMNS: ReadonlyArray<{ id: ListenerSortColumn; label: string; name: string }> = [
  { id: 'incident', label: '', name: 'Incidents' },
  { id: 'target', label: 'Target', name: 'Target' },
  { id: 'deliveries', label: 'Deliveries', name: 'Deliveries' },
  { id: 'attached', label: 'Attached', name: 'Attached' },
  { id: 'service', label: 'Service', name: 'Service' },
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

/** The delivery history of one listener, as a small inline polyline. No chart
 *  library: the shape is a handful of numbers the pure module already built. */
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
  if (shape.points === '') return null;
  return (
    <svg
      className="traffic__listener-sparkline"
      viewBox="0 0 120 24"
      preserveAspectRatio="none"
      role="img"
      aria-label={`Delivery history, peak ${shape.peak} per interval`}
      data-pyric-listener-sparkline=""
    >
      <polyline points={shape.points} fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

/** One of the inspector's three numbers. */
function InspectorFigure({ metric, label, value }: { metric: string; label: string; value: number }) {
  return (
    <span className="traffic__listener-figure" data-pyric-inspector-figure={metric}>
      <span className="traffic__listener-figure-label">{label}</span>
      <span className="traffic__listener-figure-value">{formatCount(value)}</span>
    </span>
  );
}

/**
 * The inspector under a selected row, at the log's full width: the incident
 * first when there is one, then the listener's facts, its three numbers, and
 * the delivery it last made.
 */
function ListenerInspector({
  listener,
  row,
  events,
  now,
  onClose,
}: {
  listener: ActiveListener;
  row: ListenerRow;
  events: readonly SandboxEvent[];
  now: number;
  onClose: () => void;
}) {
  const history = useMemo(
    () => listenerDeliveryHistory(events, listener.id),
    [events, listener.id],
  );
  const latest = history[history.length - 1];
  const element = elementLabel(listener.owners);
  const facts: {
    owner?: string;
    element?: string;
    service: ActiveListener['service'];
    attachedAt: number;
  } = { service: listener.service, attachedAt: listener.attachedAt };
  facts.owner = groupIdentityFor(listener).label;
  if (element !== undefined) facts.element = element;
  const incident = row.incidents[0];
  return (
    <div className="traffic__inspector" data-pyric-listener-inspector="">
      <div className="traffic__inspector-bar">
        <span className="traffic__listener-inspector-target" data-pyric-inspector-title="">
          {row.target}
        </span>
        <button
          type="button"
          className="traffic__listener-open"
          data-pyric-inspector-open=""
          onClick={() => pushPath(listenerDrillTarget(listener.id))}
        >
          Open ↗
        </button>
        <button
          type="button"
          className="traffic__inspector-close"
          data-pyric-inspector-close=""
          onClick={onClose}
          aria-label="Close the listener inspector"
        >
          ✕
        </button>
      </div>
      {incident === undefined ? null : (
        <IncidentBlock incident={incident} listener={listener} events={events} now={now} />
      )}
      <p className="traffic__listener-facts" data-pyric-inspector-facts="">
        {listenerFactLine(facts, now)}
      </p>
      <div className="traffic__listener-figures">
        <InspectorFigure metric="deliveries" label="Deliveries" value={history.length} />
        <InspectorFigure
          metric="documents"
          label="Documents"
          value={distinctDeliveredPaths(history)}
        />
        <InspectorFigure
          metric="suppressed"
          label="Suppressed"
          value={listener.suppressedCount}
        />
        <DeliverySparkline events={events} listenerId={listener.id} />
      </div>
      {latest === undefined ? null : (
        <DeliveryBlock delivery={latest} service={listener.service} />
      )}
    </div>
  );
}

export interface ListenersViewProps {
  events: readonly SandboxEvent[];
  /** The window the Traffic surface computed; deliveries are counted in it. */
  window: TimeWindow;
  selectedListenerId?: string;
  initialTargetPrefix?: string;
  /** The Traffic surface's `Hide Studio traffic` toggle, applied to listeners
   *  Studio itself opened. */
  hideStudio?: boolean;
  /** The clock the relative times are read against; defaults to now. Tests
   *  pass a fixed value so `24m ago` is a fact, not a race. */
  now?: number;
}

export function ListenersView({
  events,
  window,
  selectedListenerId,
  initialTargetPrefix,
  hideStudio = false,
  now,
}: ListenersViewProps) {
  const [service, setService] = useState<ActiveListener['service'] | ''>('');
  const [targetPrefix, setTargetPrefix] = useState(initialTargetPrefix ?? '');
  const [sort, setSort] = useState<ListenerSort | undefined>(undefined);
  const [selectedId, setSelectedId] = useState<string | undefined>(selectedListenerId);
  const [hiddenCards, setHiddenCards] = useState<readonly string[]>([]);
  const selectedRef = useRef<HTMLButtonElement | null>(null);

  const listeners = useMemo(() => {
    const attached = activeListeners(events);
    return hideStudio ? attached.filter((l) => l.actor.kind !== 'studio') : attached;
  }, [events, hideStudio]);
  const incidents = useMemo(() => listenerIncidents(events), [events]);
  const deliveriesInWindow = useMemo(
    () => deliveryCountsInWindow(events, window),
    [events, window],
  );

  const rowGroups = useMemo(
    () =>
      listenerRowGroups(
        groupListeners(listeners, listenerFiltersFor(service, targetPrefix)),
        incidents,
        sort,
        (listener) => deliveriesInWindow.get(listener.id) ?? 0,
      ),
    [listeners, service, targetPrefix, incidents, sort, deliveriesInWindow],
  );

  const fold = useMemo(() => listenerFold(rowGroups, incidents), [rowGroups, incidents]);
  const cardSeries = useMemo<MetricSeries[]>(
    () => listenerCardSeries(listenerCardTotals(rowGroups)),
    [rowGroups],
  );
  const deliveries = useMemo(
    () => deliveryMetrics(events, listeners, window),
    [events, listeners, window],
  );

  const visibleCards = useMemo(
    () =>
      new Set<string>(
        LISTENER_CARD_DEFS.map((def) => def.key).filter((key) => !hiddenCards.includes(key)),
      ),
    [hiddenCards],
  );
  const toggleCard = (key: string) =>
    setHiddenCards((current) =>
      current.includes(key) ? current.filter((k) => k !== key) : [...current, key],
    );

  const clock = now ?? Date.now();

  // A row stands for every listener collapsed into it, so a deep link to a
  // duplicate's second listener selects the row that holds it.
  const linkedRowListenerId = useMemo(() => {
    if (selectedListenerId === undefined) return undefined;
    for (const group of rowGroups) {
      for (const row of group.rows) {
        if (row.listeners.some((listener) => listener.id === selectedListenerId)) {
          return row.listener.id;
        }
      }
    }
    return selectedListenerId;
  }, [selectedListenerId, rowGroups]);

  // The deep link selects the row and scrolls to it. It runs on the id, so
  // back/forward and a second chip click both move the selection.
  useEffect(() => {
    if (linkedRowListenerId === undefined) return;
    setSelectedId(linkedRowListenerId);
    selectedRef.current?.scrollIntoView({ block: 'center' });
  }, [linkedRowListenerId]);

  const visibleGroups = useMemo<readonly ListenerRowGroup[]>(
    () =>
      rowGroups
        .map((group) => ({
          ...group,
          rows: group.rows.filter((row) =>
            cardKeysForRow(row).some((key) => visibleCards.has(key)),
          ),
        }))
        .filter((group) => group.rows.length > 0),
    [rowGroups, visibleCards],
  );

  function renderRow(row: ListenerRow) {
    const listener = row.listener;
    const isSelected = listener.id === selectedId;
    return (
      <div className="traffic__listener-entry" key={row.key} data-pyric-listener-entry="">
        <button
          type="button"
          className="traffic__listener-row"
          ref={isSelected ? selectedRef : undefined}
          data-pyric-listener-row=""
          data-pyric-listener-id={listener.id}
          data-pyric-selected={isSelected ? '' : undefined}
          data-pyric-incident={row.incidents.length > 0 ? '' : undefined}
          onClick={() => setSelectedId(isSelected ? undefined : listener.id)}
        >
          <span data-col="incident" aria-hidden="true">
            {row.incidents.length > 0 ? '⚠' : ''}
          </span>
          <span data-col="target" title={row.target}>
            <span className="traffic__listener-target-text">{row.target}</span>
            {row.count > 1 ? (
              <span className="traffic__listener-duplicate" data-pyric-listener-duplicate="">
                ×{row.count}
              </span>
            ) : null}
          </span>
          <span data-col="deliveries">{formatCount(row.deliveryCount)}</span>
          <span data-col="attached">{formatAgo(listener.attachedAt, clock)}</span>
          <span data-col="service">{serviceWord(listener.service)}</span>
        </button>
        {isSelected ? (
          <ListenerInspector
            listener={listener}
            row={row}
            events={events}
            now={clock}
            onClose={() => setSelectedId(undefined)}
          />
        ) : null}
      </div>
    );
  }

  const ownerFact = listenerOwnerFact(fold);

  return (
    <div className="traffic__metrics" data-pyric-ui="traffic-listeners-view">
      <section className="traffic__metric-panel traffic__metric-panel--journal">
        <header className="traffic__metric-story">
          <p className="traffic__metric-eyebrow">Listener activity</p>
          <h3 className="traffic__metric-headline">{listenerHeadline(fold)}</h3>
          {ownerFact === undefined ? null : (
            <p className="traffic__metric-finding" data-pyric-listener-owner-fact="">
              {ownerFact}
            </p>
          )}
        </header>

        <TrafficMetricCards
          series={cardSeries}
          visible={visibleCards}
          onToggle={toggleCard}
          formatValue={formatCount}
          className="traffic__metric-cards traffic__metric-cards--journal traffic__metric-cards--3"
        />

        <div className="traffic__metric-evidence">
          <div className="traffic__metric-evidence-header">
            <h4>When deliveries happened</h4>
            <span>
              {formatTime(window.start)}–{formatTime(window.end)}
            </span>
          </div>
          {deliveries.total === 0 ? (
            <p className="traffic__empty">No deliveries in this window.</p>
          ) : (
            <>
              <TrafficLineChart
                points={deliveries.points}
                series={deliveries.series}
                omitZeroSeries
                formatValue={formatCount}
                formatTime={formatTime}
                className="traffic__chart traffic__chart--journal"
              />
              <div className="traffic__metric-axis" aria-hidden="true">
                <span>{formatTime(window.start)}</span>
                <span>{formatTime(window.end)}</span>
              </div>
            </>
          )}
        </div>

        <div
          className="traffic__filters traffic__filters--listeners"
          role="group"
          aria-label="Listener filters"
        >
          <label className="traffic__filter-field">
            <span className="traffic__filters-label">Service</span>
            <select
              className="traffic__filter-select"
              value={service}
              onChange={(event) =>
                setService(event.target.value as ActiveListener['service'] | '')
              }
            >
              <option value="">All</option>
              <option value="firestore">Firestore</option>
              <option value="database">Database</option>
            </select>
          </label>
          <label className="traffic__filter-field">
            <span className="traffic__filters-label">Target</span>
            <input
              className="traffic__filter-input"
              type="text"
              value={targetPrefix}
              onChange={(event) => setTargetPrefix(event.target.value)}
            />
          </label>
        </div>

        {listeners.length === 0 ? null : visibleGroups.length === 0 ? (
          <p className="traffic__empty" data-pyric-listener-empty="">
            No listeners match these filters
          </p>
        ) : (
          <div
            className="traffic__log traffic__listener-grid"
            data-pyric-listener-grid=""
            data-pyric-ui="traffic-listeners-log"
          >
            <div className="traffic__listener-header" data-pyric-listener-header="" role="row">
              {COLUMNS.map((column) => (
                <button
                  key={column.id}
                  type="button"
                  role="columnheader"
                  className="traffic__listener-column"
                  data-col={column.id}
                  aria-label={column.label === '' ? column.name : undefined}
                  aria-sort={ariaSortFor(sort, column.id)}
                  onClick={() => setSort((current) => nextListenerSort(current, column.id))}
                >
                  {column.label}
                  {sort?.column === column.id ? (
                    <span aria-hidden="true">{sort.direction === 'asc' ? '↑' : '↓'}</span>
                  ) : null}
                </button>
              ))}
            </div>
            {visibleGroups.map((group) => (
              <div key={group.identity.key} className="traffic__listener-run">
                <div
                  className="traffic__listener-group"
                  data-pyric-listener-group={group.identity.key}
                >
                  <span data-col="owner">{group.identity.label}</span>
                  <span data-col="count">{formatCount(group.listenerCount)}</span>
                </div>
                {group.rows.map((row) => renderRow(row))}
              </div>
            ))}
          </div>
        )}

        <footer className="traffic__metric-footer">
          <p className="traffic__metric-source">
            Source: sandbox listener events · listeners attached now, deliveries in this window
          </p>
          <details className="traffic__metric-methodology">
            <summary>How this is counted</summary>
            <div>
              <p>
                A listener is attached when the sandbox recorded its <code>attach</code> and has
                not recorded a <code>detach</code> or an error for it since. The count is that
                fold, not the number of attach events.
              </p>
              <p>
                <strong>Owners come from the attach, deliveries from the window.</strong> The
                owner is the React component the listener was opened in, else the tag the app
                gave it, else the target itself. Two listeners on the same target under the same
                owner are one thing attached twice, so they collapse into one row carrying{' '}
                <code>×N</code>. Delivery counts cover the displayed window only; a listener with
                none is idle, not gone.
              </p>
            </div>
          </details>
        </footer>
      </section>
    </div>
  );
}
