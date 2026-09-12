/**
 * The Listeners journal's cards and evidence chart (feature: Listeners).
 *
 * PURE. Two shapes, both in the units `@pyric/ui/traffic` already draws:
 *
 *   - {@link listenerCardSeries} builds the three `MetricSeries` the metric
 *     cards render. A card's number is a listener count, so the series carries
 *     no per-bucket values: `TrafficMetricCards` reads `total` only, and these
 *     three keys are row filters rather than chart lines.
 *   - {@link deliveryMetrics} buckets delivery events per service over the
 *     window the Traffic surface already computes, in the `MetricPoint` /
 *     `MetricSeries` pair `TrafficLineChart` takes.
 *
 * The bucketing follows `useTrafficMetrics`'s kernel exactly — the same
 * half-open `[window.start, window.end)` rule, the same 24-bucket default,
 * the same clamp of the final bucket. That kernel is private to the shared
 * package and its public wrappers classify `TrafficEvent` methods, which a
 * delivery is not; this is the same arithmetic over the delivery stream.
 */

import type { MetricPoint, MetricSeries, TimeWindow } from '@pyric/ui/traffic';
import type { ActiveListener, SandboxEvent } from 'pyric/sandbox';
import { isDeliveryEvent } from './listener-deliveries.js';

/** The three card keys, in the order the cards render. */
export type ListenerCardKey = 'delivering' | 'idle' | 'incidents';

export const LISTENER_CARD_DEFS: ReadonlyArray<{ key: ListenerCardKey; label: string }> = [
  { key: 'delivering', label: 'Delivering' },
  { key: 'idle', label: 'Idle' },
  { key: 'incidents', label: 'Incidents' },
];

export interface ListenerCardTotals {
  readonly delivering: number;
  readonly idle: number;
  readonly incidents: number;
}

/** The card strip's three series. `values` is empty by design: the cards show
 *  a count, and these keys filter rows rather than chart lines. */
export function listenerCardSeries(totals: ListenerCardTotals): MetricSeries[] {
  return LISTENER_CARD_DEFS.map((def) => ({
    key: def.key,
    label: def.label,
    values: [],
    total: totals[def.key],
  }));
}

const DELIVERY_SERIES_DEFS: ReadonlyArray<{ key: ActiveListener['service']; label: string }> = [
  { key: 'firestore', label: 'Firestore' },
  { key: 'database', label: 'Database' },
];

/** How many times each listener's callback ran inside the window. */
export function deliveryCountsInWindow(
  events: readonly SandboxEvent[],
  window: TimeWindow,
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const event of events) {
    if (!isDeliveryEvent(event)) continue;
    if (event.at < window.start || event.at >= window.end) continue;
    const listenerId = (event as { listenerId?: string }).listenerId;
    if (listenerId === undefined) continue;
    counts.set(listenerId, (counts.get(listenerId) ?? 0) + 1);
  }
  return counts;
}

export interface DeliveryMetrics {
  readonly points: MetricPoint[];
  readonly series: MetricSeries[];
  /** Deliveries counted across every series. Zero means no chart to draw. */
  readonly total: number;
}

/**
 * Deliveries per bucket, one series per service.
 *
 * The service comes from the listener the delivery belongs to, not from the
 * delivery event: a Firestore snapshot delivery does not carry a service
 * token, and the fold already knows which backend opened the listener. A
 * delivery whose listener is no longer attached therefore has no series to
 * land in and is not counted.
 */
export function deliveryMetrics(
  events: readonly SandboxEvent[],
  listeners: readonly ActiveListener[],
  window: TimeWindow,
  bucketCount = 24,
): DeliveryMetrics {
  const span = window.end - window.start;
  const empty = DELIVERY_SERIES_DEFS.map((def) => ({
    key: def.key,
    label: def.label,
    values: [] as number[],
    total: 0,
  }));
  if (bucketCount <= 0 || span <= 0) return { points: [], series: empty, total: 0 };

  const width = span / bucketCount;
  const serviceOf = new Map<string, ActiveListener['service']>();
  for (const listener of listeners) serviceOf.set(listener.id, listener.service);

  const valuesByService = new Map<ActiveListener['service'], number[]>(
    DELIVERY_SERIES_DEFS.map((def) => [def.key, new Array<number>(bucketCount).fill(0)]),
  );
  let total = 0;
  for (const event of events) {
    if (!isDeliveryEvent(event)) continue;
    if (event.at < window.start || event.at >= window.end) continue;
    const listenerId = (event as { listenerId?: string }).listenerId;
    if (listenerId === undefined) continue;
    const service = serviceOf.get(listenerId);
    if (service === undefined) continue;
    const values = valuesByService.get(service);
    if (values === undefined) continue;
    let index = Math.floor((event.at - window.start) / width);
    if (index >= bucketCount) index = bucketCount - 1;
    values[index] = (values[index] ?? 0) + 1;
    total += 1;
  }

  const points: MetricPoint[] = [];
  for (let index = 0; index < bucketCount; index += 1) {
    points.push({
      index,
      start: window.start + index * width,
      end: window.start + (index + 1) * width,
    });
  }
  const series: MetricSeries[] = DELIVERY_SERIES_DEFS.map((def) => {
    const values = valuesByService.get(def.key)!;
    return {
      key: def.key,
      label: def.label,
      values,
      total: values.reduce((sum, value) => sum + value, 0),
    };
  });
  return { points, series, total };
}
