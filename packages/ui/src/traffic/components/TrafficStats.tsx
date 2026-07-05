import type { TrafficStatsSummary } from '../hooks/useTrafficStats.js';

export interface TrafficStatsProps {
  stats: TrafficStatsSummary;
  className?: string;
}

function BucketList({
  label,
  buckets,
}: {
  label: string;
  buckets: TrafficStatsSummary['byMethod'];
}) {
  return (
    <div data-pyric-stat-group="" data-pyric-stat-group-label={label}>
      <h4 data-pyric-stat-group-heading="">{label}</h4>
      <ul data-pyric-stat-buckets="">
        {buckets.map((b) => (
          <li key={b.key} data-pyric-stat-bucket="" data-pyric-stat-key={b.key}>
            <span data-pyric-stat-bucket-label="">{b.key}</span>
            <span data-pyric-stat-bucket-count="">{b.count}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Headless aggregation panel. Renders the totals, the deny rate, and
 * count breakdowns by method / origin / path. The deny rate is
 * exposed both as text and as a `--pyric-deny-rate` CSS custom
 * property on the root for a proportional meter.
 *
 * Styling hooks: `[data-pyric-ui="traffic-stats"]`,
 * `[data-pyric-stat]` (with `data-pyric-stat-key`),
 * `[data-pyric-stat-group]` (with `data-pyric-stat-group-label`),
 * `[data-pyric-stat-bucket]`.
 */
export function TrafficStats({ stats, className }: TrafficStatsProps) {
  return (
    <div
      className={className}
      data-pyric-ui="traffic-stats"
      style={{ '--pyric-deny-rate': stats.denyRate } as React.CSSProperties}
    >
      <div data-pyric-stat-totals="">
        <span data-pyric-stat="" data-pyric-stat-key="total">
          <span data-pyric-stat-label="">total</span>
          <span data-pyric-stat-value="">{stats.total}</span>
        </span>
        <span data-pyric-stat="" data-pyric-stat-key="allows">
          <span data-pyric-stat-label="">allowed</span>
          <span data-pyric-stat-value="">{stats.allows}</span>
        </span>
        <span data-pyric-stat="" data-pyric-stat-key="denies">
          <span data-pyric-stat-label="">denied</span>
          <span data-pyric-stat-value="">{stats.denies}</span>
        </span>
        <span data-pyric-stat="" data-pyric-stat-key="deny-rate">
          <span data-pyric-stat-label="">deny rate</span>
          <span data-pyric-stat-value="">
            {(stats.denyRate * 100).toFixed(0)}%
          </span>
        </span>
      </div>
      <BucketList label="method" buckets={stats.byMethod} />
      <BucketList label="origin" buckets={stats.byOrigin} />
      <BucketList label="path" buckets={stats.byPath} />
    </div>
  );
}
