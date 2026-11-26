import { useMemo } from 'react';
import type { TimeWindow } from './useTrafficBuckets.js';
import type { SubscriptionGaugeSnapshot } from './subscription-gauge.js';
import {
  bucketSubscriptionMetrics,
  type BucketSubscriptionMetricsOptions,
  type SubscriptionMetricsResult,
} from './subscription-buckets.js';

export interface UseSubscriptionMetricsOptions extends BucketSubscriptionMetricsOptions {
  readonly snapshot: SubscriptionGaugeSnapshot;
  readonly window: TimeWindow;
}

/**
 * React hook computing instantaneous active counts and per-bucket peak gauges
 * for snapshot listeners and active connections over `window`.
 */
export function useSubscriptionMetrics({
  snapshot,
  window,
  service = 'firestore',
  bucketCount = 24,
  includeListener,
  includeConnection,
}: UseSubscriptionMetricsOptions): SubscriptionMetricsResult {
  return useMemo(
    () =>
      bucketSubscriptionMetrics(snapshot, window, {
        service,
        bucketCount,
        includeListener,
        includeConnection,
      }),
    [
      snapshot,
      window.start,
      window.end,
      service,
      bucketCount,
      includeListener,
      includeConnection,
    ],
  );
}
