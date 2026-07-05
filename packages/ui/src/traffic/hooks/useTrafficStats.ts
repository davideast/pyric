import { useMemo } from 'react';
import type { TrafficEvent } from '../types.js';

export interface TrafficStatBucket {
  key: string;
  count: number;
}

export interface TrafficStatsSummary {
  total: number;
  allows: number;
  denies: number;
  unsupported: number;
  /** `denies / total` — 0 for an empty buffer. */
  denyRate: number;
  /** Counts by method, sorted descending. */
  byMethod: TrafficStatBucket[];
  /** Counts by origin, sorted descending. */
  byOrigin: TrafficStatBucket[];
  /** Counts by path, sorted descending, capped at `topPaths`. */
  byPath: TrafficStatBucket[];
}

export interface UseTrafficStatsOptions {
  events: TrafficEvent[];
  /** Cap on `byPath` entries — paths are unbounded. Default 10. */
  topPaths?: number;
}

function buckets(
  events: TrafficEvent[],
  pick: (event: TrafficEvent) => string,
  limit?: number,
): TrafficStatBucket[] {
  const counts = new Map<string, number>();
  for (const event of events) {
    const key = pick(event);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const sorted = [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  return limit === undefined ? sorted : sorted.slice(0, limit);
}

/**
 * Aggregations over a traffic buffer: totals, deny rate, and counts
 * broken down by method, origin, and path. Pure derivation — feed it
 * the filtered or full event list depending on what the panel
 * should reflect.
 */
export function useTrafficStats({
  events,
  topPaths = 10,
}: UseTrafficStatsOptions): TrafficStatsSummary {
  return useMemo(() => {
    let allows = 0;
    let denies = 0;
    let unsupported = 0;
    for (const event of events) {
      if (event.result === 'allow') allows++;
      else if (event.result === 'deny') denies++;
      else unsupported++;
    }
    const total = events.length;
    return {
      total,
      allows,
      denies,
      unsupported,
      denyRate: total === 0 ? 0 : denies / total,
      byMethod: buckets(events, (e) => e.method),
      byOrigin: buckets(events, (e) => e.origin),
      byPath: buckets(events, (e) => e.path, topPaths),
    };
  }, [events, topPaths]);
}
