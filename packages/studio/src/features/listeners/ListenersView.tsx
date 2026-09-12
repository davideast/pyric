/**
 * Listeners view (feature: Listeners), the Traffic tab strip's fourth view.
 *
 * Built as a Traffic data journal, the same shape the Billable metrics and
 * Rules tabs use (`traffic/TrafficMetricsViews.tsx`): the finding leads, the
 * card strip states the direct totals and doubles as the row filter, the
 * delivery chart is supporting evidence, the list is the detail, and the
 * source boundary sits in the footer with the methodology on demand. It is
 * styled by `traffic/traffic.css`, not a stylesheet of its own.
 *
 * The list deviates from the Timeline's log in exactly one way: a listener is
 * a standing thing rather than an event, so the columns are owner, target,
 * service, attach age, deliveries, and incident, and the rows group under the
 * owner holding them. The row markup, its data attributes, and the inspector
 * follow the Timeline's conventions so the same CSS and the same test hooks
 * apply.
 *
 * Presentational: takes the event snapshot, the window, and the deep-link
 * inputs as props so it renders without Studio's environment wiring in tests.
 * `ListenersSurface.tsx` is the thin wrapper that reads the live stream and
 * the routed query.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  TrafficLineChart,
  TrafficMetricCards,
  type MetricSeries,
  type TimeWindow,
} from '@pyric/ui/traffic';
import { activeListeners, type ActiveListener, type SandboxEvent } from 'pyric/sandbox';
import { pushPath } from '../../shell/router.js';
import {
  componentOwnerOf,
  elementOf,
  formatListenerTarget,
  frameOwnerOf,
  groupListeners,
  tagOwnerOf,
  type ListenerFilters,
} from './listener-groups.js';
import {
  COLLAPSE_GROUPS_ABOVE,
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
import { latestListenerDelivery } from './listener-delivery-docs.js';
import { DeliveredPathLine } from './DeliveredPaths.js';
import { listenerDrillHref, listenerDrillTarget } from './listener-links.js';
import { formatAgo, formatIncident } from './listener-vocabulary.js';
import { listenerIncidents, repeatedReadIncidents } from './listener-incidents.js';
import { listenerStory } from './listener-story.js';

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

const COLUMNS: ReadonlyArray<{ id: ListenerSortColumn; label: string }> = [
  { id: 'owner', label: 'Owner' },
  { id: 'target', label: 'Target' },
  { id: 'service', label: 'Service' },
  { id: 'attached', label: 'Attached' },
  { id: 'deliveries', label: 'Deliveries' },
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
  if (shape.points === '') {
    return <p className="traffic__inspector-missing">No deliveries in this session yet.</p>;
  }
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

/** How many delivered paths the inspector lists before it defers to the
 *  drill-in page. Six lines is the most that reads as a glance. */
const DELIVERED_LINE_CAP = 6;

/** The newest delivery's paths, linked to the records the callback received.
 *  Past the cap the block says how many it is not showing and hands the
 *  reader the page that shows them all. */
function DeliveredBlock({
  listener,
  events,
}: {
  listener: ActiveListener;
  events: readonly SandboxEvent[];
}) {
  const delivery = useMemo(
    () => latestListenerDelivery(events, listener.id),
    [events, listener.id],
  );
  if (delivery === undefined) {
    return (
      <p className="traffic__inspector-missing" data-pyric-listener-delivered-empty="">
        No deliveries yet.
      </p>
    );
  }
  if (delivery.docs.length === 0) {
    return (
      <p className="traffic__inspector-missing" data-pyric-listener-delivered-empty="">
        Delivered an empty result.
      </p>
    );
  }
  const shown = delivery.docs.slice(0, DELIVERED_LINE_CAP);
  const hidden = delivery.docs.length - shown.length;
  return (
    <div className="traffic__listener-docs" data-pyric-listener-docs="">
      {shown.map((doc) => (
        <DeliveredPathLine key={doc.path} doc={doc} service={listener.service} />
      ))}
      {hidden > 0 ? (
        <a
          className="traffic__listener-doc-more"
          href={listenerDrillHref(listener.id)}
          data-pyric-listener-doc-more=""
          onClick={(event) => {
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
            event.preventDefault();
            pushPath(listenerDrillTarget(listener.id));
          }}
        >
          and {formatCount(hidden)} more
        </a>
      ) : null}
    </div>
  );
}

