/**
 * Per-bucket peak concurrency bucketing over a stateful
 * {@link SubscriptionGaugeSnapshot} (#284).
 */

import type { TimeWindow } from './useTrafficBuckets.js';
import type { MetricPoint, MetricSeries } from './useTrafficMetrics.js';
import type { SubscriptionService } from './subscription-lifecycle.js';
import {
  applySubscriptionTransition,
  type SubscriptionConnectionRecord,
  type SubscriptionGaugeSnapshot,
  type SubscriptionListenerRecord,
} from './subscription-gauge.js';

export type SubscriptionSeriesKey = 'snapshotListeners' | 'activeConnections';

export const SUBSCRIPTION_SERIES_DEFS: ReadonlyArray<{
  readonly key: SubscriptionSeriesKey;
  readonly label: string;
}> = [
  { key: 'snapshotListeners', label: 'Peak snapshot listeners' },
  { key: 'activeConnections', label: 'Peak active connections' },
];

export interface BucketSubscriptionMetricsOptions {
  readonly service?: SubscriptionService;
  readonly bucketCount?: number;
  readonly includeListener?: (record: SubscriptionListenerRecord) => boolean;
  readonly includeConnection?: (record: SubscriptionConnectionRecord) => boolean;
}

export interface SubscriptionMetricsResult {
  readonly service: SubscriptionService;
  readonly connectionsObserved: boolean;
  readonly currentListeners: number;
  readonly currentConnections: number | null;
  readonly peakListeners: number;
  readonly peakConnections: number | null;
  readonly points: MetricPoint[];
  readonly series: MetricSeries[];
  readonly maxValue: number;
}

function countFilteredMap<Value extends { readonly service: SubscriptionService }>(
  entries: ReadonlyMap<string, Value>,
  service: SubscriptionService,
  predicate?: (value: Value) => boolean,
): number {
  let count = 0;
  for (const entry of entries.values()) {
    if (entry.service !== service) continue;
    if (predicate !== undefined && !predicate(entry)) continue;
    count += 1;
  }
  return count;
}

function seedFilteredMap<Value extends { readonly service: SubscriptionService }>(
  entries: ReadonlyMap<string, Value>,
  service: SubscriptionService,
  predicate?: (value: Value) => boolean,
): Map<string, Value> {
  const seeded = new Map<string, Value>();
  for (const [key, entry] of entries) {
    if (entry.service !== service) continue;
    if (predicate !== undefined && !predicate(entry)) continue;
    seeded.set(key, entry);
  }
  return seeded;
}

/**
 * Compute instantaneous active counts and per-bucket peak concurrency gauges
 * over `[window.start, window.end)`.
 */
export function bucketSubscriptionMetrics(
  snapshot: SubscriptionGaugeSnapshot,
  window: TimeWindow,
  options: BucketSubscriptionMetricsOptions = {},
): SubscriptionMetricsResult {
  const service: SubscriptionService = options.service ?? 'firestore';
  const bucketCount = options.bucketCount ?? 24;
  const includeListener = options.includeListener;
  const includeConnection = options.includeConnection;
  const connectionsObserved = snapshot.connectionsObservedByService.has(service);

  const currentListeners = countFilteredMap(snapshot.activeListeners, service, includeListener);
  let currentConnections: number | null = null;
  if (connectionsObserved) {
    currentConnections = countFilteredMap(snapshot.activeConnections, service, includeConnection);
  }

  const span = window.end - window.start;
  if (bucketCount <= 0 || span <= 0) {
    return {
      service,
      connectionsObserved,
      currentListeners,
      currentConnections,
      peakListeners: 0,
      peakConnections: connectionsObserved ? 0 : null,
      points: [],
      series: SUBSCRIPTION_SERIES_DEFS.map((def) => ({
        key: def.key,
        label: def.label,
        values: [],
        total: 0,
      })),
      maxValue: 0,
    };
  }

  const listeners = seedFilteredMap(snapshot.baselineListeners, service, includeListener);
  const connections = seedFilteredMap(snapshot.baselineConnections, service, includeConnection);

  const ordered = snapshot.transitions
    .map((transition, order) => ({ transition, order }))
    .sort((left, right) => {
      if (left.transition.at !== right.transition.at) {
        return left.transition.at - right.transition.at;
      }
      return left.order - right.order;
    });

  let cursor = 0;
  while (cursor < ordered.length) {
    const current = ordered[cursor];
    if (current === undefined || current.transition.at >= window.start) break;
    applySubscriptionTransition(
      listeners,
      connections,
      current.transition,
      service,
      includeListener,
      includeConnection,
    );
    cursor += 1;
  }

  const width = span / bucketCount;
  const listenerValues = new Array<number>(bucketCount).fill(0);
  const connectionValues = new Array<number>(bucketCount).fill(0);
  const points: MetricPoint[] = new Array<MetricPoint>(bucketCount);

  for (let i = 0; i < bucketCount; i += 1) {
    const bucketStart = window.start + i * width;
    const bucketEnd = window.start + (i + 1) * width;
    points[i] = { index: i, start: bucketStart, end: bucketEnd };

    let peakBucketListeners = listeners.size;
    let peakBucketConnections = connections.size;

    while (cursor < ordered.length) {
      const entry = ordered[cursor];
      if (entry === undefined || entry.transition.at >= window.end) break;
      let targetBucket = Math.floor((entry.transition.at - window.start) / width);
      if (targetBucket >= bucketCount) targetBucket = bucketCount - 1;
      if (targetBucket > i) break;

      applySubscriptionTransition(
        listeners,
        connections,
        entry.transition,
        service,
        includeListener,
        includeConnection,
      );
      if (listeners.size > peakBucketListeners) peakBucketListeners = listeners.size;
      if (connections.size > peakBucketConnections) peakBucketConnections = connections.size;
      cursor += 1;
    }

    listenerValues[i] = peakBucketListeners;
    connectionValues[i] = connectionsObserved ? peakBucketConnections : 0;
  }

  const peakListeners = Math.max(0, ...listenerValues);
  let peakConnections: number | null = null;
  if (connectionsObserved) {
    peakConnections = Math.max(0, ...connectionValues);
  }

  const series: MetricSeries[] = [
    {
      key: 'snapshotListeners',
      label: 'Peak snapshot listeners',
      values: listenerValues,
      total: peakListeners,
    },
    {
      key: 'activeConnections',
      label: 'Peak active connections',
      values: connectionValues,
      total: peakConnections ?? 0,
    },
  ];

  const maxValue = Math.max(peakListeners, peakConnections ?? 0);
  return {
    service,
    connectionsObserved,
    currentListeners,
    currentConnections,
    peakListeners,
    peakConnections,
    points,
    series,
    maxValue,
  };
}
