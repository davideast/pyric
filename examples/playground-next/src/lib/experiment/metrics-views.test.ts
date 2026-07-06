/** Tests for the view layer (issue M3/#508) — pure functions, no I/O. */
import { describe, test, expect } from 'bun:test';
import { aggregate, sortByCostPerCorrect, renderDecisionGrid, renderVariantDiff } from './metrics-views';
import type { MetricsRecord } from './metrics-store';

function rec(over: Partial<MetricsRecord> & { ok: boolean; cost: number; tin: number }): MetricsRecord {
  const { ok, cost, tin, ...rest } = over;
  return {
    runId: 'r', ranAt: '2026-06-07T00:00:00Z', gitSha: 'sha',
    model: { id: 'A', endpoint: 'e', paid: true },
    strategy: { name: 'react' },
    fixture: { id: 'f' },
    trial: 0,
    variant: 'baseline',
    correctness: { ok, casesPassed: ok ? 5 : 0, casesTotal: 5 },
    tokens: { in: tin, out: 100, cached: 0, reasoning: 0, total: tin + 100 },
    costUsd: cost,
    costSource: cost > 0 ? 'usage.cost' : 'none',
    durationMs: 10000,
    turns: 5,
    toolCalls: [],
    ...rest,
  } as MetricsRecord;
}

describe('metrics views', () => {
  test('aggregate groups by model·strategy·variant + derives $/correct', () => {
    const recs = [
      rec({ ok: true, cost: 0.05, tin: 1000, fixture: { id: 'f1' } }),
      rec({ ok: true, cost: 0.05, tin: 1000, fixture: { id: 'f2' } }),
    ];
    const aggs = aggregate(recs);
    expect(aggs).toHaveLength(1);
    expect(aggs[0]!.passes).toBe(2);
    expect(aggs[0]!.costTotal).toBeCloseTo(0.1, 5);
    expect(aggs[0]!.costPerCorrect).toBeCloseTo(0.05, 5); // 0.10 / 2 passes
  });

  test('sortByCostPerCorrect: cheaper-per-correct first, 0-pass last', () => {
    const recs = [
      // react baseline: 1/2 pass, $0.10 → $0.10/correct
      rec({ ok: true, cost: 0.05, tin: 1, strategy: { name: 'react' }, fixture: { id: 'a' } }),
      rec({ ok: false, cost: 0.05, tin: 1, strategy: { name: 'react' }, fixture: { id: 'b' } }),
      // draft-validate: 2/2 pass, $0.04 → $0.02/correct (best)
      rec({ ok: true, cost: 0.02, tin: 1, strategy: { name: 'draft-validate' }, fixture: { id: 'a' } }),
      rec({ ok: true, cost: 0.02, tin: 1, strategy: { name: 'draft-validate' }, fixture: { id: 'b' } }),
      // bad: 0/1 pass → null cost/correct → last
      rec({ ok: false, cost: 0.01, tin: 1, strategy: { name: 'react+reflexion' }, fixture: { id: 'a' } }),
    ];
    const sorted = sortByCostPerCorrect(aggregate(recs));
    expect(sorted[0]!.strategy).toBe('draft-validate'); // $0.02/correct
    expect(sorted[1]!.strategy).toBe('react'); // $0.10/correct
    expect(sorted[2]!.strategy).toBe('react+reflexion'); // 0 passes → last
    expect(sorted[2]!.costPerCorrect).toBeNull();
  });

  test('decision grid renders a markdown table sorted by $/correct', () => {
    const recs = [rec({ ok: true, cost: 0.05, tin: 1000 })];
    const out = renderDecisionGrid(recs);
    expect(out).toContain('Decision grid');
    expect(out).toContain('$/correct');
    expect(out).toContain('A · react · baseline');
  });

  test('variant-diff shows baseline→variant cost change', () => {
    const recs = [
      rec({ ok: true, cost: 0.1, tin: 10000, variant: 'baseline' }),
      rec({ ok: true, cost: 0.02, tin: 10000, variant: 'caching' }),
    ];
    const out = renderVariantDiff(recs, 'baseline', 'caching', { model: 'A', strategy: 'react' });
    expect(out).toContain('baseline → caching');
    expect(out).toContain('$0.100 → $0.020'); // cost dropped
  });
});
