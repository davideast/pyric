import { describe, expect, it } from 'bun:test';
import { allCompatibilityRows } from '../../registry/index.ts';
import { loadObservations } from '../../observations/load.ts';
import { loadSnapshot } from '../../rules-language/load.ts';
import { surfaceDescriptors } from '../../surfaces/load.ts';
import { computeFirestoreRulesScorecard } from '../../src/firestore-rules-scorecard.ts';

describe('Firestore Rules CDD climb completeness', () => {
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
