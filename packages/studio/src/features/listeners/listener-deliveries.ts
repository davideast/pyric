/**
 * Delivery history for one listener (feature: Listeners).
 *
 * PURE. The detail pane draws the session's deliveries as a sparkline. The
 * data is just the timestamps of the delivery events carrying the listener's
 * id, bucketed evenly across the session so the shape reads as rate over
 * time rather than a list of instants. The polyline is built here, as plain
 * numbers, so the pane can render an inline SVG without a chart library.
 */

import type { SandboxEvent } from 'pyric/sandbox';

/** Every delivery event kind the sandbox emits, across both services. */
export function isDeliveryEvent(event: SandboxEvent): boolean {
  if (event.kind === 'snapshot_delivery') return true;
  return event.kind === 'listener' && (event as { phase?: string }).phase === 'delivery';
}

/** The timestamps at which one listener's callback ran, in order. */
export function deliveryTimestamps(
  events: readonly SandboxEvent[],
  listenerId: string,
): readonly number[] {
  const at: number[] = [];
  for (const event of events) {
    if (!isDeliveryEvent(event)) continue;
    if ((event as { listenerId?: string }).listenerId !== listenerId) continue;
    at.push(event.at);
  }
  return at;
}

export interface SparklineShape {
  readonly buckets: readonly number[];
  readonly peak: number;
  /** `points` for an SVG `<polyline>`, in a `width` × `height` box. */
  readonly points: string;
}

/**
 * Bucket delivery timestamps into a fixed-width sparkline.
 *
 * An empty history gives an empty shape (the pane says so rather than
 * drawing a flat line). A single delivery gives one full bucket: with no
 * span to spread over, the one thing that happened is the whole picture.
 */
export function deliverySparkline(
  timestamps: readonly number[],
  options: { buckets?: number; width?: number; height?: number } = {},
): SparklineShape {
  const bucketCount = options.buckets ?? 24;
  const width = options.width ?? 120;
  const height = options.height ?? 24;
  if (timestamps.length === 0) return { buckets: [], peak: 0, points: '' };

  const start = Math.min(...timestamps);
  const end = Math.max(...timestamps);
  const span = end - start;
  const buckets = new Array<number>(bucketCount).fill(0);
  for (const at of timestamps) {
    const index =
      span === 0 ? bucketCount - 1 : Math.min(bucketCount - 1, Math.floor(((at - start) / span) * bucketCount));
    buckets[index] = (buckets[index] ?? 0) + 1;
  }
  const peak = Math.max(...buckets);
  const step = bucketCount > 1 ? width / (bucketCount - 1) : 0;
  const points = buckets
    .map((count, index) => {
      const x = (index * step).toFixed(2);
      const y = (height - (peak === 0 ? 0 : (count / peak) * height)).toFixed(2);
      return `${x},${y}`;
    })
    .join(' ');
  return { buckets, peak, points };
}
