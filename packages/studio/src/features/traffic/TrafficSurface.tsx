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
 *      VERDICT cell — allow | deny | admin (rules bypassed) | blank for
 *      non-rule ops — derived from fields the events already carry
 *      (`verdict.ts`). Deny rows tint subtly and EXPAND IN PLACE (disclosure,
 *      no modal) with operation, path, acting identity, and the denial
 *      reasons when present.
 *
 * Data is the request/operation slice of the unified event stream (the
 * dev-seed drives real allow/deny ops; `dev --ui` streams live).
 */

import { useMemo, useState } from 'react';
import {
  TrafficGroupRow,
  TrafficRow,
  TrafficTimeline,
  useTrafficGroups,
  defaultFormatTime,
  type TimeWindow,
} from '@pyric/ui/traffic';
import { useStudioTraffic } from '../../shell/studio-data.js';
import {
  actingIdentity,
  denialReasons,
  filterByVerdict,
  verdictFor,
  VERDICT_FILTERS,
  type StudioTrafficEvent,
  type VerdictFilter,
} from './verdict.js';
import './traffic.css';

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

/** In-place deny disclosure: operation, path, acting identity, reasons. */
function DenyDisclosure({ event }: { event: StudioTrafficEvent }) {
  const reasons = denialReasons(event);
  return (
    <div className="traffic__deny-detail" data-pyric-ui="traffic-deny-detail">
      <dl className="traffic__deny-facts">
        <dt>operation</dt>
        <dd>{event.method}</dd>
        <dt>path</dt>
        <dd>{event.path}</dd>
        <dt>acting identity</dt>
        <dd>{actingIdentity(event)}</dd>
      </dl>
      {reasons.length ? (
        <ol className="traffic__deny-reasons">
          {reasons.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

export function TrafficSurface() {
  const events = useStudioTraffic();
  const [verdictFilter, setVerdictFilter] = useState<VerdictFilter>('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const now = Date.now();

  // The window spans from the earliest request (or 15m back) to just past now,
  // so a fresh session's handful of ops still lands a few buckets from the edge.
  const window = useMemo<TimeWindow>(() => {
    if (events.length === 0) return { start: now - 15 * 60_000, end: now };
    const earliest = Math.min(...events.map((e) => e.at));
    return { start: Math.min(earliest, now - 60_000), end: now + 1_000 };
  }, [events, now]);

  // Newest-first stream; verdict filter first, then grouping (the volume
  // reducer: storms → one row).
  const ordered = useMemo(
    () => filterByVerdict(events, verdictFilter).sort((a, b) => b.at - a.at),
    [events, verdictFilter],
  );
  const { items } = useTrafficGroups({ events: ordered });

  const denied = events.filter((e) => e.result === 'deny').length;

  const verdictBadge = (event: StudioTrafficEvent) => <VerdictCell event={event} />;

  return (
    <section data-pyric-ui="traffic-surface" className="traffic">
      <TrafficTimeline
        events={events}
        window={window}
        liveAt={window.end}
        bucketCount={36}
        className="traffic__timeline"
        header={
          <div className="traffic__tl-header">
            <span className="traffic__tl-count">{events.length} requests</span>
            {denied > 0 ? (
              <span className="traffic__tl-deny">{denied} denied</span>
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

      {items.length === 0 ? (
        <p className="traffic__empty">
          {verdictFilter === 'all'
            ? 'No requests yet. Reads, writes, and listeners against the sandbox stream in live.'
            : `No ${verdictFilter} traffic in this session.`}
        </p>
      ) : (
        <div className="traffic__log" data-pyric-ui="traffic-log" data-pyric-grouped="">
          <ul data-pyric-traffic-log-items="">
            {items.map((item) =>
              item.type === 'group' ? (
                <li key={item.key} data-pyric-traffic-group-entry="">
                  <TrafficGroupRow
                    group={item}
                    renderClassification={verdictBadge}
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
                    onSelect={(e) => {
                      // Disclosure is the deny row's derived action (C3):
                      // click toggles the in-place detail; other rows are inert.
                      if (verdictFor(e as StudioTrafficEvent) !== 'deny') return;
                      setExpandedId((cur) => (cur === e.id ? null : e.id));
                    }}
                    renderClassification={verdictBadge}
                    formatTime={defaultFormatTime}
                  />
                  {item.event.id === expandedId &&
                  verdictFor(item.event as StudioTrafficEvent) === 'deny' ? (
                    <DenyDisclosure event={item.event as StudioTrafficEvent} />
                  ) : null}
                </li>
              ),
            )}
          </ul>
        </div>
      )}
    </section>
  );
}
