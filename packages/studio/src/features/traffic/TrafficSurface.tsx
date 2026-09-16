/** Cross-service requests, timeline, metrics and listeners share one retained event feed.
 * Every request opens a URL-addressable inspector; rules are optional evidence.
 * Grouping, origin filtering and timeline selection remain properties of the list.
 */

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import {
  TrafficGroupRow,
  TrafficRow,
  TrafficTimeline,
  useTrafficGroups,
  defaultFormatTime,
  type TimeWindow,
} from '@pyric/ui/traffic';
import { useStudioTrafficHistory, STUDIO_EVENT_CAP } from '../../shell/studio-events.js';
import { currentPath, pushPath, replacePath, subscribeToLocation } from '../../shell/router.js';
import {
  filterByVerdict,
  filterStudioTraffic,
  verdictFor,
  verdictLabel,
  VERDICT_FILTERS,
  type StudioTrafficEvent,
  type VerdictFilter,
} from './verdict.js';
import { queryWithInspect, selectedInspectId, toggleInspect } from './inspect-selection.js';
import { TrafficRequestInspector, executionOutcome } from './TrafficRequestInspector.js';
import { BillableMetricsView, RulesMetricsView } from './TrafficMetricsViews.js';
import {
  ListenerPageSurface,
  ListenersSurface,
  drilledListenerId,
} from '../listeners/index.js';
import { TRAFFIC_TABS, trafficTabForView, type TrafficTab } from './traffic-tabs.js';
import { trafficTimeFocus, toggleTimeFocus } from './timeline-focus.js';
import './traffic.css';

export type { TrafficTab } from './traffic-tabs.js';

/** The Traffic tab strip's four views (Firebase Console "Usage" reference:
 *  Timeline / Billable metrics / Rules, plus Listeners — every listener the
 *  session holds attached, across services), deep-linkable via
 *  `?view=` (omitted for the default `timeline`, matching the `inspect`
 *  param's drop-when-empty precedent in `shell/path.ts`). */
export function trafficTabForLocation(location: {
  readonly tab: string;
  readonly rest: readonly string[];
  readonly query: Record<string, string | undefined>;
}): TrafficTab {
  if (location.tab !== 'traffic') return 'timeline';
  // `/traffic/listeners/<id>` is a Listeners drill-in, so the Listeners tab
  // stays selected while the page is open.
  if (drilledListenerId(location) !== undefined) return 'listeners';
  return trafficTabForView(location.query.view);
}

function deriveTrafficTab(): TrafficTab {
  return trafficTabForLocation(currentPath());
}

/** The listener the path drills into, when it names one. */
function deriveDrilledListener(): string | undefined {
  const { tab, rest } = currentPath();
  return drilledListenerId({ tab, rest });
}

/** Two-way read of the drilled listener; the page IS the URL (N4). */
function useDrilledListener(): string | undefined {
  return useSyncExternalStore<string | undefined>(
    subscribeToLocation,
    deriveDrilledListener,
    () => undefined,
  );
}

/** Two-way bind the active Traffic tab to `?view=`, mirroring `useDataNav`'s
 *  URL-is-the-store shape (PRINCIPLES N4) at feature scale. */
function useTrafficTab(): readonly [TrafficTab, (tab: TrafficTab) => void] {
  const active = useSyncExternalStore<TrafficTab>(
    subscribeToLocation,
    deriveTrafficTab,
    () => 'timeline',
  );
  const setActive = useCallback((tab: TrafficTab) => {
    // Preserve unrelated query keys (`?hide=studio` must survive a view
    // switch); `?inspect` intentionally drops with the rest replaced only
    // when absent from the merge — spread keeps it too, and that's right:
    // an open inspection belongs to the timeline view the user returns to.
    const query = { ...currentPath().query, view: tab === 'timeline' ? undefined : tab };
    if (query.view === undefined) delete query.view;
    pushPath({ tab: 'traffic', query });
  }, []);
  return [active, setActive] as const;
}