/** One labelled field in the inspector grid. */
function InspectorField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="traffic__listener-field">
      <span className="traffic__inspector-title">{label}</span>
      <div>{children}</div>
    </div>
  );
}

/** The inspector beneath a selected row: who owns the listener in full, where
 *  it was opened, the target as written, and its delivery history. */
function ListenerInspector({
  listener,
  events,
  onClose,
}: {
  listener: ActiveListener;
  events: readonly SandboxEvent[];
  onClose: () => void;
}) {
  const component = componentOwnerOf(listener.owners);
  const tag = tagOwnerOf(listener.owners);
  const frame = frameOwnerOf(listener.owners);
  const element = elementOf(listener.owners);
  return (
    <div className="traffic__inspector" data-pyric-listener-inspector="">
      <div className="traffic__inspector-bar">
        <a
          className="traffic__inspector-title"
          href={listenerDrillHref(listener.id)}
          data-pyric-listener-drill=""
          onClick={(event) => {
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
            event.preventDefault();
            pushPath(listenerDrillTarget(listener.id));
          }}
        >
          Listener
        </a>
        <span className="traffic__listener-mono">{formatListenerTarget(listener.target)}</span>
        <button
          type="button"
          className="traffic__inspector-close"
          onClick={onClose}
          aria-label="Close the listener inspector"
        >
          close
        </button>
      </div>
      <div className="traffic__listener-fields">
        {component ? (
          <InspectorField label="Component">
            {component.name}
            {component.path && component.path.length > 0 ? (
              <span className="traffic__listener-path">{component.path.join(' › ')}</span>
            ) : null}
          </InspectorField>
        ) : null}
        {tag ? <InspectorField label="Tag">{tag.name}</InspectorField> : null}
        {element !== undefined ? (
          <InspectorField label="Element">
            <span className="traffic__listener-mono">{element}</span>
          </InspectorField>
        ) : null}
        {frame ? (
          <InspectorField label="Opened at">
            <span className="traffic__listener-mono">{`${frame.file}:${frame.line}`}</span>
          </InspectorField>
        ) : null}
        <div className="traffic__listener-field traffic__listener-field--wide">
          <span className="traffic__inspector-title">Delivered</span>
          <div>
            <DeliveredBlock listener={listener} events={events} />
          </div>
        </div>
        <InspectorField label="Target">
          <span className="traffic__listener-mono">{formatListenerTarget(listener.target)}</span>
        </InspectorField>
        <InspectorField label="Deliveries">
          <DeliverySparkline events={events} listenerId={listener.id} />
        </InspectorField>
        <InspectorField label="Rendered after each delivery">
          <p className="traffic__inspector-missing" data-pyric-listener-rendered="">
            Not recorded yet.
          </p>
        </InspectorField>
      </div>
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
  const [expandedRows, setExpandedRows] = useState<readonly string[]>([]);
  const [collapsedGroups, setCollapsedGroups] = useState<readonly string[] | null>(null);
  const [hiddenCards, setHiddenCards] = useState<readonly string[]>([]);
  const selectedRef = useRef<HTMLButtonElement | null>(null);

  const listeners = useMemo(() => {
    const attached = activeListeners(events);
    return hideStudio ? attached.filter((l) => l.actor.kind !== 'studio') : attached;
  }, [events, hideStudio]);
  const incidents = useMemo(() => listenerIncidents(events), [events]);
  const repeatedReads = useMemo(() => repeatedReadIncidents(incidents), [incidents]);
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

  const story = useMemo(() => listenerStory(listenerFold(rowGroups, incidents)), [
    rowGroups,
    incidents,
  ]);
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

  // Past the threshold the group labels carry the list, so groups arrive
  // closed; a reader who opens one keeps it open (the explicit set below
  // takes over from the default the moment they touch anything).
  const startsCollapsed = rowGroups.length > COLLAPSE_GROUPS_ABOVE;
  const isCollapsed = (key: string) =>
    collapsedGroups === null ? startsCollapsed : collapsedGroups.includes(key);
  const toggleGroup = (key: string) => {
    const current =
      collapsedGroups ?? (startsCollapsed ? rowGroups.map((group) => group.identity.key) : []);
    setCollapsedGroups(
      current.includes(key) ? current.filter((k) => k !== key) : [...current, key],
    );
  };
  const toggleRowExpanded = (key: string) =>
    setExpandedRows((current) =>
      current.includes(key) ? current.filter((k) => k !== key) : [...current, key],
    );

  // The deep link selects the row, expands its duplicates, opens the group it
  // sits in, and scrolls to it. It runs on the id, so back/forward and a
  // second chip click both move the selection.
  const selectedRowKey = useMemo(() => {
    if (selectedListenerId === undefined) return undefined;
    for (const group of rowGroups) {
      for (const row of group.rows) {
        if (row.listeners.some((listener) => listener.id === selectedListenerId)) {
          return { group: group.identity.key, row: row.key };
        }
      }
    }
    return undefined;
  }, [selectedListenerId, rowGroups]);

  useEffect(() => {
    if (selectedListenerId === undefined) return;
    setSelectedId(selectedListenerId);
    if (selectedRowKey !== undefined) {
      setExpandedRows((current) =>
        current.includes(selectedRowKey.row) ? current : [...current, selectedRowKey.row],
      );
      setCollapsedGroups((current) =>
        current === null ? null : current.filter((key) => key !== selectedRowKey.group),
      );
    }
    selectedRef.current?.scrollIntoView({ block: 'center' });
  }, [selectedListenerId, selectedRowKey]);

  const selected = listeners.find((listener) => listener.id === selectedId);
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

  function renderRow(row: ListenerRow, listener: ActiveListener, nested: boolean) {
    const isSelected = listener.id === selectedId;
    const deliveryCount = nested ? deliveriesInWindow.get(listener.id) ?? 0 : row.deliveryCount;
    return (
      <li
        key={nested ? `${row.key}|${listener.id}` : row.key}
        data-pyric-listener-entry=""
        data-pyric-listener-nested={nested ? '' : undefined}
      >
        <div className="traffic__listener-line">
          <button
            type="button"
            className="traffic__listener-row"
            ref={isSelected ? selectedRef : undefined}
            data-pyric-listener-row=""
            data-pyric-listener-id={listener.id}
            data-pyric-selected={isSelected ? '' : undefined}
            data-pyric-incident={row.incidents.length > 0 && !nested ? '' : undefined}
            onClick={() => setSelectedId(isSelected ? undefined : listener.id)}
          >
            <span data-pyric-listener-owner="">{nested ? '' : row.ownerLabel}</span>
            <span data-pyric-listener-target="" title={row.target}>
              {row.target}
            </span>
            <span data-pyric-traffic-service={listener.service}>{listener.service}</span>
            <span data-pyric-listener-attached="">{formatAgo(listener.attachedAt, clock)}</span>
            <span data-pyric-listener-deliveries="">{formatCount(deliveryCount)}</span>
            <span data-pyric-listener-incident="">
              {nested
                ? null
                : row.incidents.map((incident) => (
                    <span key={incident.fingerprint} className="traffic__listener-badge">
                      {formatIncident(incident)}
                    </span>
                  ))}
            </span>
          </button>
          {!nested && row.count > 1 ? (
            <button
              type="button"
              className="traffic__listener-duplicate"
              data-pyric-listener-duplicate={row.key}
              aria-expanded={expandedRows.includes(row.key)}
              onClick={() => toggleRowExpanded(row.key)}
            >
              ×{row.count}
            </button>
          ) : null}
        </div>
        {isSelected ? (
          <ListenerInspector
            listener={listener}
            events={events}
            onClose={() => setSelectedId(undefined)}
          />
        ) : null}
      </li>
    );
  }

  return (
    <div className="traffic__metrics" data-pyric-ui="traffic-listeners-view">
      <section className="traffic__metric-panel traffic__metric-panel--journal">
        <header className="traffic__metric-story">
          <p className="traffic__metric-eyebrow">Listener activity</p>
          <h3 className="traffic__metric-headline">{story.headline}</h3>
          <p className="traffic__metric-finding">{story.finding}</p>
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

        {repeatedReads.length > 0 ? (
          <p className="traffic__listener-note" data-pyric-listener-repeated-read="">
            {repeatedReads.map((incident) => formatIncident(incident)).join(' · ')}
          </p>
        ) : null}

        <div
          className="traffic__filters traffic__filters--listeners"
          role="group"
          aria-label="Listener filters"
        >
          <label className="traffic__filter-field">
            <span className="traffic__filters-label">service</span>
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
            <span className="traffic__filters-label">target</span>
            <input
              className="traffic__filter-input"
              type="text"
              value={targetPrefix}
              onChange={(event) => setTargetPrefix(event.target.value)}
              placeholder="collection or path"
            />
          </label>
        </div>

        {listeners.length === 0 ? (
          <p className="traffic__empty" data-pyric-listener-empty="">
            No listeners attached.
          </p>
        ) : visibleGroups.length === 0 ? (
          <p className="traffic__empty" data-pyric-listener-empty="">
            No listeners match these filters.
          </p>
        ) : (
          <div className="traffic__log" data-pyric-ui="traffic-listeners-log">
            <div className="traffic__listener-head" data-pyric-listener-head="" role="row">
              {COLUMNS.map((column) => (
                <button
                  key={column.id}
                  type="button"
                  role="columnheader"
                  className="traffic__listener-column"
                  data-pyric-listener-column={column.id}
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
              <ul
                key={group.identity.key}
                className="traffic__listener-group"
                data-pyric-listener-group={group.identity.key}
              >
                <li data-pyric-listener-group-entry="">
                  <button
                    type="button"
                    className="traffic__listener-group-header"
                    data-pyric-listener-group-header=""
                    aria-expanded={!isCollapsed(group.identity.key)}
                    onClick={() => toggleGroup(group.identity.key)}
                  >
                    <span className="traffic__listener-group-label">{group.identity.label}</span>
                    <span aria-hidden="true">·</span>
                    <span>{group.listenerCount}</span>
                    {group.identity.subtitle !== undefined ? (
                      <span className="traffic__listener-path">{group.identity.subtitle}</span>
                    ) : null}
                  </button>
                </li>
                {isCollapsed(group.identity.key)
                  ? null
                  : group.rows.flatMap((row) => {
                      const rendered = [renderRow(row, row.listener, false)];
                      if (row.count > 1 && expandedRows.includes(row.key)) {
                        for (const listener of row.listeners) {
                          rendered.push(renderRow(row, listener, true));
                        }
                      }
                      return rendered;
                    })}
              </ul>
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
                A listener is attached when the sandbox recorded its{' '}
                <code>attach</code> and has not recorded a <code>detach</code> or an error for
                it since. The count is that fold, not the number of attach events.
              </p>
              <p>
                <strong>Owners come from the attach, deliveries from the window.</strong> The
                owner is the React component the listener was opened in, else the tag the app
                gave it, else the target itself. Two listeners on the same target under the same
                owner are one thing attached twice, so they collapse into one row. Delivery
                counts cover the displayed window only; a listener with none is idle, not gone.
              </p>
            </div>
          </details>
        </footer>
      </section>
    </div>
  );
}
