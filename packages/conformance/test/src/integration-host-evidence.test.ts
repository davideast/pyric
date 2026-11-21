import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, test } from 'bun:test';
import { allCompatibilityRows, type CompatibilityRow } from '../../registry/index.ts';
import { surfaceDescriptors } from '../../surfaces/load.ts';
import { observationExceptions } from '../../exceptions/load.ts';
import { buildCompatibilityLedger, loadObservations, REPO_ROOT } from '../../src/ledger.ts';
import { validateCompatibilityRegistry } from '../../src/validate-registry.ts';
import { deriveConformanceModel, type ConformanceModel } from '../../src/conformance-model.ts';
import { buildReport } from '../../src/coverage.ts';
import {
  deriveRegistryRowVerdict,
  loadConformanceGraph,
  validationProblems,
} from '../../src/conformance-verdicts.ts';
import {
  hasLiveHostConformanceEvidence,
  isMockBridgeUnitTestPath,
  normalizeConformanceTestPath,
} from '../../src/integration-host-evidence.ts';

const NATIVE_CLIENT_SURFACES = [
  'ai-flutter',
  'ai-kotlin',
  'ai-swift',
  'app-check-flutter',
  'app-check-kotlin',
  'app-check-swift',
  'auth-flutter',
  'auth-kotlin',
  'auth-swift',
  'crashlytics-flutter',
  'crashlytics-kotlin',
  'crashlytics-swift',
  'firestore-flutter',
  'firestore-kotlin',
  'firestore-swift',
  'functions-flutter',
  'functions-kotlin',
  'functions-swift',
  'messaging-flutter',
  'messaging-kotlin',
  'messaging-swift',
  'rtdb-flutter',
  'rtdb-kotlin',
  'rtdb-swift',
  'storage-flutter',
  'storage-kotlin',
  'storage-swift',
] as const;

const LIVE_HOST_NATIVE_SUITES = [
  'packages/cli/test/serve/native-kotlin-conformance.test.ts',
  'packages/cli/test/serve/native-swift-conformance.test.ts',
] as const;

const FIVE_BROKEN_BEHAVIOR_FAMILIES: Record<string, readonly string[]> = {
  mergeWrite: [
    'firestore-kotlin#16',
    'firestore-flutter#16',
    'firestore-swift#28',
    'firestore-swift#29',
  ],
  batches: [
    'firestore-kotlin#7',
    'firestore-kotlin#45',
    'firestore-kotlin#46',
    'firestore-kotlin#47',
    'firestore-kotlin#48',
    'firestore-flutter#7',
    'firestore-flutter#45',
    'firestore-flutter#46',
    'firestore-flutter#47',
    'firestore-flutter#48',
    'firestore-swift#10',
    'firestore-swift#79',
    'firestore-swift#80',
    'firestore-swift#81',
    'firestore-swift#82',
    'firestore-swift#83',
    'firestore-swift#84',
  ],
  transactions: [
    'firestore-kotlin#8',
    'firestore-kotlin#49',
    'firestore-kotlin#50',
    'firestore-kotlin#51',
    'firestore-kotlin#52',
    'firestore-kotlin#53',
    'firestore-flutter#8',
    'firestore-flutter#49',
    'firestore-flutter#50',
    'firestore-flutter#51',
    'firestore-flutter#52',
    'firestore-flutter#53',
    'firestore-swift#11',
    'firestore-swift#12',
    'firestore-swift#13',
    'firestore-swift#85',
    'firestore-swift#86',
    'firestore-swift#87',
    'firestore-swift#88',
    'firestore-swift#89',
    'firestore-swift#90',
    'firestore-swift#91',
    'rtdb-flutter#tx-run',
    'rtdb-flutter#tx-abort',
    'rtdb-kotlin#tx-run',
    'rtdb-kotlin#tx-abort',
    'rtdb-swift#tx-run',
    'rtdb-swift#tx-abort',
  ],
  valueDecodingAndCodecs: [
    'firestore-kotlin#42',
    'firestore-kotlin#59',
    'firestore-kotlin#60',
    'firestore-kotlin#61',
    'firestore-kotlin#62',
    'firestore-kotlin#63',
    'firestore-flutter#40',
    'firestore-flutter#59',
    'firestore-flutter#60',
    'firestore-flutter#61',
    'firestore-flutter#62',
    'firestore-flutter#63',
    'firestore-swift#68',
    'firestore-swift#97',
    'firestore-swift#98',
    'firestore-swift#99',
    'firestore-swift#103',
    'firestore-swift#104',
    'firestore-swift#105',
    'rtdb-flutter#snap-value',
    'rtdb-kotlin#snap-value',
    'rtdb-swift#snap-value',
  ],
  namedDatabaseInstances: [
    'rtdb-flutter#instance-url',
    'rtdb-kotlin#instance-url',
    'rtdb-swift#instance-url',
    'firestore-flutter#2',
    'firestore-kotlin#2',
    'firestore-swift#3',
    'firestore-swift#4',
  ],
};

let model: ConformanceModel;
beforeAll(async () => {
  model = await deriveConformanceModel();
}, 60_000);

