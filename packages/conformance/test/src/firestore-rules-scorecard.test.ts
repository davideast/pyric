import { describe, expect, it } from 'bun:test';
import type { LanguageConstruct } from '../../rules-language/types.ts';
import type { ConstructCapability } from '../../src/rules-language-capability.ts';
import type { ConstructCoverage } from '../../src/rules-language-analyzer.ts';
import {
  computeFirestoreRulesScorecard,
  deriveFirestoreRulesScorecard,
  firestoreUniverseHash,
} from '../../src/firestore-rules-scorecard.ts';

function construct(id: string, status: LanguageConstruct['status'] = 'accepted'): LanguageConstruct {
  return {
    id, kind: 'function', engine: 'firestore', reference: 'test', status,
    ...(status === 'rejected' ? { probeNote: 'Property id is undefined on object.' } : {}),
  };
}

function capability(
  id: string,
  classification: ConstructCapability['classification'] = 'implemented',
): ConstructCapability {
  return {
    id,
    kind: 'function',
    classification,
    detail: classification === 'error' ? "eval error: No field 'id' on map" : 'test',
  };
}

function coverage(
  id: string,
  verdict: ConstructCoverage['verdict'] = 'verified',
): ConstructCoverage {
  return {
    id,
    kind: 'function',
    verdict,
    exercisedBy: verdict === 'unverified' ? [] : ['scenario'],
    verifiedBy: verdict === 'unverified' ? [] : ['scenario'],
    verifiedByRows: [],
    ...(verdict === 'diverged' ? { divergedByRows: ['firestore-rules#1'] } : {}),
  };
}

describe('Firestore Rules scorecard', () => {
  it('requires acceptance, capability, and uncontaminated evidence for credit', () => {
    const constructs = [
      construct('conformant'),
      construct('diverged'),
      construct('rejected', 'rejected'),
      construct('rejection-parity', 'rejected'),
      construct('unknown'),
      construct('unsupported'),
      construct('error'),
      construct('unprobeable', 'unprobeable'),
      construct('unprobed', 'unprobed'),
    ];
    const scorecard = deriveFirestoreRulesScorecard({
      constructs,
      capabilities: [
        capability('conformant'), capability('diverged'), capability('rejected'), capability('rejection-parity', 'error'),
        capability('unknown'), capability('unsupported', 'unsupported'), capability('error', 'error'),
        capability('unprobeable', 'unprobeable'), capability('unprobed'),
      ],
      coverage: [
        coverage('conformant'), coverage('diverged', 'diverged'), coverage('rejected'), coverage('rejection-parity'),
        coverage('unknown', 'unverified'), coverage('unsupported'), coverage('error'),
        coverage('unprobeable', 'unverified'), coverage('unprobed', 'unverified'),
      ],
    });

    expect(scorecard.score).toEqual({ numerator: 2, denominator: 9, ratio: 2 / 9, percent: 22.2 });
    expect(scorecard.counts).toEqual({
      conformant: 2,
      diverged: 1,
      unknown: 2,
      'acceptance-mismatch': 1,
      'local-unsupported': 1,
      'local-error': 1,
      unprobeable: 1,
    });
    expect(scorecard.axes).toEqual({
      productionAcceptance: { unprobed: 1, accepted: 5, rejected: 2, unprobeable: 1 },
      localAcceptance: { accepted: 5, rejected: 2, unsupported: 1, unprobeable: 1 },
      localCapability: { implemented: 5, unsupported: 1, error: 2, unprobeable: 1 },
      productionEvidence: { verified: 5, diverged: 1, unverified: 3 },
    });
  });

  it('lets negative evidence dominate a production rejection', () => {
    const scorecard = deriveFirestoreRulesScorecard({
      constructs: [construct('x', 'rejected')],
      capabilities: [capability('x')],
      coverage: [coverage('x', 'diverged')],
    });
    expect(scorecard.constructs[0]?.classification).toBe('diverged');
  });

  it('does not credit a rejection at a different observable boundary', () => {
    const scorecard = deriveFirestoreRulesScorecard({
      constructs: [construct('x', 'rejected')],
      capabilities: [{ ...capability('x', 'error'), detail: "eval error: No field 'other' on map" }],
      coverage: [coverage('x')],
    });
    expect(scorecard.constructs[0]?.classification).toBe('acceptance-mismatch');
  });

  it('rejects incomplete or out-of-universe joins', () => {
    expect(() => deriveFirestoreRulesScorecard({
      constructs: [construct('x')], capabilities: [], coverage: [coverage('x')],
    })).toThrow('missing capability');
    expect(() => deriveFirestoreRulesScorecard({
      constructs: [construct('x')], capabilities: [capability('x'), capability('ghost')], coverage: [coverage('x')],
    })).toThrow('outside the universe');
    expect(() => deriveFirestoreRulesScorecard({
      constructs: [construct('x')],
      capabilities: [capability('x'), capability('x', 'error')],
      coverage: [coverage('x')],
    })).toThrow('capability input contains duplicate ids: x');
    expect(() => deriveFirestoreRulesScorecard({
      constructs: [construct('x')],
      capabilities: [capability('x')],
      coverage: [coverage('x'), coverage('x', 'unverified')],
    })).toThrow('coverage input contains duplicate ids: x');
  });

  it('hashes the ordered universe deterministically and notices order changes', () => {
    expect(firestoreUniverseHash(['a', 'b'])).toBe(firestoreUniverseHash(['a', 'b']));
    expect(firestoreUniverseHash(['a', 'b'])).not.toBe(firestoreUniverseHash(['b', 'a']));
  });

  it('pins the current honest baseline over all 140 constructs', async () => {
    const scorecard = await computeFirestoreRulesScorecard();
    expect(scorecard.universe.denominator).toBe(140);
    expect(scorecard.score).toEqual({ numerator: 126, denominator: 140, ratio: 126 / 140, percent: 90 });
    expect(scorecard.counts).toEqual({
      conformant: 126,
      diverged: 2,
      unknown: 0,
      'acceptance-mismatch': 6,
      'local-unsupported': 0,
      'local-error': 3,
      unprobeable: 3,
    });
    expect(scorecard.axes).toEqual({
      productionAcceptance: { unprobed: 0, accepted: 126, rejected: 11, unprobeable: 3 },
      localAcceptance: { accepted: 131, rejected: 6, unsupported: 0, unprobeable: 3 },
      localCapability: { implemented: 131, unsupported: 0, error: 6, unprobeable: 3 },
      productionEvidence: { verified: 129, diverged: 2, unverified: 9 },
    });
  });
});
