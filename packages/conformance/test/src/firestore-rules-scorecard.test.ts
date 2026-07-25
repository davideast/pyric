import { describe, expect, it } from 'bun:test';
import { allCompatibilityRows } from '../../registry/index.ts';
import { loadObservations } from '../../observations/load.ts';
import { loadSnapshot } from '../../rules-language/load.ts';
import { surfaceDescriptors } from '../../surfaces/load.ts';
import type { LanguageConstruct } from '../../rules-language/types.ts';
import type { ConstructCapability } from '../../src/rules-language-capability.ts';
import type { ConstructCoverage } from '../../src/rules-language-coverage.ts';
import {
  computeFirestoreRulesScorecard,
  deriveFirestoreRulesScorecard,
  firestoreUniverseHash,
} from '../../src/firestore-rules-scorecard.ts';

function construct(id: string, status: LanguageConstruct['status'] = 'accepted'): LanguageConstruct {
  return {
    id, kind: 'function', engine: 'firestore', reference: 'test', status,
    ...(status === 'accepted' || status === 'rejected'
      ? { probeDigest: { algorithm: 'sha256' as const, value: 'a'.repeat(64) } }
      : {}),
    ...(status === 'accepted' ? { probeEvaluationAgreement: true } : {}),
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
    probeDigest: { algorithm: 'sha256', value: 'a'.repeat(64) },
    evaluationAgreement: classification === 'implemented',
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

  it('withholds credit when production acceptance came from a stale probe', () => {
    const scorecard = deriveFirestoreRulesScorecard({
      constructs: [{ ...construct('x'), probeDigest: { algorithm: 'sha256', value: 'b'.repeat(64) } }],
      capabilities: [capability('x')],
      coverage: [coverage('x')],
    });
    expect(scorecard.constructs[0]?.acceptanceProbeBound).toBe(false);
    expect(scorecard.constructs[0]?.classification).toBe('unknown');
  });

  it('requires a proving registry row for hierarchical match semantics', () => {
    const id = 'firestore.semantic.hierarchical-match-cascade';
    const withoutRow = deriveFirestoreRulesScorecard({
      constructs: [construct(id)], capabilities: [capability(id)], coverage: [coverage(id)],
    });
    expect(withoutRow.constructs[0]?.classification).toBe('unknown');
    const withRow = deriveFirestoreRulesScorecard({
      constructs: [construct(id)], capabilities: [capability(id)],
      coverage: [{ ...coverage(id), verifiedByRows: ['firestore-rules#187'] }],
    });
    expect(withRow.constructs[0]?.classification).toBe('conformant');

    const unrelatedRow = deriveFirestoreRulesScorecard({
      constructs: [construct(id)], capabilities: [capability(id)],
      coverage: [{ ...coverage(id), verifiedByRows: ['firestore-rules#160'] }],
    });
    expect(unrelatedRow.constructs[0]?.classification).toBe('unknown');
  });

  it('withholds credit when an accepted local probe returns the wrong verdict', () => {
    const scorecard = deriveFirestoreRulesScorecard({
      constructs: [construct('x')],
      capabilities: [{ ...capability('x'), evaluationAgreement: false, detail: 'decision DENY' }],
      coverage: [coverage('x')],
    });
    expect(scorecard.constructs[0]?.classification).toBe('acceptance-mismatch');
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
    expect(scorecard.score).toEqual({ numerator: 136, denominator: 140, ratio: 136 / 140, percent: 97.1 });
    expect(scorecard.counts).toEqual({
      conformant: 136,
      diverged: 0,
      unknown: 0,
      'acceptance-mismatch': 1,
      'local-unsupported': 0,
      'local-error': 0,
      unprobeable: 3,
    });
    expect(scorecard.axes).toEqual({
      productionAcceptance: { unprobed: 0, accepted: 128, rejected: 9, unprobeable: 3 },
      localAcceptance: { accepted: 129, rejected: 8, unsupported: 0, unprobeable: 3 },
      localCapability: { implemented: 129, unsupported: 0, error: 8, unprobeable: 3 },
      productionEvidence: { verified: 137, diverged: 0, unverified: 3 },
    });
  });
});

describe('Firestore Rules scorecard CDD completeness', () => {
  const rows = allCompatibilityRows.filter(({ surface }) => surface === 'firestore-rules');
  const observations = loadObservations().filter(({ name }) => name.startsWith('rules-firestore-'));

  it('enables the climb only with the oracle suite attached', () => {
    const descriptor = surfaceDescriptors.find(({ surface }) => surface === 'firestore-rules');
    expect(descriptor).toMatchObject({
      climb: true,
      conformanceSuite: 'packages/pyric/test/rules/oracle-conformance.test.ts',
    });
  });

  it('maps every row to exactly one observation and every observation to exactly one row', () => {
    const rowIds = new Set(rows.map(({ id }) => id));
    const citedByObservation = new Map<string, string[]>();
    for (const observation of observations) {
      expect(observation.rowIds).toHaveLength(1);
      const rowId = observation.rowIds[0]!;
      expect(rowIds.has(rowId), `${observation.name} cites unknown row ${rowId}`).toBe(true);
      citedByObservation.set(rowId, [...(citedByObservation.get(rowId) ?? []), observation.name]);
    }
    for (const row of rows) {
      const citations = citedByObservation.get(row.id) ?? [];
      expect(citations, `${row.id} has no unique observation assertion set`).toHaveLength(1);
      expect(row.oracleObservations).toEqual(citations);
    }
    expect(observations).toHaveLength(rows.length);
  });

  it('keeps every construct in the scorecard with an explicit acceptance, capability, and evidence fact', async () => {
    const snapshot = loadSnapshot('firestore');
    const scorecard = await computeFirestoreRulesScorecard();
    expect(scorecard.universe.constructIds).toEqual(snapshot.constructs.map(({ id }) => id));
    expect(scorecard.constructs).toHaveLength(snapshot.constructs.length);
    for (const construct of scorecard.constructs) {
      expect(construct.productionAcceptance).not.toBe('unprobed');
      expect(construct.localCapability).toBeTruthy();
      expect(construct.productionEvidence).toBeTruthy();
    }
  });

  it('classifies every non-conforming row with a reviewed disposition', () => {
    for (const row of rows.filter(({ status }) => status !== 'conforms')) {
      expect(
        row.conformanceDisposition,
        `${row.id} must be pending-fix, held, by-design, or a probe-limitation`,
      ).toBeTruthy();
    }
  });
});
