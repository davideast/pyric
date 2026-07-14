import { useState } from 'react';
import type { MetricPoint, MetricSeries } from '../hooks/useTrafficMetrics.js';

export interface TrafficLineChartProps {
  points: readonly MetricPoint[];
  series: readonly MetricSeries[];
  /** Series keys currently drawn. Omit to draw every series. Pair with
   *  {@link TrafficMetricCards}' `visible`/`onToggle` so the legend cards
   *  and the chart's lines toggle in lockstep. */
  visible?: ReadonlySet<string>;
  /** Omit all-zero series from the plot and tooltip while retaining their
   *  explicit total in the accompanying metric strip. */
  omitZeroSeries?: boolean;
  formatValue?: (n: number) => string;
  formatTime?: (t: number) => string;
  emptyState?: React.ReactNode;
  className?: string;
}

const defaultFormatValue = (n: number) => String(n);
const defaultFormatTime = (t: number) => new Date(t).toLocaleTimeString();

/** Hand-rolled SVG line chart, no charting dependency — plain lines over
 *  a 0..100 viewBox so CSS drives the actual size (intrinsic layout, no
 *  fixed pixel chart). Each series draws only when `visible` includes
 *  its key (or `visible` is omitted). The y-scale is the max value
 *  across the currently VISIBLE series only, so toggling a tall series
 *  off rescales the rest up — matching the Console reference.
 *
 * Interaction: hovering (or focusing, via the invisible per-bucket hit
 * targets) shows a tooltip with the bucket's time range and each visible
 * series' value at that bucket — `[data-pyric-chart-tooltip]`, positioned
 * via `--pyric-hover-x`.
 *
 * Styling hooks: `[data-pyric-ui="traffic-line-chart"]`,
 * `[data-pyric-chart-svg]`, `[data-pyric-chart-line]` (with
 * `data-pyric-series-key`, `data-pyric-series-index` — the same index a
 * `TrafficMetricCards` card carries, so line + card colors line up),
 * `[data-pyric-chart-hit]` (with `data-pyric-point-index`),
 * `[data-pyric-chart-tooltip]`, `[data-pyric-tooltip-row]`.
 */
export function TrafficLineChart({
  points,
  series,
  visible,
  omitZeroSeries = false,
  formatValue = defaultFormatValue,
  formatTime = defaultFormatTime,
  emptyState,
  className,
}: TrafficLineChartProps) {
  const [hovered, setHovered] = useState<number | null>(null);

  if (points.length === 0) {
    return (
      <div className={className} data-pyric-ui="traffic-line-chart" data-pyric-empty="">
        {emptyState}
      </div>
    );
  }

  const visibleSeries = series.filter(
    (s) => (!visible || visible.has(s.key)) && (!omitZeroSeries || s.total > 0),
  );
  let maxValue = 0;
  for (const s of visibleSeries) for (const v of s.values) if (v > maxValue) maxValue = v;
  const scale = maxValue === 0 ? 1 : maxValue;

  const n = points.length;
  const xAt = (i: number) => (n === 1 ? 50 : (i / (n - 1)) * 100);
  const yAt = (v: number) => 100 - (v / scale) * 100;

  const hoveredPoint = hovered != null ? points[hovered] : null;

  return (
    <div className={className} data-pyric-ui="traffic-line-chart">
      <div data-pyric-chart-svg="">
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="metrics over time">
          {series.map((s) => {
            const seriesIndex = series.indexOf(s);
            const isVisible =
              (!visible || visible.has(s.key)) && (!omitZeroSeries || s.total > 0);
            if (!isVisible) return null;
            const d = s.values.map((v, i) => `${i === 0 ? 'M' : 'L'}${xAt(i)},${yAt(v)}`).join(' ');
            return (
              <path
                key={s.key}
                data-pyric-chart-line=""
                data-pyric-series-key={s.key}
                data-pyric-series-index={seriesIndex}
                d={d}
                fill="none"
                vectorEffect="non-scaling-stroke"
              />
            );
          })}
        </svg>

        <div data-pyric-chart-hits="">
          {points.map((point, i) => (
            <button
              key={point.index}
              type="button"
              data-pyric-chart-hit=""
              data-pyric-point-index={i}
              onMouseEnter={() => setHovered(i)}
              onFocus={() => setHovered(i)}
              onMouseLeave={() => setHovered((cur) => (cur === i ? null : cur))}
              onBlur={() => setHovered((cur) => (cur === i ? null : cur))}
              aria-label={`${formatTime(point.start)} to ${formatTime(point.end)}`}
            />
          ))}
        </div>

        {hoveredPoint && (
          <div
            data-pyric-chart-tooltip=""
            style={{ '--pyric-hover-x': xAt(hoveredPoint.index) } as React.CSSProperties}
          >
            <div data-pyric-tooltip-time="">
              {formatTime(hoveredPoint.start)} – {formatTime(hoveredPoint.end)}
            </div>
            {visibleSeries.map((s) => (
              <div
                key={s.key}
                data-pyric-tooltip-row=""
                data-pyric-series-key={s.key}
                data-pyric-series-index={series.indexOf(s)}
              >
                <span data-pyric-tooltip-label="">{s.label}</span>
                <span data-pyric-tooltip-value="">{formatValue(s.values[hoveredPoint.index])}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
