import { describe, expect, it } from 'bun:test';
import {
  rtdbScorecardBaseline,
  compareRtdbScorecardBaseline,
} from '../../src/rtdb-rules-scorecard-gate.ts';
import {
  deriveRtdbRulesScorecard,
  type RtdbRulesScorecard,
} from '../../src/rtdb-rules-scorecard.ts';

function scorecard(ids: readonly string[]): RtdbRulesScorecard {
  const constructs = ids.map((id) => ({
    id, kind: 'binding' as const, engine: 'rtdb' as const, reference: 'https://example.com/reference', status: 'accepted' as const,
  }));
  return deriveRtdbRulesScorecard({
    constructs,
    capabilities: ids.map((id) => ({
      id, kind: 'binding', classification: 'implemented', detail: 'test',
    })),
    coverage: ids.map((id) => ({
      id, kind: 'binding', verdict: 'verified', exercisedBy: ['s'], verifiedBy: ['s'], verifiedByRows: [],
    })),
  });
}

describe('RTDB Rules scorecard baseline gate', () => {
  it('accepts an exact canonical recomputation', () => {
    const current = scorecard(['a', 'b']);
    expect(compareRtdbScorecardBaseline(rtdbScorecardBaseline(current), current)).toEqual({
      universeChanges: [], factChanges: [], aggregateChanges: [],
    });
  });

  it('names denominator additions and removals instead of hiding them in a percentage', () => {
    const baseline = rtdbScorecardBaseline(scorecard(['a', 'b']));
    const comparison = compareRtdbScorecardBaseline(baseline, scorecard(['b', 'c']));
    expect(comparison.universeChanges).toEqual(expect.arrayContaining([
      'constructs added: c',
      'constructs removed: a',
    ]));
    expect(comparison.universeChanges.some((change) => change.startsWith('ordered-universe hash'))).toBe(true);
  });

  it('rejects missing and out-of-universe per-construct baseline facts', () => {
    const current = scorecard(['a', 'b']);
    const baseline = rtdbScorecardBaseline(current);
    const mutableFacts = baseline.constructs as Record<string, unknown>;
    delete mutableFacts.a;
    mutableFacts.ghost = {};

    expect(compareRtdbScorecardBaseline(baseline, current).factChanges).toEqual(expect.arrayContaining([
      'a: baseline construct facts missing',
      'ghost: baseline construct facts outside universe',
    ]));
  });
});

describe('RTDB Rules scorecard classification', () => {
  function classify(
    status: 'accepted' | 'rejected',
    capability: { classification: 'implemented' | 'error'; evaluationAgreement?: boolean },
  ): string {
    const card = deriveRtdbRulesScorecard({
      constructs: [{ id: 'c', kind: 'binding', engine: 'rtdb', reference: 'https://example.com/reference', status, ...(status === 'rejected' ? { probeNote: 'x' } : {}) }],
      capabilities: [{ id: 'c', kind: 'binding', detail: 'test', ...capability }],
      coverage: [{ id: 'c', kind: 'binding', verdict: 'verified', exercisedBy: ['s'], verifiedBy: ['s'], verifiedByRows: [] }],
    });
    return card.constructs[0]!.classification;
  }

  it('credits a construct production rejects only when the local check rejects it too', () => {
    expect(classify('rejected', { classification: 'error' })).toBe('conformant');
    expect(classify('rejected', { classification: 'implemented' })).toBe('acceptance-mismatch');
  });

  it('withholds credit when the local verdict disagrees with the captured production verdict', () => {
    expect(classify('accepted', { classification: 'implemented', evaluationAgreement: false })).toBe('acceptance-mismatch');
    expect(classify('accepted', { classification: 'implemented', evaluationAgreement: true })).toBe('conformant');
    expect(classify('accepted', { classification: 'implemented' })).toBe('conformant');
  });
});
