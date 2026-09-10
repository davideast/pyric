import { useMemo, useState } from 'react';
import type { DivergenceSummaryData, ReplayDivergence } from '../replayTypes.js';
import { computeDivergenceSummary } from '../divergenceAdapter.js';

export interface UseDivergenceInspectorOptions {
  divergences: readonly ReplayDivergence[];
  initialFilter?: string;
  initialSelected?: ReplayDivergence | null;
}

export interface UseDivergenceInspectorResult {
  divergences: readonly ReplayDivergence[];
  filteredDivergences: ReplayDivergence[];
  selectedDivergence: ReplayDivergence | null;
  selectDivergence: (divergence: ReplayDivergence | null) => void;
  filter: string;
  setFilter: (filter: string) => void;
  summary: DivergenceSummaryData;
}

/**
 * Headless hook managing divergence inspection, filtering by divergence kind
 * (e.g. `sentinel-drift`, `time-drift`, `autoid-alias`, `real-divergence`,
 * `now-denied`), selection, and summary counts.
 */
export function useDivergenceInspector({
  divergences,
  initialFilter = 'all',
  initialSelected = null,
}: UseDivergenceInspectorOptions): UseDivergenceInspectorResult {
  const [filter, setFilter] = useState<string>(initialFilter);
  const [selectedDivergence, selectDivergence] = useState<ReplayDivergence | null>(
    initialSelected,
  );

  const summary = useMemo(() => computeDivergenceSummary(divergences), [divergences]);

  const filteredDivergences = useMemo(() => {
    if (filter === 'all') return [...divergences];
    return divergences.filter((d) => d.kind === filter);
  }, [divergences, filter]);

  return {
    divergences,
    filteredDivergences,
    selectedDivergence,
    selectDivergence,
    filter,
    setFilter,
    summary,
  };
}
