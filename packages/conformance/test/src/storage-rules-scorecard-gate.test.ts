import { describe, expect, it } from 'bun:test';
import {
  storageScorecardBaseline,
  compareStorageScorecardBaseline,
} from '../../src/storage-rules-scorecard-gate.ts';
import {
  deriveStorageRulesScorecard,
  type StorageRulesScorecard,
} from '../../src/storage-rules-scorecard.ts';

function scorecard(ids: readonly string[]): StorageRulesScorecard {
  const constructs = ids.map((id) => ({
    id, kind: 'operator' as const, engine: 'storage' as const, reference: 'https://example.com/reference', status: 'accepted' as const,
    probeDigest: { algorithm: 'sha256' as const, value: 'a'.repeat(64) },
    probeEvaluationAgreement: true,
  }));
  return deriveStorageRulesScorecard({
    constructs,
    capabilities: ids.map((id) => ({
      id, kind: 'operator', classification: 'implemented', detail: 'test',
      probeDigest: { algorithm: 'sha256' as const, value: 'a'.repeat(64) },
      evaluationAgreement: true,
    })),
    coverage: ids.map((id) => ({
      id, kind: 'operator', verdict: 'verified', exercisedBy: ['s'], verifiedBy: ['s'], verifiedByRows: [],
    })),
  });
}

describe('Storage Rules scorecard baseline gate', () => {
  it('accepts an exact canonical recomputation', () => {
    const current = scorecard(['a', 'b']);
    expect(compareStorageScorecardBaseline(storageScorecardBaseline(current), current)).toEqual({
      universeChanges: [], factChanges: [], aggregateChanges: [],
    });
  });

  it('names denominator additions and removals instead of hiding them in a percentage', () => {
    const baseline = storageScorecardBaseline(scorecard(['a', 'b']));
    const comparison = compareStorageScorecardBaseline(baseline, scorecard(['b', 'c']));
    expect(comparison.universeChanges).toEqual(expect.arrayContaining([
      'constructs added: c',
      'constructs removed: a',
    ]));
    expect(comparison.universeChanges.some((change) => change.startsWith('ordered-universe hash'))).toBe(true);
  });

  it('rejects missing and out-of-universe per-construct baseline facts', () => {
    const current = scorecard(['a', 'b']);
    const baseline = storageScorecardBaseline(current);
    const mutableFacts = baseline.constructs as Record<string, unknown>;
    delete mutableFacts.a;
    mutableFacts.ghost = {};

    expect(compareStorageScorecardBaseline(baseline, current).factChanges).toEqual(expect.arrayContaining([
      'a: baseline construct facts missing',
      'ghost: baseline construct facts outside universe',
    ]));
  });
});
