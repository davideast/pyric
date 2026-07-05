import type { ReactNode } from 'react';
import type { RuleHeatmapEntry } from '../hooks/useRuleHeatmap.js';

export interface RuleHeatmapProps {
  /** Per-rule rollup from `useRuleHeatmap`. */
  entries: RuleHeatmapEntry[];
  /** Marks one rule row as the active selection. */
  selectedRuleIndex?: number;
  /**
   * Fired when a rule row is clicked — wire this to the log filter
   * for the cross-view "click a rule, see its traffic" interaction.
   */
  onSelectRule?: (ruleIndex: number) => void;
  emptyState?: ReactNode;
  className?: string;
}

/** Buckets the deny ratio into discrete heat levels for CSS. */
function heatBucket(denyRatio: number): 'none' | 'low' | 'medium' | 'high' {
  if (denyRatio === 0) return 'none';
  if (denyRatio <= 0.33) return 'low';
  if (denyRatio <= 0.66) return 'medium';
  return 'high';
}

/**
 * Headless rule heatmap — one row per rule, busiest first. Each row
 * exposes two styling channels:
 *
 * - `data-pyric-rule-heat` — a discrete bucket (`none`/`low`/
 *   `medium`/`high`) by deny ratio, for threshold-based coloring.
 * - `--pyric-deny-ratio` — the raw 0–1 ratio as a CSS custom
 *   property, for a proportional bar / gradient.
 *
 * Counts render as separate elements (`data-pyric-rule-total`,
 * `-allows`, `-denies`) so the consumer can show numbers, bars, or
 * both.
 *
 * Styling hooks: `[data-pyric-ui="rule-heatmap"]`,
 * `[data-pyric-rule-row]` (with `data-pyric-rule-index`,
 * `data-pyric-rule-heat`, `data-pyric-selected`).
 */
export function RuleHeatmap({
  entries,
  selectedRuleIndex,
  onSelectRule,
  emptyState,
  className,
}: RuleHeatmapProps) {
  if (entries.length === 0) {
    return (
      <div
        className={className}
        data-pyric-ui="rule-heatmap"
        data-pyric-empty=""
      >
        {emptyState}
      </div>
    );
  }

  return (
    <div className={className} data-pyric-ui="rule-heatmap">
      <ul data-pyric-rule-heatmap-items="">
        {entries.map((entry) => {
          const selected = entry.ruleIndex === selectedRuleIndex;
          return (
            <li key={entry.ruleIndex} data-pyric-rule-entry="">
              <button
                type="button"
                onClick={() => onSelectRule?.(entry.ruleIndex)}
                data-pyric-rule-row=""
                data-pyric-rule-index={entry.ruleIndex}
                data-pyric-rule-heat={heatBucket(entry.denyRatio)}
                data-pyric-selected={selected ? '' : undefined}
                style={
                  {
                    '--pyric-deny-ratio': entry.denyRatio,
                  } as React.CSSProperties
                }
              >
                <span data-pyric-rule-label="">#{entry.ruleIndex}</span>
                <span data-pyric-rule-operations="">
                  {entry.operations.join(', ')}
                </span>
                <span data-pyric-rule-total="">{entry.total}</span>
                <span data-pyric-rule-allows="">{entry.allows}</span>
                <span data-pyric-rule-denies="">{entry.denies}</span>
                <span data-pyric-rule-bar="" aria-hidden="true" />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