function replaceRow(targetId: string, mutate: (row: CompatibilityRow) => CompatibilityRow): CompatibilityRow[] {
  return allCompatibilityRows.map((row) => {
    if (row.id === targetId) return mutate(row);
    return row;
  });
}

function assertExistingNonMockHostSuites(row: CompatibilityRow, context: string): void {
  expect(hasLiveHostConformanceEvidence(row), `${context}: expected live-host conformance evidence`).toBe(true);
  const hostTests = row.hostConformanceTests;
  expect(hostTests, `${context}: missing hostConformanceTests`).toBeDefined();
  if (hostTests === undefined) {
    return;
  }
  expect(hostTests.length, `${context}: empty hostConformanceTests`).toBeGreaterThan(0);
  for (const rawPath of hostTests) {
    const normalized = normalizeConformanceTestPath(rawPath);
    expect(normalized.length, `${context}: blank hostConformanceTests entry`).toBeGreaterThan(0);
    expect(isMockBridgeUnitTestPath(normalized), `${context}: mock-bridge suite ${rawPath}`).toBe(false);
    expect(existsSync(join(REPO_ROOT, normalized)), `${context}: missing host suite ${normalized}`).toBe(true);
  }
}

describe('integration surfaces require live-host conformance evidence', () => {
  test('validateCompatibilityRegistry rejects integration conforms rows lacking hostConformanceTests', () => {
    const observations = loadObservations();
    const withoutHostTests = validateCompatibilityRegistry({
      rows: replaceRow('firestore-kotlin#16', (row) => ({
        ...row,
        status: 'conforms',
        hostConformanceTests: undefined,
      })),
      descriptors: surfaceDescriptors,
      observations,
      observationExceptions,
    });
    expect(
      withoutHostTests.some((p) => p.includes('firestore-kotlin#16') && p.includes('hostConformanceTests')),
    ).toBe(true);

    const withMockBridgeSuite = validateCompatibilityRegistry({
      rows: replaceRow('firestore-kotlin#16', (row) => ({
        ...row,
        status: 'conforms',
        hostConformanceTests: ['packages/kt-client/src/test/kotlin/dev/pyric/firestore/ConformanceTest.kt'],
      })),
      descriptors: surfaceDescriptors,
      observations,
      observationExceptions,
    });
    expect(
      withMockBridgeSuite.some((p) => p.includes('firestore-kotlin#16') && p.includes('mock-bridge')),
    ).toBe(true);

    for (const nonCanonicalMockPath of [
      './packages/kt-client/src/test/kotlin/dev/pyric/firestore/ConformanceTest.kt',
      'packages//flutter-client/test/conformance_test.dart',
      'packages/swift-client/Sources/../Tests/PyricAuthTests/AuthConformanceTests.swift',
    ]) {
      expect(isMockBridgeUnitTestPath(nonCanonicalMockPath)).toBe(true);
      const nonCanonicalProblems = validateCompatibilityRegistry({
        rows: replaceRow('firestore-kotlin#16', (row) => ({
          ...row,
          status: 'conforms',
          hostConformanceTests: [nonCanonicalMockPath],
        })),
        descriptors: surfaceDescriptors,
        observations,
        observationExceptions,
      });
      expect(
        nonCanonicalProblems.some((p) => p.includes('firestore-kotlin#16') && p.includes('mock-bridge')),
      ).toBe(true);
    }
    expect(normalizeConformanceTestPath(' ./packages//cli/test/functions-http/oracle-conformance.test.ts ')).toBe(
      'packages/cli/test/functions-http/oracle-conformance.test.ts',
    );

    const withMissingSuite = validateCompatibilityRegistry({
      rows: replaceRow('firestore-kotlin#16', (row) => ({
        ...row,
        status: 'conforms',
        hostConformanceTests: ['test/apps/missing-host-e2e/scenario.ts'],
      })),
      descriptors: surfaceDescriptors,
      observations,
      observationExceptions,
    });
    expect(
      withMissingSuite.some((p) => p.includes('test/apps/missing-host-e2e/scenario.ts')),
    ).toBe(true);

    for (const liveHostSuite of LIVE_HOST_NATIVE_SUITES) {
      expect(isMockBridgeUnitTestPath(liveHostSuite)).toBe(false);
      expect(hasLiveHostConformanceEvidence({ hostConformanceTests: [liveHostSuite] })).toBe(true);
      expect(existsSync(join(REPO_ROOT, liveHostSuite))).toBe(true);

      const withLiveHostSuite = validateCompatibilityRegistry({
        rows: replaceRow('firestore-kotlin#16', (row) => ({
          ...row,
          status: 'conforms',
          statusNote: undefined,
          hostConformanceTests: [liveHostSuite],
        })),
        descriptors: surfaceDescriptors,
        observations,
        observationExceptions,
      });
      expect(
        withLiveHostSuite.filter((p) => p.includes('firestore-kotlin#16') || p.includes('hostConformanceTests')),
      ).toEqual([]);
    }
  }, 60_000);

  test('conformance-verdicts refuses to classify mock-only integration rows as supported', async () => {
    const graph = await loadConformanceGraph();
    for (const surface of NATIVE_CLIENT_SURFACES) {
      for (const row of allCompatibilityRows.filter((r) => r.surface === surface)) {
        const verdict = deriveRegistryRowVerdict(graph, row.id);
        if (!hasLiveHostConformanceEvidence(row)) {
          expect(verdict, `${row.id} without live-host evidence must not be supported`).not.toBe('supported');
        } else if (row.status === 'conforms') {
          assertExistingNonMockHostSuites(row, row.id);
          expect(verdict, `${row.id} with live-host evidence must be supported`).toBe('supported');
        }
      }
    }

    const target = graph.rows.get('firestore-kotlin#16');
    if (!target) throw new Error('missing firestore-kotlin#16');
    const tamperedRows = new Map(graph.rows);
    tamperedRows.set('firestore-kotlin#16', { ...target, status: 'conforms', hostConformanceTests: undefined });
    const tamperedGraph = { ...graph, rows: tamperedRows };
    expect(validationProblems(tamperedGraph).some((p) => p.includes('firestore-kotlin#16'))).toBe(true);
    expect(deriveRegistryRowVerdict(tamperedGraph, 'firestore-kotlin#16')).toBe('qualified');

    const provenRows = new Map(graph.rows);
    provenRows.set('firestore-kotlin#16', {
      ...target,
      status: 'conforms',
      statusNote: undefined,
      hostConformanceTests: ['packages/cli/test/serve/native-kotlin-conformance.test.ts'],
    });
    const provenGraph = { ...graph, rows: provenRows };
    expect(validationProblems(provenGraph).some((p) => p.includes('firestore-kotlin#16'))).toBe(false);
    expect(deriveRegistryRowVerdict(provenGraph, 'firestore-kotlin#16')).toBe('supported');
  }, 60_000);

  test('reports all five client behavior families (merge write, batches, transactions, value decoding, named instances) as not proven without live-host evidence', () => {
    const ledger = buildCompatibilityLedger(model);
    const byId = new Map(ledger.entries.map((entry) => [entry.id, entry]));

    for (const [family, ids] of Object.entries(FIVE_BROKEN_BEHAVIOR_FAMILIES)) {
      for (const id of ids) {
        const entry = byId.get(id);
        expect(entry, `${family}: missing ${id}`).toBeDefined();
        if (!entry) continue;
        if (!hasLiveHostConformanceEvidence(entry)) {
          expect(entry.isConforming, `${family}: ${id} must not be conforming without live-host evidence`).toBe(false);
          expect(entry.isCaptureProven, `${family}: ${id} must not be capture-proven without live-host evidence`).toBe(
            false,
          );
          expect(
            entry.isSelfTestedOnly,
            `${family}: ${id} must not be self-tested conforming without live-host evidence`,
          ).toBe(false);
          expect(['unverified', 'diverged-documented']).toContain(entry.status);
          expect(model.assuranceNodeVerdicts[id]).not.toBe('supported');
        } else {
          assertExistingNonMockHostSuites(entry, `${family}: ${id}`);
          if (entry.isConforming) {
            expect(entry.status).toBe('conforms');
            expect(model.assuranceNodeVerdicts[id]).toBe('supported');
          } else {
            expect(['unverified', 'diverged-documented']).toContain(entry.status);
            expect(model.assuranceNodeVerdicts[id]).not.toBe('supported');
          }
        }
      }
    }

    const report = buildReport(model, () => []);
    for (const surface of NATIVE_CLIENT_SURFACES) {
      const svc = report.services.find((s) => s.surface === surface);
      expect(svc, `missing service ${surface}`).toBeDefined();
      if (!svc) continue;

      const surfaceEntries = ledger.entries.filter((e) => e.surface === surface);
      expect(surfaceEntries.length).toBeGreaterThan(0);

      for (const entry of surfaceEntries) {
        if (entry.isConforming) {
          assertExistingNonMockHostSuites(entry, entry.id);
        }
      }

      const liveHostConforming = surfaceEntries.filter(
        (e) => e.status === 'conforms' && hasLiveHostConformanceEvidence(e),
      );
      const liveHostCaptureProven = liveHostConforming.filter((e) => e.isCaptureProven);
      const liveHostSelfTested = liveHostConforming.filter((e) => e.isSelfTestedOnly);

      expect(svc.behavior.conforms).toBe(liveHostConforming.length);
      expect(svc.behavior.captureProven).toBe(liveHostCaptureProven.length);
      expect(svc.behavior.selfTested).toBe(liveHostSelfTested.length);
      expect(svc.behavior.captureProven + svc.behavior.selfTested).toBe(svc.behavior.conforms);
    }

    const unitTestedNativeRows = ledger.entries.filter(
      (e) =>
        (NATIVE_CLIENT_SURFACES as readonly string[]).includes(e.surface) &&
        e.status === 'unverified' &&
        e.automation === 'unit-backed',
    );
    for (const row of unitTestedNativeRows) {
      expect(row.conformanceTests.length).toBeGreaterThan(0);
      expect(row.statusNote).toContain('mock bridge');
    }
  });
});
