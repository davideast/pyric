import { beforeAll, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  buildCompatibilityLedger,
  evidenceTierGapRows,
  highRiskUnverifiedRows,
  type CompatibilityLedger,
  type RegistryEntry,
} from '../../src/ledger.ts';
import { deriveConformanceModel } from '../../src/conformance-model.ts';
import { BASELINE_PATH, diffAgainstBaseline } from '../../src/audit-gate.ts';
import { messagingRows } from '../../registry/messaging.ts';

let ledger: CompatibilityLedger;
beforeAll(async () => {
  ledger = buildCompatibilityLedger(await deriveConformanceModel());
}, 60_000);

function baselineIds(): string[] {
  return (JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as { ids: string[] }).ids;
}

function withEntries(entries: RegistryEntry[]): CompatibilityLedger {
  return { entries, observations: [], observationExceptions: {}, orphanObservations: [] };
}

describe('evidence-tier audit worklist', () => {
  it('keeps climb risk on every unit-backed messaging conforms row (nothing stripped by flipping)', () => {
    const unitBacked = messagingRows.filter((row) => row.status === 'conforms' && row.automation === 'unit-backed');
    // 40 after #440 downgraded messaging#10 (FcmOptions, a type-only shape with
    // no runtime carrier) from unit-backed to the type-backed shape tier.
    expect(unitBacked.length).toBe(40);
    for (const row of unitBacked) {
      expect(row.riskReasons.length).toBeGreaterThan(0);
      expect(row.risk.some((token) => token === 'unobserved' || token === 'cited-not-replayed')).toBe(true);
      expect(row.riskScore).toBeGreaterThan(0);
    }
  });

  it('discharges climb risk only on oracle-backed flips (observation replayed by the suite)', () => {
    const oracleBacked = messagingRows.filter((row) => row.status === 'conforms' && row.automation === 'oracle-backed');
    expect(oracleBacked.length).toBeGreaterThan(0);
    for (const row of oracleBacked) {
      expect(row.oracleObservations.length).toBeGreaterThan(0);
      expect(row.risk).toEqual([]);
    }
  });

  it('surfaces unit-backed conforms rows with unobserved-behavior risk to the audit', () => {
    const worklist = evidenceTierGapRows(ledger);
    const ids = new Set(worklist.map((row) => row.id));
    const messagingUnitBacked = messagingRows.filter(
      (row) => row.status === 'conforms' && row.automation === 'unit-backed',
    );
    expect(messagingUnitBacked.length).toBe(40); // #440 downgraded messaging#10 to type-backed
    for (const row of messagingUnitBacked) expect(ids.has(row.id)).toBe(true);
  });

  it('leaves mature unit-backed rows with assertion-shaped risk out of the worklist', () => {
    const structural = ledger.entries.find(
      (row) => row.isConforming && row.automation === 'unit-backed' && row.risk.includes('structural'),
    );
    expect(structural).toBeTruthy();
    const flagged = evidenceTierGapRows(withEntries([structural!]));
    expect(flagged).toEqual([]);
  });

  it('absorbs the current debt in the audit baseline (gate stays green on this tree)', () => {
    const current = [
      ...highRiskUnverifiedRows(ledger).map((row) => row.id),
      ...evidenceTierGapRows(ledger).map((row) => row.id),
    ];
    const { introduced } = diffAgainstBaseline([...new Set(current)].sort(), baselineIds());
    expect(introduced).toEqual([]);
  });

  it('fails the ratchet for a new unit-backed conforms row not in the baseline', () => {
    const template = evidenceTierGapRows(ledger)[0]!;
    const synthetic: RegistryEntry = { ...template, id: 'messaging#999', rowRef: '999', rowNumber: 999 };
    const flagged = evidenceTierGapRows(withEntries([...ledger.entries, synthetic]));
    expect(flagged.some((row) => row.id === 'messaging#999')).toBe(true);

    const current = [
      ...highRiskUnverifiedRows(ledger).map((row) => row.id),
      ...flagged.map((row) => row.id),
    ];
    const { introduced } = diffAgainstBaseline([...new Set(current)].sort(), baselineIds());
    expect(introduced).toEqual(['messaging#999']);
  });
});
