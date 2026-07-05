import { useMemo } from 'react';
import type { TrafficEvent } from '../types.js';

export interface RuleHeatmapEntry {
  /** The rule's index in the rules file. */
  ruleIndex: number;
  /** Union of all operations seen matching this rule. */
  operations: string[];
  /** Total events that matched this rule. */
  total: number;
  allows: number;
  denies: number;
  unsupported: number;
  /** `denies / total` — 0 when the rule never denied. */
  denyRatio: number;
}

export interface UseRuleHeatmapOptions {
  events: TrafficEvent[];
}

export interface UseRuleHeatmapResult {
  /** Per-rule rollup, sorted by `total` descending (busiest first),
   *  ties broken by `ruleIndex` ascending. */
  entries: RuleHeatmapEntry[];
  /** Events that matched no rule — counted here, not attributed to
   *  any entry. */
  unmatchedCount: number;
}

interface Accumulator {
  ruleIndex: number;
  operations: Set<string>;
  total: number;
  allows: number;
  denies: number;
  unsupported: number;
}

/**
 * Rolls a traffic buffer up by `matchedRule.ruleIndex`: how often
 * each rule fired, and how that split across allow / deny /
 * unsupported. Pure derivation — feed it the filtered or full
 * event list depending on what the heatmap should reflect.
 */
export function useRuleHeatmap({
  events,
}: UseRuleHeatmapOptions): UseRuleHeatmapResult {
  return useMemo(() => {
    const byRule = new Map<number, Accumulator>();
    let unmatchedCount = 0;

    for (const event of events) {
      if (!event.matchedRule) {
        unmatchedCount++;
        continue;
      }
      const { ruleIndex, operations } = event.matchedRule;
      let acc = byRule.get(ruleIndex);
      if (!acc) {
        acc = {
          ruleIndex,
          operations: new Set(),
          total: 0,
          allows: 0,
          denies: 0,
          unsupported: 0,
        };
        byRule.set(ruleIndex, acc);
      }
      for (const op of operations) acc.operations.add(op);
      acc.total++;
      if (event.result === 'allow') acc.allows++;
      else if (event.result === 'deny') acc.denies++;
      else acc.unsupported++;
    }

    const entries: RuleHeatmapEntry[] = [...byRule.values()]
      .map((acc) => ({
        ruleIndex: acc.ruleIndex,
        operations: [...acc.operations],
        total: acc.total,
        allows: acc.allows,
        denies: acc.denies,
        unsupported: acc.unsupported,
        denyRatio: acc.total === 0 ? 0 : acc.denies / acc.total,
      }))
      .sort((a, b) => b.total - a.total || a.ruleIndex - b.ruleIndex);

    return { entries, unmatchedCount };
  }, [events]);
}
