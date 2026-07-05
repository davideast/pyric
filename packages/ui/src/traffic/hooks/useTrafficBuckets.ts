import { useMemo } from 'react';
import type { TrafficEvent } from '../types.js';

/**
 * A half-open time window `[start, end)` in epoch-ms. The timeline
 * buckets events whose `at` falls inside it; events outside are
 * dropped from the histogram (but still counted in `outOfWindow`).
 */
export interface TimeWindow {
  start: number;
  end: number;
}

export interface TrafficBucket {
  /** 0-based bucket index, left (oldest) to right (newest). */
  index: number;
  /** Half-open bounds of this bucket `[start, end)` in epoch-ms. */
  start: number;
  end: number;
  /** Total events that fell in this bucket. */
  count: number;
  /** How many of `count` were denied. */
  denies: number;
  /** `count - denies` — allowed + unsupported. The "non-deny" stack. */
  allows: number;
  /**
   * `count / maxCount` across all buckets — 0..1. The full bar
   * height as a fraction of the tallest bucket. Drives
   * `--pyric-bucket-h`.
   */
  heightRatio: number;
  /**
   * `denies / maxCount` — 0..1. The deny sub-stack height as a
   * fraction of the tallest bucket, so the deny segment is drawn to
   * the same scale as the full bar. Drives `--pyric-bucket-deny-h`.
   */
  denyHeightRatio: number;
}

export interface UseTrafficBucketsOptions {
  events: TrafficEvent[];
  /** The time range to bucket over. */
  window: TimeWindow;
  /** Number of buckets to divide the window into. Default 30. */
  bucketCount?: number;
}

export interface UseTrafficBucketsResult {
  buckets: TrafficBucket[];
  /** Sum of `count` across buckets (events inside the window). */
  total: number;
  /** Sum of `denies` across buckets. */
  denies: number;
  /** The largest single-bucket `count` — the height-ratio divisor. */
  maxCount: number;
  /** Events whose `at` fell outside `[window.start, window.end)`. */
  outOfWindow: number;
}

const EMPTY_RESULT: UseTrafficBucketsResult = {
  buckets: [],
  total: 0,
  denies: 0,
  maxCount: 0,
  outOfWindow: 0,
};

/**
 * Buckets a traffic buffer into `bucketCount` equal time slices over
 * `window`, counting total + denied events per slice. Pure
 * derivation — the histogram component renders the result, this hook
 * (and `bucketTraffic` under it) owns the math.
 *
 * Each bucket carries a `heightRatio` and `denyHeightRatio`
 * (0..1, scaled to the tallest bucket) so the consumer can map them
 * straight onto a bar height without re-finding the max.
 */
export function useTrafficBuckets({
  events,
  window,
  bucketCount = 30,
}: UseTrafficBucketsOptions): UseTrafficBucketsResult {
  return useMemo(
    () => bucketTraffic(events, window, bucketCount),
    [events, window.start, window.end, bucketCount],
  );
}

/**
 * The pure bucketing kernel behind {@link useTrafficBuckets} — usable
 * outside React. Returns an empty result for a non-positive
 * `bucketCount` or a zero/negative-width window.
 */
export function bucketTraffic(
  events: TrafficEvent[],
  window: TimeWindow,
  bucketCount = 30,
): UseTrafficBucketsResult {
  const span = window.end - window.start;
  if (bucketCount <= 0 || span <= 0) return EMPTY_RESULT;

  const width = span / bucketCount;
  const counts = new Array<number>(bucketCount).fill(0);
  const denyCounts = new Array<number>(bucketCount).fill(0);

  let total = 0;
  let denies = 0;
  let outOfWindow = 0;

  for (const event of events) {
    const at = event.at;
    if (at < window.start || at >= window.end) {
      outOfWindow++;
      continue;
    }
    // Floor into a bucket; clamp the right edge so an `at` exactly at
    // `window.end - epsilon` never spills past the last bucket.
    let i = Math.floor((at - window.start) / width);
    if (i >= bucketCount) i = bucketCount - 1;
    counts[i]++;
    total++;
    if (event.result === 'deny') {
      denyCounts[i]++;
      denies++;
    }
  }

  let maxCount = 0;
  for (const c of counts) if (c > maxCount) maxCount = c;

  const buckets: TrafficBucket[] = counts.map((count, index) => {
    const denyCount = denyCounts[index];
    return {
      index,
      start: window.start + index * width,
      end: window.start + (index + 1) * width,
      count,
      denies: denyCount,
      allows: count - denyCount,
      heightRatio: maxCount === 0 ? 0 : count / maxCount,
      denyHeightRatio: maxCount === 0 ? 0 : denyCount / maxCount,
    };
  });

  return { buckets, total, denies, maxCount, outOfWindow };
}
