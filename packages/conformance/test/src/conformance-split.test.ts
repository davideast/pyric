import { beforeAll, describe, expect, test } from 'bun:test';
import { isCaptureProvenRow, isSelfTestedOnlyRow } from '../../src/behavior-split.ts';
import { buildCompatibilityLedger, summarizeLedger } from '../../src/ledger.ts';
import { findRegressions } from '../../src/coverage-acceptances.ts';
import { buildReport, formatCoverageTable } from '../../src/coverage.ts';
import { canIUse, deriveConformanceModel, type ConformanceModel } from '../../src/conformance-model.ts';
import { renderScoreboardMarkdown, scoreBlock } from '../../src/generate-docs.ts';

let model: ConformanceModel;
beforeAll(async () => {
  model = await deriveConformanceModel();
}, 60_000);

describe('two-number conformance split: capture-proven vs self-tested', () => {
  test('ledger partitions conforming rows into non-overlapping captureProven and selfTested counts', () => {
    const ledger = buildCompatibilityLedger(model);
    const summary = summarizeLedger(ledger, model);

    expect(summary.captureProvenRows).toBeGreaterThan(0);
    expect(summary.selfTestedRows).toBeGreaterThan(0);
    expect(summary.captureProvenRows + summary.selfTestedRows).toBe(summary.conformingRows);

    for (const entry of ledger.entries) {
      if (entry.status === 'conforms') {
        expect(entry.isCaptureProven !== entry.isSelfTestedOnly).toBe(true);
        const expectedCaptureProven =
          entry.automation === 'oracle-backed' &&
          entry.oracleObservations.length > 0 &&
          !entry.risk.includes('cited-not-replayed');
        expect(entry.isCaptureProven).toBe(expectedCaptureProven);
        expect(entry.isSelfTestedOnly).toBe(!expectedCaptureProven);
      } else {
        expect(entry.isCaptureProven).toBe(false);
        expect(entry.isSelfTestedOnly).toBe(false);
      }
    }

    const auth161 = ledger.entries.find((e) => e.id === 'auth#161');
    expect(auth161?.automation).toBe('oracle-backed');
    expect(auth161?.isCaptureProven).toBe(true);
  });

  test('never counts sandbox-only, shape-backed, sample-cited unit-backed, or cited-not-replayed rows as capture-proven', () => {
    const nonReplayCases = [
      {
        status: 'conforms' as const,
        automation: 'sandbox-only' as const,
        oracleObservations: ['ai-sample-observation'],
        risk: [],
      },
      {
        status: 'conforms' as const,
        automation: 'shape-backed' as const,
        oracleObservations: ['ai-shape-observation'],
        risk: [],
      },
      {
        status: 'conforms' as const,
        automation: 'unit-backed' as const,
        oracleObservations: ['rtdb-sample-observation'],
        risk: ['specific-value'],
      },
      {
        status: 'conforms' as const,
        automation: 'oracle-backed' as const,
        oracleObservations: ['messaging-unreplayed-observation'],
        risk: ['cited-not-replayed'],
      },
    ];
    for (const row of nonReplayCases) {
      expect(isCaptureProvenRow(row)).toBe(false);
      expect(isSelfTestedOnlyRow(row)).toBe(true);
    }
    const replayed = {
      status: 'conforms' as const,
      automation: 'oracle-backed' as const,
      oracleObservations: ['auth-link-conflicts'],
      risk: ['error-code'],
    };
    expect(isCaptureProvenRow(replayed)).toBe(true);
    expect(isSelfTestedOnlyRow(replayed)).toBe(false);
  });

  test('coverage report exposes split behavior counts and percentages per service and overall', () => {
    const report = buildReport(model, () => []);
    for (const service of report.services) {
      const b = service.behavior;
      expect(b.captureProven + b.selfTested).toBe(b.conforms);
      expect(typeof b.total.captureProvenPct).toBe('number');
      expect(typeof b.total.selfTestedPct).toBe('number');
      expect(typeof b.intended.captureProvenPct).toBe('number');
      expect(typeof b.intended.selfTestedPct).toBe('number');
    }
    const overall = report.overall.behavior;
    expect(overall.captureProven + overall.selfTested).toBe(overall.conforms);
    expect(overall.captureProven).toBeLessThan(overall.conforms);
    expect(overall.total.captureProvenPct).toBeLessThan(overall.total.pct);

    const table = formatCoverageTable(report, model);
    expect(table).toContain('proven(total)');
    expect(table).toContain('proven(intended)');
    expect(table).toContain('self-tested(total)');
    expect(table).toContain('self-tested(intended)');
  });

  test('findRegressions remains backwards-compatible with older base reports lacking split fields', () => {
    const head = buildReport(model, () => []);
    const legacyBase = {
      generatedAt: '2026-11-01T00:00:00.000Z',
      services: head.services.map((s) => ({
        surface: s.surface,
        kind: s.kind,
        censusSurface: s.censusSurface,
        surfaceCoverage: s.surfaceCoverage,
        behavior: {
          conforms: s.behavior.conforms,
          divergedDocumented: s.behavior.divergedDocumented,
          bug: s.behavior.bug,
          unsupported: s.behavior.unsupported,
          unverified: s.behavior.unverified,
          total: { denominator: s.behavior.total.denominator, pct: s.behavior.total.pct },
          intended: { denominator: s.behavior.intended.denominator, pct: s.behavior.intended.pct },
        },
      })),
      overall: {
        surfaceCoverage: head.overall.surfaceCoverage,
        behavior: {
          conforms: head.overall.behavior.conforms,
          divergedDocumented: head.overall.behavior.divergedDocumented,
          bug: head.overall.behavior.bug,
          unsupported: head.overall.behavior.unsupported,
          unverified: head.overall.behavior.unverified,
          total: { denominator: head.overall.behavior.total.denominator, pct: head.overall.behavior.total.pct },
          intended: { denominator: head.overall.behavior.intended.denominator, pct: head.overall.behavior.intended.pct },
        },
      },
      orphanObservations: head.orphanObservations,
      highRiskUnverified: head.highRiskUnverified,
      rowStatuses: head.rowStatuses,
      entryPath: head.entryPath,
    };
    expect(findRegressions(legacyBase, head, [])).toEqual([]);
  });

  test('generated docs and canIUse summaries distinguish capture-proven from self-tested conformance', () => {
    const authRegistry = model.documentation.registries.find((r) => r.surface === 'auth');
    if (!authRegistry) throw new Error('missing auth registry');
    const block = scoreBlock(authRegistry, model.documentation);
    expect(block).not.toBeNull();
    expect(block).toContain('proven by a Firebase capture');
    expect(block).toContain("pass Pyric's own tests only");

    const scoreboard = renderScoreboardMarkdown(model);
    expect(scoreboard).toContain('proven by a Firebase capture');
    expect(scoreboard).toContain("Pyric's own tests only");

    const captureBacked = canIUse(model, 'auth/createUserWithEmailAndPassword');
    expect(captureBacked.match).toBe('exact');
    expect(captureBacked.supports[0]?.summary).toContain('proven by a Firebase capture');

    const selfTested = canIUse(model, 'auth/TwitterAuthProvider');
    expect(selfTested.match).toBe('exact');
    expect(selfTested.supports[0]?.summary).toContain("passes Pyric's own tests only");

    const aiScript = canIUse(model, 'ai/script');
    expect(aiScript.match).toBe('exact');
    expect(aiScript.supports[0]?.summary).toContain("passes Pyric's own tests only");
    expect(aiScript.supports[0]?.summary).not.toContain('proven by a Firebase capture');
  });
});