/** Two-way bind the "hide Studio traffic" toggle to `?hide=studio` (N4:
 *  the URL is the store — a filtered view is linkable and survives reload). */
function useHideStudio(): readonly [boolean, () => void] {
  const hide = useSyncExternalStore(
    subscribeToLocation,
    () => currentPath().query.hide === 'studio',
    () => false,
  );
  const toggle = useCallback(() => {
    const query = { ...currentPath().query } as Record<string, string | undefined>;
    if (query.hide === 'studio') delete query.hide;
    else query.hide = 'studio';
    pushPath({ tab: 'traffic', query });
  }, []);
  return [hide, toggle] as const;
}

/** A coarse "Nm ago" for the timeline's left axis tick. */
function relAgo(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

function timelineRangeLabel(window: TimeWindow): string {
  return `${defaultFormatTime(window.start)}–${defaultFormatTime(window.end)}`;
}

/** The per-row verdict cell (blank for non-rule ops). */
function VerdictCell({ event }: { event: StudioTrafficEvent }) {
  const v = verdictFor(event);
  if (!v) return null;
  return (
    <span className="traffic__verdict" data-verdict={v}>
      {verdictLabel(v)}
    </span>
  );
}

/** The URL-driven inspector focus (`?inspect=<id>`): the inspected op's id, or
 *  null. Read reactively so back/forward and palette deep links drive it. */
function useInspectParam(): string | null {
  return useSyncExternalStore(
    subscribeToLocation,
    () => selectedInspectId(currentPath().query),
    () => null,
  );
}

/** Rows rendered before the "Show more" disclosure. Pagination (not
 *  virtualization) is the cheaper L6 fix here: the shell already caps the
 *  stream at {@link STUDIO_EVENT_CAP} events, grouping compresses storms
 *  further, and the rows are variable-height (deny disclosure expands in
 *  place) — which is exactly where list virtualization gets expensive. */
const PAGE_SIZE = 100;

function useRequestFilter(key: string): readonly [string, (value: string) => void] {
  const value = useSyncExternalStore(subscribeToLocation, () => currentPath().query[key] ?? '', () => '');
  const change = (next: string) => {
    const query = queryWithInspect(currentPath().query, null);
    if (next) query[key] = next; else delete query[key];
    replacePath({ tab: 'traffic', query });
  };
  return [value, change];
}

export function TrafficSurface() {
  const { requests: allEvents, omittedCount } = useStudioTrafficHistory();
  const [tab, setTab] = useTrafficTab();
  const drilledListener = useDrilledListener();
  const [hideStudio, toggleHideStudio] = useHideStudio();
  // The Studio filter applies UPSTREAM of everything — timeline buckets,
  // counts, verdict filtering, AND the metrics tabs' aggregations — so
  // "hide Studio traffic" means the numbers agree with the rows.
  const events = useMemo(
    () => filterStudioTraffic(allEvents, hideStudio),
    [allEvents, hideStudio],
  );
  const hiddenStudioCount = allEvents.length - events.length;
  const [verdictFilter, setVerdictFilter] = useState<VerdictFilter>('all');
  const [timeFocus, setTimeFocus] = useState<TimeWindow | null>(null);
  const expandedId = useInspectParam();
  const [visibleRows, setVisibleRows] = useState(PAGE_SIZE);
  const [serviceFilter, setServiceFilter] = useRequestFilter('service');
  const [search, setSearch] = useRequestFilter('q');
  const [outcomeFilter, setOutcomeFilter] = useRequestFilter('outcome');

  // Selecting/closing an inspection NAVIGATES (pushPath) so the view is
  // linkable and back/forward step through inspections; other query keys
  // survive.
  const openInspect = (id: string) => {
    pushPath({ tab: 'traffic', query: toggleInspect(currentPath().query, id) });
  };
  const closeInspect = () => {
    pushPath({ tab: 'traffic', query: queryWithInspect(currentPath().query, null) });
  };

  // Esc returns to the log while the inspector is open. (`globalThis`: the
  // local `window` name below is the timeline's TimeWindow.)
  useEffect(() => {
    if (!expandedId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeInspect();
    };
    globalThis.addEventListener('keydown', onKey);
    return () => globalThis.removeEventListener('keydown', onKey);
    // closeInspect reads the URL at call time; no reactive deps beyond the flag.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expandedId]);

  // The window spans from the earliest request (or 15m back) to just past now,
  // so a fresh session's handful of ops still lands a few buckets from the
  // edge. `Date.now()` is read INSIDE the memo (recomputing when the stream
  // changes) — a per-render read would defeat the memo entirely.
  const window = useMemo<TimeWindow>(() => {
    const now = Date.now();
    if (events.length === 0) return { start: now - 15 * 60_000, end: now };
    let earliest = Infinity;
    for (const e of events) if (e.at < earliest) earliest = e.at;
    return { start: Math.min(earliest, now - 60_000), end: now + 1_000 };
  }, [events]);
  const now = window.end;

  const focusedTraffic = useMemo(
    () => (timeFocus ? trafficTimeFocus(events, timeFocus) : null),
    [events, timeFocus],
  );
  const tableEvents = focusedTraffic?.events ?? events;

  // Newest-first stream; verdict filter first, then grouping (the volume
  // reducer: storms → one row).
  const ordered = useMemo(
    () => filterByVerdict(tableEvents, verdictFilter).filter(event => {
      const serviceMatches = !serviceFilter || (event.service ?? 'firestore') === serviceFilter;
      const searchMatches = `${event.method} ${event.path}`.toLowerCase().includes(search.toLowerCase());
      const outcomeMatches = !outcomeFilter || executionOutcome(event) === outcomeFilter;
      return serviceMatches && searchMatches && outcomeMatches;
    }).sort((a, b) => b.at - a.at),
    [tableEvents, verdictFilter, serviceFilter, search, outcomeFilter],
  );
  const { items } = useTrafficGroups({ events: ordered });
  const visibleItems = items.slice(0, visibleRows);
  const hiddenCount = items.length - visibleItems.length;
  const atCap = events.length >= STUDIO_EVENT_CAP;

  const denied = events.filter((e) => e.result === 'deny').length;

  const requestTarget = (event: StudioTrafficEvent) => {
    const ai = event.observation?.ai;
    if (!ai) return event.path || '/';
    return <span className="traffic__model-route">
      <span><span className="traffic__model-label">Requested</span><span>{ai.requestedModel}</span></span>
      <span><span className="traffic__model-label">Routed</span><span>{ai.routedModel ?? 'Not recorded'}</span></span>
    </span>;
  };

  const verdictBadge = (event: StudioTrafficEvent) => <span className="traffic__outcome"><span>{executionOutcome(event)}</span><span>{event.durationMs === undefined ? 'Duration not recorded' : `${Math.round(event.durationMs)} ms`}</span><VerdictCell event={event} /></span>;

  // Every request opens the same linkable inspector. Rules are optional evidence.
  const onRowSelect = (event: StudioTrafficEvent) => openInspect(event.id);

  // A deep-linked / filtered-out op has no visible row to expand under:
  // detect it so the inspector can render standalone above the log (this also
  // covers an id that isn't in the buffer at all — the inspector shows the
  // calm "not in this session's traffic" state).
  const expandedRowVisible =
    expandedId != null &&
    visibleItems.some((item) => item.type !== 'group' && item.event.id === expandedId);

  return (
    <section data-pyric-ui="traffic-surface" className="traffic">
      <div className="traffic__tabs" role="tablist" aria-label="Traffic views">
        {TRAFFIC_TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            className="traffic__tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
        <button
          type="button"
          className="traffic__hide-studio"
          aria-pressed={hideStudio}
          onClick={toggleHideStudio}
          title="Hide ops issued by Pyric Studio's own viewers and editors"
        >
          Hide Studio traffic
          {hideStudio && hiddenStudioCount > 0 ? ` (${hiddenStudioCount} hidden)` : ''}
        </button>
      </div>

      {drilledListener !== undefined ? (
        <ListenerPageSurface listenerId={drilledListener} window={window} />
      ) : tab === 'billable' ? (
        <BillableMetricsView events={events} window={window} />
      ) : tab === 'rules' ? (
        <RulesMetricsView events={events} window={window} />
      ) : tab === 'listeners' ? (
        <ListenersSurface window={window} hideStudio={hideStudio} />
      ) : (
        <>
          <TrafficTimeline
            events={events}
            window={window}
            brush={timeFocus ?? undefined}
            onBrush={(nextWindow) => {
              setTimeFocus((current) => toggleTimeFocus(current, nextWindow));
              if (expandedId) closeInspect();
            }}
            liveAt={window.end}
            bucketCount={36}
            className="traffic__timeline"
            header={
              <div className="traffic__tl-header">
                <span className="traffic__tl-count">
                  {events.length} requests
                  {atCap ? ` (showing latest ${STUDIO_EVENT_CAP})` : ''}
                  {omittedCount > 0 ? ` · Older history discarded (${omittedCount} events)` : ''}
                </span>
                {denied > 0 ? (
                  <button
                    type="button"
                    className="traffic__tl-deny"
                    aria-pressed={verdictFilter === 'deny'}
                    onClick={() =>
                      setVerdictFilter((f) => (f === 'deny' ? 'all' : 'deny'))
                    }
                    title="Filter the stream to denied requests"
                  >
                    {denied} denied
                  </button>
                ) : null}
                <span className="traffic__tl-live">live</span>
              </div>
            }
            axis={(w) => (
              <div className="traffic__tl-axis">
                <span>{relAgo(w.start, now)}</span>
                <span>now</span>
              </div>
            )}
            renderBucketSummary={(bucket) => (
              <div className="traffic__bucket-summary">
                <span>{timelineRangeLabel(bucket)}</span>
                <strong>
                  {bucket.count} {bucket.count === 1 ? 'request' : 'requests'}
                </strong>
                <span>{bucket.denies} denied</span>
              </div>
            )}
            emptyState={
              <p className="traffic__empty">No requests in this window yet.</p>
            }
          />

          {focusedTraffic ? (
            <section
              className="traffic__time-focus"
              aria-label="Selected traffic interval"
              aria-live="polite"
            >
              <div className="traffic__time-focus-story">
                <p className="traffic__time-focus-eyebrow">Selected interval</p>
                <h3>{timelineRangeLabel(focusedTraffic.window)}</h3>
                <p>{focusedTraffic.finding}</p>
              </div>
              <button type="button" onClick={() => setTimeFocus(null)}>
                Show all traffic
              </button>
            </section>
          ) : null}

          <div className="traffic__filters traffic__filters--requests" role="group" aria-label="Traffic filters">
            <label className="traffic__filter-field">Service <select className="traffic__filter-select" aria-label="Traffic service" value={serviceFilter} onChange={event => setServiceFilter(event.target.value)}>
              {['', 'ai', 'firestore', 'rtdb', 'storage', 'auth'].map(service => <option key={service} value={service}>{service || 'All services'}</option>)}
            </select></label>
            <label className="traffic__filter-field">Outcome <select className="traffic__filter-select" aria-label="Traffic outcome" value={outcomeFilter} onChange={event => setOutcomeFilter(event.target.value)}>
              {['', 'In progress', 'Completed', 'Succeeded', 'Failed', 'Cancelled', 'Interrupted', 'Denied', 'Unsupported', 'Rules evaluated'].map(outcome => <option key={outcome} value={outcome}>{outcome || 'All outcomes'}</option>)}
            </select></label>
            <input className="traffic__filter-input" aria-label="Search traffic" placeholder="Operation or target" value={search} onChange={event => setSearch(event.target.value)} />
            <span className="traffic__filters-label" aria-hidden="true">
              verdict
            </span>
            {VERDICT_FILTERS.map((f) => (
              <button
                key={f}
                type="button"
                className="traffic__filter"
                aria-pressed={verdictFilter === f}
                onClick={() => { closeInspect(); setVerdictFilter(f); }}
              >
                {verdictLabel(f)}
              </button>
            ))}
          </div>

          {/* Deep-linked op with no visible row (filtered out, beyond the
              pagination fold, folded into a group, or absent from the buffer):
              the inspector renders standalone above the log. */}
          {expandedId && !expandedRowVisible ? (
            <TrafficRequestInspector
              key={expandedId}
              event={allEvents.find(event => event.id === expandedId)}
              onClose={closeInspect}
            />
          ) : null}

          {items.length === 0 ? (
            <p className="traffic__empty">
              {focusedTraffic
                ? verdictFilter === 'all'
                  ? 'No requests occurred in the selected interval.'
                  : `No ${verdictFilter} traffic occurred in the selected interval.`
                : verdictFilter === 'all'
                  ? 'No requests yet. Reads, writes, and listeners against the sandbox stream in live.'
                  : `No ${verdictFilter} traffic in this session.`}
            </p>
          ) : (
            <div
              className="traffic__log"
              data-pyric-ui="traffic-log"
              data-pyric-grouped=""
              data-pyric-time-focused={focusedTraffic ? '' : undefined}
            >
              <ul data-pyric-traffic-log-items="">
                {visibleItems.map((item) =>
                  item.type === 'group' ? (
                    <li key={item.key} data-pyric-traffic-group-entry="">
                      <TrafficGroupRow
                        group={item}
                        // Group MEMBERS: rules-evaluated members open the
                        // inspector too — they have no top-level row, so it
                        // renders standalone above the log (the in-place
                        // disclosure renders only on top-level entries — the
                        // library owns member markup). Others navigate to
                        // their subject.
                        onSelect={(event) => openInspect(event.id)}
                        renderClassification={(event) =>
                          verdictBadge(event as StudioTrafficEvent)
                        }
                        renderTarget={event => requestTarget(event as StudioTrafficEvent)}
                        formatTime={defaultFormatTime}
                      />
                    </li>
                  ) : (
                    <li
                      key={item.event.id}
                      data-pyric-traffic-entry=""
                      data-pyric-traffic-id={item.event.id}
                      data-verdict={verdictFor(item.event as StudioTrafficEvent) ?? undefined}
                    >
                      <TrafficRow
                        event={item.event}
                        selected={item.event.id === expandedId}
                        onSelect={(e) => onRowSelect(e as StudioTrafficEvent)}
                        renderClassification={(event) =>
                          verdictBadge(event as StudioTrafficEvent)
                        }
                        renderTarget={event => requestTarget(event as StudioTrafficEvent)}
                        formatTime={defaultFormatTime}
                      />
                      {item.event.id === expandedId ? (
                        <TrafficRequestInspector
                          key={expandedId}
                          event={allEvents.find(event => event.id === expandedId)}
                          onClose={closeInspect}
                        />
                      ) : null}
                    </li>
                  ),
                )}
              </ul>
              {hiddenCount > 0 ? (
                <button
                  type="button"
                  className="traffic__show-more"
                  onClick={() => setVisibleRows((n) => n + PAGE_SIZE)}
                >
                  Show {Math.min(hiddenCount, PAGE_SIZE)} more ({hiddenCount} hidden)
                </button>
              ) : null}
            </div>
          )}
        </>
      )}
    </section>
  );
}
