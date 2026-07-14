import { useId, useState, type ReactNode } from 'react';
import { useTrafficBuckets } from '../hooks/useTrafficBuckets.js';
import type {
  TimeWindow,
  TrafficBucket,
  UseTrafficBucketsResult,
} from '../hooks/useTrafficBuckets.js';
import type { TrafficEvent } from '../types.js';

export interface TrafficTimelineProps {
  /**
   * Raw traffic events to bucket. Ignored when `buckets` is supplied
   * (the consumer pre-bucketed). Exactly one of `events` / `buckets`
   * should drive the histogram.
   */
  events?: TrafficEvent[];
  /**
   * Pre-bucketed counts — the escape hatch when the caller already
   * ran {@link useTrafficBuckets} (or `bucketTraffic`) upstream, e.g.
   * to share one bucketing pass across the timeline + a stats header.
   * Takes precedence over `events`.
   */
  buckets?: UseTrafficBucketsResult;
  /** The time range the histogram spans. */
  window: TimeWindow;
  /** Number of bars. Default 30. Only used on the `events` path. */
  bucketCount?: number;
  /**
   * A brushed sub-range (`[start, end)`) drawn as an overlay over the
   * bars. Position is derived from where it falls inside `window`, so
   * a partly-out-of-window brush clamps to the chart edges.
   */
  brush?: TimeWindow;
  /**
   * Fired when a bar inside the brush region is clicked-through — the
   * component itself is presentation-agnostic about drag, so the
   * primary brush gesture is owned by the consumer. As a built-in
   * affordance, clicking a bucket calls this with a one-bucket-wide
   * window so a bare consumer still gets a working selection.
   */
  onBrush?: (window: TimeWindow) => void;
  /**
   * Direct annotation shown while a bucket is hovered or keyboard-focused.
   * The timeline owns preview state and positioning; the consumer owns the
   * words and number formatting.
   */
  renderBucketSummary?: (bucket: TrafficBucket) => ReactNode;
  /**
   * Where the live edge marker sits, in epoch-ms. Defaults to
   * `window.end` (the right edge = "now"). Omit / pass `null` to hide
   * the marker entirely (e.g. a frozen, non-live window).
   */
  liveAt?: number | null;
  /**
   * Header slot — title, deny summary, live label. Rendered above the
   * bars inside `[data-pyric-timeline-header]`. The mock puts
   * "142 requests · 16 denied · live" here.
   */
  header?: ReactNode;
  /**
   * Axis slot — tick labels below the bars inside
   * `[data-pyric-timeline-axis]`. The mock puts "14m ago · 7m · now"
   * here. Receives the resolved window so labels can be derived.
   */
  axis?: ReactNode | ((window: TimeWindow) => ReactNode);
  emptyState?: ReactNode;
  className?: string;
}

/** Clamp a 0..1 fraction. */
function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/** Fraction (0..1) of `t` across `[window.start, window.end)`. */
function fraction(t: number, window: TimeWindow): number {
  const span = window.end - window.start;
  if (span <= 0) return 0;
  return clamp01((t - window.start) / span);
}

/**
 * Headless volume-over-time histogram — the time axis for the traffic
 * lens. Buckets events into N bars; each bar stacks denies (dark, at
 * the base) under the allow remainder, matching the Studio mock.
 *
 * Per-bucket styling channels (on `[data-pyric-bucket]`):
 * - `data-pyric-bucket-count` / `-denies` — raw integers.
 * - `--pyric-bucket-h` — full bar height, 0..1 of the tallest bucket.
 * - `--pyric-bucket-deny-h` — deny sub-stack height, same scale.
 * The deny segment (`[data-pyric-bucket-deny]`) and allow segment
 * (`[data-pyric-bucket-allow]`) are separate children so the consumer
 * colors them independently.
 *
 * A `[data-pyric-brush]` overlay marks a sub-range via
 * `--pyric-brush-left` / `--pyric-brush-right` (0..1 fractions). The
 * `[data-pyric-live]` edge marker sits at `--pyric-live-x`.
 *
 * Styling hooks: `[data-pyric-ui="traffic-timeline"]`,
 * `[data-pyric-timeline-header]`, `[data-pyric-timeline-bars]`,
 * `[data-pyric-bucket]` (with `data-pyric-bucket-index`,
 * `data-pyric-has-denies`, `data-pyric-bucket-selected`),
 * `[data-pyric-bucket-summary]`, `[data-pyric-brush]`, `[data-pyric-live]`,
 * `[data-pyric-timeline-axis]`.
 */
