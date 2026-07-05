/**
 * Traffic surface (S-TRAFFIC): `mocks/c-traffic.html` as a live surface.
 *
 * Two parts, both `@pyric/ui/traffic`:
 *   1. `TrafficTimeline`, the volume-over-time histogram (the time axis that
 *      makes traffic feel like traffic). Denies stack dark at the base of each
 *      bar; a live edge marks "now".
 *   2. `TrafficLog` (grouped via `useTrafficGroups`), the request stream, a
 *      listener storm collapsing to one group row, denials made clear.
 *
 * Data is the `kind: 'request'` slice of the unified event stream (the dev-seed
 * drives real allow/deny ops; `serve --ui` will stream live). `TrafficEvent` is
 * structurally identical to the sandbox `RequestEvent`, so there's no adapter.
 */

import { useMemo } from 'react';
import {
  TrafficLog,
  TrafficTimeline,
  useTrafficGroups,
  defaultFormatTime,
  type TimeWindow,
} from '@pyric/ui/traffic';
import { useStudioTraffic } from '../../shell/studio-data.js';
import './traffic.css';

/** A coarse "Nm ago" for the timeline's left axis tick. */
function relAgo(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

export function TrafficSurface() {
  const events = useStudioTraffic();
  const now = Date.now();

  // The window spans from the earliest request (or 15m back) to just past now,
  // so a fresh session's handful of ops still lands a few buckets from the edge.
  const window = useMemo<TimeWindow>(() => {
    if (events.length === 0) return { start: now - 15 * 60_000, end: now };
    const earliest = Math.min(...events.map((e) => e.at));
    return { start: Math.min(earliest, now - 60_000), end: now + 1_000 };
  }, [events, now]);

  // Newest-first stream; grouping is the volume reducer (storms → one row).
  const ordered = useMemo(
    () => [...events].sort((a, b) => b.at - a.at),
    [events],
  );
  const { items } = useTrafficGroups({ events: ordered });

  const denied = events.filter((e) => e.result === 'deny').length;

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

      <TrafficLog
        events={ordered}
        items={items}
        formatTime={defaultFormatTime}
        className="traffic__log"
        emptyState={
          <p className="traffic__empty">
            No requests yet. Reads, writes, and listeners against the sandbox
            stream in live.
          </p>
        }
      />
    </section>
  );
}
