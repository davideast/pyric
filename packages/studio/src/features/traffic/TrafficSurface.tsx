/**
 * Traffic surface (S-TRAFFIC): `mocks/c-traffic.html` as a live surface.
 *
 * Parts, all `@pyric/ui/traffic` plus the verdict slice (specs/traffic.md MVP):
 *   1. `TrafficTimeline`, the volume-over-time histogram (the time axis that
 *      makes traffic feel like traffic). Denies stack dark at the base of each
 *      bar; a live edge marks "now".
 *   2. A compact filter row (verdict), single row per the spec's filter
 *      contract.
 *   3. The request stream (grouped via `useTrafficGroups`), each row carrying a
 *      VERDICT pill — allow | deny | bypassed | blank for
 *      non-rule ops — derived from fields the events already carry
 *      (`verdict.ts`). Clicking a RULES-EVALUATED row (allow or deny —
 *      `opensRulesInspector`) EXPANDS IN PLACE (disclosure, no modal) into the
 *      RULES INSPECTOR detail (features/rules-debug): the deciding rule per
 *      service, request.auth, the data the rule saw, and the capability-gated
 *      re-runs. Bypassed and blank-verdict rows (no rules decision to
 *      inspect) navigate to the record the op touched (`subjectTarget` → the
 *      route codec) instead.
 *
 * The inspected op lives in the URL (`?inspect=<id>`, the key `shell/path.ts`
 * documents and the command palette targets), so an inspection view is
 * linkable and back/forward work. Esc (or the close control, or re-clicking
 * the row) returns to the log. A deep-linked id that isn't in the current
 * buffer renders a calm "not in this session's traffic" state.
 *
 * Data is the request/operation slice of the unified event stream (the
 * dev-seed drives real allow/deny ops; `dev --ui` streams live).
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
import { useStudioTraffic, STUDIO_EVENT_CAP } from '../../shell/studio-data.js';
import { currentPath, pushPath, subscribeToLocation } from '../../shell/router.js';
import {
  filterByVerdict,
  filterStudioTraffic,
  opensRulesInspector,
  subjectTarget,
  verdictFor,
  VERDICT_FILTERS,
  type StudioTrafficEvent,
  type VerdictFilter,
} from './verdict.js';
import { queryWithInspect, selectedInspectId, toggleInspect } from './inspect-selection.js';
import { TrafficRulesInspector } from './TrafficRulesInspector.js';
import { BillableMetricsView, SubscriptionsRulesView } from './TrafficMetricsViews.js';
import './traffic.css';

/** The Traffic tab strip's three views (Firebase Console "Usage" reference:
 *  Timeline / Billable metrics / Subscriptions & Rules), deep-linkable via
 *  `?view=` (omitted for the default `timeline`, matching the `inspect`
 *  param's drop-when-empty precedent in `shell/path.ts`). */
export type TrafficTab = 'timeline' | 'billable' | 'subscriptions';
const TRAFFIC_TABS: ReadonlyArray<{ id: TrafficTab; label: string }> = [
  { id: 'timeline', label: 'Timeline' },
  { id: 'billable', label: 'Billable metrics' },
  { id: 'subscriptions', label: 'Subscriptions & Rules' },
];

function deriveTrafficTab(): TrafficTab {
  const { tab, query } = currentPath();
  if (tab !== 'traffic') return 'timeline';
  const v = query.view;
  return v === 'billable' || v === 'subscriptions' ? v : 'timeline';
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

/** The per-row verdict cell (blank for non-rule ops). */
function VerdictCell({ event }: { event: StudioTrafficEvent }) {
  const v = verdictFor(event);
  if (!v) return null;
  return (
    <span className="traffic__verdict" data-verdict={v}>
      {v}
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

export function TrafficSurface() {
  const allEvents = useStudioTraffic();
  const [tab, setTab] = useTrafficTab();
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
  const expandedId = useInspectParam();
  const [visibleRows, setVisibleRows] = useState(PAGE_SIZE);

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

  // Newest-first stream; verdict filter first, then grouping (the volume
  // reducer: storms → one row).
  const ordered = useMemo(
    () => filterByVerdict(events, verdictFilter).sort((a, b) => b.at - a.at),
    [events, verdictFilter],
  );
  const { items } = useTrafficGroups({ events: ordered });
  const visibleItems = items.slice(0, visibleRows);
  const hiddenCount = items.length - visibleItems.length;
  const atCap = events.length >= STUDIO_EVENT_CAP;

  const denied = events.filter((e) => e.result === 'deny').length;

  const verdictBadge = (event: StudioTrafficEvent) => <VerdictCell event={event} />;

  // The row's navigation semantic: a RULES-EVALUATED row (allow or deny)
  // expands in place into the rules inspector — the rules decision IS
  // Traffic's detail; its subject link would hide the why. Admin-bypass and
  // blank-verdict rows have no rules decision to inspect, so they keep the
  // C3 drill-in to the record the op touched.
  const onRowSelect = (e: StudioTrafficEvent) => {
    if (opensRulesInspector(e)) {
      openInspect(e.id);
      return;
    }
    const target = subjectTarget(e);
    if (target) pushPath(target);
  };

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

      {tab === 'billable' ? (
        <BillableMetricsView events={events} window={window} />
      ) : tab === 'subscriptions' ? (
        <SubscriptionsRulesView events={events} window={window} />
      ) : (
        <>
          <TrafficTimeline
            events={events}
            window={window}
            liveAt={window.end}
            bucketCount={36}
            className="traffic__timeline"
            header={
              <div className="traffic__tl-header">
                <span className="traffic__tl-count">
                  {events.length} requests
                  {atCap ? ` (showing latest ${STUDIO_EVENT_CAP})` : ''}
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
            emptyState={
              <p className="traffic__empty">No requests in this window yet.</p>
            }
          />

          <div className="traffic__filters" role="group" aria-label="Traffic filters">
            <span className="traffic__filters-label" aria-hidden="true">
              verdict
            </span>
            {VERDICT_FILTERS.map((f) => (
              <button
                key={f}
                type="button"
                className="traffic__filter"
                aria-pressed={verdictFilter === f}
                onClick={() => setVerdictFilter(f)}
              >
                {f}
              </button>
            ))}
          </div>

          {/* Deep-linked op with no visible row (filtered out, beyond the
              pagination fold, folded into a group, or absent from the buffer):
              the inspector renders standalone above the log. */}
          {expandedId && !expandedRowVisible ? (
            <TrafficRulesInspector
              key={expandedId}
              eventId={expandedId}
              onClose={closeInspect}
            />
          ) : null}

          {items.length === 0 ? (
            <p className="traffic__empty">
              {verdictFilter === 'all'
                ? 'No requests yet. Reads, writes, and listeners against the sandbox stream in live.'
                : `No ${verdictFilter} traffic in this session.`}
            </p>
          ) : (
            <div className="traffic__log" data-pyric-ui="traffic-log" data-pyric-grouped="">
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
                        onSelect={(e) => {
                          const ev = e as StudioTrafficEvent;
                          if (opensRulesInspector(ev)) {
                            openInspect(ev.id);
                            return;
                          }
                          const target = subjectTarget(ev);
                          if (target) pushPath(target);
                        }}
                        renderClassification={(event) =>
                          verdictBadge(event as StudioTrafficEvent)
                        }
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
                        formatTime={defaultFormatTime}
                      />
                      {item.event.id === expandedId &&
                      opensRulesInspector(item.event as StudioTrafficEvent) ? (
                        <TrafficRulesInspector
                          key={expandedId}
                          eventId={expandedId}
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