export function TrafficTimeline({
  events,
  buckets: prebucketed,
  window,
  bucketCount = 30,
  brush,
  onBrush,
  renderBucketSummary,
  liveAt,
  header,
  axis,
  emptyState,
  className,
}: TrafficTimelineProps) {
  const summaryId = useId();
  const [hoveredBucket, setHoveredBucket] = useState<number | null>(null);
  const [focusedBucket, setFocusedBucket] = useState<number | null>(null);
  // Hook is always called (rules of hooks); its result is discarded
  // when the caller pre-bucketed.
  const computed = useTrafficBuckets({
    events: events ?? [],
    window,
    bucketCount,
  });
  const result = prebucketed ?? computed;
  const { buckets, total } = result;
  const activeBucketIndex = hoveredBucket ?? focusedBucket;
  const activeBucket =
    activeBucketIndex === null ? null : (buckets.find((bucket) => bucket.index === activeBucketIndex) ?? null);
  const activeBucketSelected =
    activeBucket !== null && brush?.start === activeBucket.start && brush.end === activeBucket.end;

  if (buckets.length === 0) {
    return (
      <div
        className={className}
        data-pyric-ui="traffic-timeline"
        data-pyric-empty=""
      >
        {emptyState}
      </div>
    );
  }

  const isEmpty = total === 0;
  const livePoint = liveAt === undefined ? window.end : liveAt;
  const liveX = livePoint == null ? null : fraction(livePoint, window);

  const resolvedAxis = typeof axis === 'function' ? axis(window) : axis;

  return (
    <div
      className={className}
      data-pyric-ui="traffic-timeline"
      data-pyric-empty={isEmpty ? '' : undefined}
    >
      {header !== undefined && (
        <div data-pyric-timeline-header="">{header}</div>
      )}

      <div data-pyric-timeline-chart="">
        <div
          data-pyric-timeline-bars=""
          role={onBrush ? 'group' : 'img'}
          aria-label="request volume over time"
        >
          {buckets.map((bucket) => (
            <Bar
              key={bucket.index}
              bucket={bucket}
              window={window}
              onBrush={onBrush}
              onHover={renderBucketSummary ? setHoveredBucket : undefined}
              onFocus={renderBucketSummary ? setFocusedBucket : undefined}
              summaryId={
                renderBucketSummary && !activeBucketSelected && activeBucket?.index === bucket.index
                  ? summaryId
                  : undefined
              }
              selected={brush?.start === bucket.start && brush.end === bucket.end}
            />
          ))}
        </div>

        {activeBucket && renderBucketSummary && !activeBucketSelected ? (
          <div
            id={summaryId}
            role="tooltip"
            data-pyric-bucket-summary=""
            style={
              {
                '--pyric-bucket-summary-x': (activeBucket.index + 0.5) / Math.max(buckets.length, 1),
              } as React.CSSProperties
            }
          >
            {renderBucketSummary(activeBucket)}
          </div>
        ) : null}

        {brush && (
          <div
            data-pyric-brush=""
            aria-hidden="true"
            style={
              {
                '--pyric-brush-left': fraction(brush.start, window),
                '--pyric-brush-right': 1 - fraction(brush.end, window),
              } as React.CSSProperties
            }
          />
        )}

        {liveX != null && (
          <div
            data-pyric-live=""
            aria-hidden="true"
            style={{ '--pyric-live-x': liveX } as React.CSSProperties}
          />
        )}
      </div>

      {resolvedAxis !== undefined && resolvedAxis !== null && (
        <div data-pyric-timeline-axis="">{resolvedAxis}</div>
      )}
    </div>
  );
}

function Bar({
  bucket,
  window,
  onBrush,
  onHover,
  onFocus,
  summaryId,
  selected,
}: {
  bucket: TrafficBucket;
  window: TimeWindow;
  onBrush?: (window: TimeWindow) => void;
  onHover?: (index: number | null) => void;
  onFocus?: (index: number | null) => void;
  summaryId?: string;
  selected: boolean;
}) {
  const interactive = onBrush !== undefined;
  const requestLabel = `${bucket.count} ${bucket.count === 1 ? 'request' : 'requests'}`;
  const denyLabel = `${bucket.denies} denied`;
  return (
    <button
      type="button"
      data-pyric-bucket=""
      data-pyric-bucket-index={bucket.index}
      data-pyric-bucket-count={bucket.count}
      data-pyric-bucket-denies={bucket.denies}
      data-pyric-has-denies={bucket.denies > 0 ? '' : undefined}
      data-pyric-bucket-selected={selected ? '' : undefined}
      disabled={!interactive}
      aria-label={`${requestLabel}, ${denyLabel}`}
      aria-describedby={summaryId}
      aria-pressed={interactive ? selected : undefined}
      onPointerEnter={onHover ? () => onHover(bucket.index) : undefined}
      onPointerLeave={onHover ? () => onHover(null) : undefined}
      onFocus={onFocus ? () => onFocus(bucket.index) : undefined}
      onBlur={onFocus ? () => onFocus(null) : undefined}
      onClick={
        interactive
          ? () => onBrush?.({ start: bucket.start, end: bucket.end })
          : undefined
      }
      style={
        {
          '--pyric-bucket-h': bucket.heightRatio,
          '--pyric-bucket-deny-h': bucket.denyHeightRatio,
        } as React.CSSProperties
      }
    >
      <span data-pyric-bucket-allow="" aria-hidden="true" />
      <span data-pyric-bucket-deny="" aria-hidden="true" />
    </button>
  );
}
