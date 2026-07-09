import type { MetricSeries } from '../hooks/useTrafficMetrics.js';

export interface TrafficMetricCardsProps {
  series: readonly MetricSeries[];
  /** When supplied (with `onToggle`), each card gets a checkbox and
   *  doubles as the chart's legend — Console reference semantics
   *  ("toggle series visibility"). Omit for a read-only totals strip. */
  visible?: ReadonlySet<string>;
  onToggle?: (key: string) => void;
  formatValue?: (n: number) => string;
  className?: string;
}

const defaultFormatValue = (n: number) => String(n);

/**
 * The period-total strip: one card per series, each showing the series'
 * total for the current window. Doubles as BOTH the chart's legend row
 * (pass `visible` + `onToggle` to get the checkbox-toggle semantics) AND
 * the standalone fallback presentation when a chart isn't warranted —
 * this component never depends on {@link TrafficLineChart}.
 *
 * Styling hooks: `[data-pyric-ui="traffic-metric-cards"]`,
 * `[data-pyric-metric-card]` (with `data-pyric-metric-key`,
 * `data-pyric-series-index` — the color channel a chart's lines also
 * key off of, so a card and its line always match), `[data-pyric-metric-hidden]`
 * when toggled off.
 */
export function TrafficMetricCards({
  series,
  visible,
  onToggle,
  formatValue = defaultFormatValue,
  className,
}: TrafficMetricCardsProps) {
  const toggleable = visible !== undefined && onToggle !== undefined;
  return (
    <div className={className} data-pyric-ui="traffic-metric-cards" role={toggleable ? 'group' : undefined}>
      {series.map((s, index) => {
        const isVisible = visible ? visible.has(s.key) : true;
        const card = (
          <>
            <span data-pyric-metric-swatch="" aria-hidden="true" />
            <span data-pyric-metric-label="">{s.label}</span>
            <span data-pyric-metric-value="">{formatValue(s.total)}</span>
          </>
        );
        return toggleable ? (
          <label
            key={s.key}
            data-pyric-metric-card=""
            data-pyric-metric-key={s.key}
            data-pyric-series-index={index}
            data-pyric-metric-hidden={isVisible ? undefined : ''}
          >
            <input
              type="checkbox"
              checked={isVisible}
              onChange={() => onToggle!(s.key)}
              data-pyric-metric-checkbox=""
            />
            {card}
          </label>
        ) : (
          <span
            key={s.key}
            data-pyric-metric-card=""
            data-pyric-metric-key={s.key}
            data-pyric-series-index={index}
          >
            {card}
          </span>
        );
      })}
    </div>
  );
}
