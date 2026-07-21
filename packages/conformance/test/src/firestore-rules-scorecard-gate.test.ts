import { describe, expect, it } from 'bun:test';
import {
  compareFirestoreScorecardBaseline,
  firestoreScorecardBaseline,
} from '../../src/firestore-rules-scorecard-gate.ts';
import {
  deriveFirestoreRulesScorecard,
  type FirestoreRulesScorecard,
} from '../../src/firestore-rules-scorecard.ts';
import type { LanguageConstruct } from '../../rules-language/types.ts';

function scorecard(ids: readonly string[]): FirestoreRulesScorecard {
  const constructs: LanguageConstruct[] = ids.map((id) => ({
    id, kind: 'operator', engine: 'firestore', reference: 'test', status: 'accepted',
  }));
  return deriveFirestoreRulesScorecard({
    constructs,
    capabilities: ids.map((id) => ({ id, kind: 'operator', classification: 'implemented', detail: 'test' })),
    coverage: ids.map((id) => ({
      id, kind: 'operator', verdict: 'verified', exercisedBy: ['s'], verifiedBy: ['s'], verifiedByRows: [],
    })),
  });
}

describe('Firestore Rules scorecard baseline gate', () => {
  it('accepts an exact canonical recomputation', () => {
    const current = scorecard(['a', 'b']);
    expect(compareFirestoreScorecardBaseline(firestoreScorecardBaseline(current), current)).toEqual({
      universeChanges: [], factChanges: [], aggregateChanges: [],
    });
  });

  it('names denominator additions and removals instead of hiding them in a percentage', () => {
    const baseline = firestoreScorecardBaseline(scorecard(['a', 'b']));
    const comparison = compareFirestoreScorecardBaseline(baseline, scorecard(['b', 'c']));
    expect(comparison.universeChanges).toEqual(expect.arrayContaining([
      'constructs added: c',
      'constructs removed: a',
    ]));
    expect(comparison.universeChanges.some((change) => change.startsWith('ordered-universe hash'))).toBe(true);
  });

  it('requires explicit baseline review for numerator movement', () => {
    const conformant = scorecard(['a']);
    const baseline = firestoreScorecardBaseline(conformant);
    const unknown = structuredClone(conformant);
    unknown.constructs = [{ ...unknown.constructs[0]!, productionEvidence: 'unverified', classification: 'unknown' }];
    unknown.score = { numerator: 0, denominator: 1, ratio: 0, percent: 0 };
    unknown.counts = { ...unknown.counts, conformant: 0, unknown: 1 };
    unknown.axes = {
      ...unknown.axes,
      productionEvidence: { verified: 0, diverged: 0, unverified: 1 },
    };
    const comparison = compareFirestoreScorecardBaseline(baseline, unknown);
    expect(comparison.factChanges).toEqual(expect.arrayContaining([
      'a: productionEvidence verified -> unverified',
      'a: classification conformant -> unknown',
    ]));
    expect(comparison.aggregateChanges[0]).toContain('score 1/1 (100%) -> 0/1 (0%)');
  });

  it('rejects missing and out-of-universe per-construct baseline facts', () => {
    const current = scorecard(['a', 'b']);
    const baseline = firestoreScorecardBaseline(current);
    const mutableFacts = baseline.constructs as Record<string, unknown>;
    delete mutableFacts.a;
    mutableFacts.ghost = {};

    expect(compareFirestoreScorecardBaseline(baseline, current).factChanges).toEqual(expect.arrayContaining([
      'a: baseline construct facts missing',
      'ghost: baseline construct facts outside universe',
    ]));
  });
});
