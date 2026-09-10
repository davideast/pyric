import type { DivergenceSummaryData, ReplayDivergence } from '../replayTypes.js';
import { computeDivergenceSummary } from '../divergenceAdapter.js';

export interface DivergenceSummaryProps {
  summary?: DivergenceSummaryData;
  divergences?: readonly ReplayDivergence[];
  filter?: string;
  onFilterChange?: (filter: string) => void;
  className?: string;
}

/**
 * Headless divergence summary view showing counts of real divergences,
 * `sentinel-drift`, `time-drift`, `autoid-alias`, and `now-denied`.
 */
export function DivergenceSummary({
  summary: externalSummary,
  divergences = [],
  filter,
  onFilterChange,
  className,
}: DivergenceSummaryProps) {
  const summary =
    externalSummary ?? computeDivergenceSummary(divergences);

  return (
    <div className={className} data-pyric-ui="divergence-summary">
      <button
        type="button"
        data-pyric-divergence-filter="all"
        data-pyric-active={filter === 'all' || !filter ? '' : undefined}
        onClick={() => onFilterChange?.('all')}
      >
        <span>Total</span>
        <span data-pyric-divergence-total="">{summary.total}</span>
      </button>

      <button
        type="button"
        data-pyric-divergence-filter="real-divergence"
        data-pyric-active={filter === 'real-divergence' ? '' : undefined}
        onClick={() => onFilterChange?.('real-divergence')}
      >
        <span>Real Divergences</span>
        <span data-pyric-divergence-real="">{summary.realCount}</span>
      </button>

      <button
        type="button"
        data-pyric-divergence-filter="sentinel-drift"
        data-pyric-active={filter === 'sentinel-drift' ? '' : undefined}
        onClick={() => onFilterChange?.('sentinel-drift')}
      >
        <span>Sentinel Drift</span>
        <span data-pyric-divergence-sentinel-drift="">
          {summary.sentinelDriftCount}
        </span>
      </button>

      <button
        type="button"
        data-pyric-divergence-filter="time-drift"
        data-pyric-active={filter === 'time-drift' ? '' : undefined}
        onClick={() => onFilterChange?.('time-drift')}
      >
        <span>Time Drift</span>
        <span data-pyric-divergence-time-drift="">{summary.timeDriftCount}</span>
      </button>

      <button
        type="button"
        data-pyric-divergence-filter="autoid-alias"
        data-pyric-active={filter === 'autoid-alias' ? '' : undefined}
        onClick={() => onFilterChange?.('autoid-alias')}
      >
        <span>Auto-ID Aliases</span>
        <span data-pyric-divergence-autoid-alias="">
          {summary.autoidAliasCount}
        </span>
      </button>

      {summary.nowDeniedCount > 0 && (
        <button
          type="button"
          data-pyric-divergence-filter="now-denied"
          data-pyric-active={filter === 'now-denied' ? '' : undefined}
          onClick={() => onFilterChange?.('now-denied')}
        >
          <span>Now Denied</span>
          <span data-pyric-divergence-now-denied="">
            {summary.nowDeniedCount}
          </span>
        </button>
      )}
    </div>
  );
}
