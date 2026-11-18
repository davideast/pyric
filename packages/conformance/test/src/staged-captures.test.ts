import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allCompatibilityRows } from '../../registry/index.ts';
import { surfaceDescriptors } from '../../surfaces/load.ts';
import { observationExceptions } from '../../exceptions/load.ts';
import {
  buildCompatibilityLedger,
  loadObservations,
  type Observation,
  type OracleConformanceCheck,
} from '../../src/ledger.ts';
import { deriveConformanceModel } from '../../src/conformance-model.ts';
import { validateCompatibilityRegistry } from '../../src/validate-registry.ts';
import { loadRigManifests } from '../../rigs/load.ts';
import { createObservationGate } from '../../src/observation-gate.ts';
import {
  discoverUncapturedStagedTargets,
  isUnlinkedStagedObservation,
  loadPendingRowLinkObservations,
  loadStagedCaptureItems,
} from '../../src/staged-captures.ts';
import { soleLongestPrefixOwner } from '../../src/observation-surface.ts';
import { ALL_RULES_FIRESTORE_SCENARIOS } from '../../rules-corpus/firestore/index.ts';
import { scenario as firestorePathBindForms } from '../../rules-corpus/firestore/path-bind-forms.ts';
import { scenario as firestorePathLiteralBraceBind } from '../../rules-corpus/firestore/path-literal-brace-bind.ts';
import { scenario as firestorePathLiteralDollarBoundBind } from '../../rules-corpus/firestore/path-literal-dollar-bound-bind.ts';
import { scenario as firestorePathLiteralDollarUnboundBind } from '../../rules-corpus/firestore/path-literal-dollar-unbound-bind.ts';
import { scenario as firestoreServiceStorage } from '../../rules-corpus/firestore/service-name-storage-in-firestore.ts';
import { scenario as firestoreServiceUnknown } from '../../rules-corpus/firestore/service-name-unknown-in-firestore.ts';
import { ALL_RULES_STORAGE_SCENARIOS } from '../../rules-corpus/storage/index.ts';
import { scenario as storagePathBindForms } from '../../rules-corpus/storage/storage-path-bind-forms.ts';
import { scenario as storagePathLiteralBraceBind } from '../../rules-corpus/storage/storage-path-literal-brace-bind.ts';
import { scenario as storagePathLiteralDollarBoundBind } from '../../rules-corpus/storage/storage-path-literal-dollar-bound-bind.ts';
import { scenario as storagePathLiteralDollarUnboundBind } from '../../rules-corpus/storage/storage-path-literal-dollar-unbound-bind.ts';
import type { StorageTestCase } from '../../rules-corpus/storage/types.ts';
import { listProbeFiles } from '../../probes/load.ts';
import {
  auditStagedCaptureTestFiles,
  expectStagedUntilCaptured,
} from './staged-capture-assertions.ts';

function syntheticObservation(
  overrides: Partial<Observation> & Pick<Observation, 'file' | 'surfaceDir' | 'name'>,
): Observation {
  const base = {
    matrixRow: '',
    rowIds: [],
    observedAt: '2026-11-16T00:00:00.000Z',
    fbSdkVersion: '12.19.0',
    behavior: { sampleCase: 'ALLOW' },
    raw: {
      name: overrides.name,
      matrixRow: '',
      rowIds: overrides.rowIds ?? [],
      description: 'Staged observation awaiting follow-up row linkage.',
      observedAt: '2026-11-16T00:00:00.000Z',
      fbSdkVersion: '12.19.0',
      behavior: { sampleCase: 'ALLOW' },
    },
  };
  return {
    ...base,
    ...overrides,
    raw: overrides.raw ?? {
      ...base.raw,
      rowIds: overrides.rowIds ?? [],
    },
  };
}

function surfaceDirForObservationName(obsName: string): string {
  const owner = soleLongestPrefixOwner(
    `${obsName}.json`,
    surfaceDescriptors.map((d) => ({ id: d.surface, observationPrefixes: d.observationPrefixes })),
  );
  return owner ?? 'app';
}

describe('staged pendingRowLink observation lifecycle', () => {
  test('pre-capture (PR #1): staged pendingRowLink scenario with no observation file validates cleanly', async () => {
    const rigManifests = await loadRigManifests();
    const problems = validateCompatibilityRegistry({
      rows: allCompatibilityRows,
      descriptors: surfaceDescriptors,
      observations: loadObservations(),
      observationExceptions,
      rigManifests,
      rulesFirestoreScenarioIds: ['builtins-time-and-math', 'staged-uncaptured-probe'],
      pendingRowLinkObservations: new Set([
        ...loadPendingRowLinkObservations(),
        'rules-firestore-staged-uncaptured-probe',
      ]),
    });
    expect(problems.filter((p) => p.includes('staged-uncaptured-probe'))).toEqual([]);
  });

  test('post-capture (PR #2 observations-only): staged observation with empty rowIds passes validate-registry and has zero orphans', async () => {
    const rigManifests = await loadRigManifests();
    const stagedObs = syntheticObservation({
      file: 'rules-firestore-staged-uncaptured-probe.json',
      surfaceDir: 'firestore-rules',
      name: 'rules-firestore-staged-uncaptured-probe',
      rowIds: [],
    });
    const byName = new Map(loadObservations().map((o) => [o.name, o]));
    byName.set(stagedObs.name, stagedObs);
    const observations = [...byName.values()];
    const pendingRowLinkObservations = new Set([
      ...loadPendingRowLinkObservations(),
      'rules-firestore-staged-uncaptured-probe',
    ]);

    const problems = validateCompatibilityRegistry({
      rows: allCompatibilityRows,
      descriptors: surfaceDescriptors,
      observations,
      observationExceptions,
      rigManifests,
      rulesFirestoreScenarioIds: [
        ...new Set([
          ...ALL_RULES_FIRESTORE_SCENARIOS.map((s) => s.id),
          ...observations
            .filter((o) => o.file.startsWith('rules-firestore-'))
            .map((o) => o.name.slice('rules-firestore-'.length)),
        ]),
      ],
      pendingRowLinkObservations,
    });
    expect(problems).toEqual([]);

    const model = await deriveConformanceModel();
    const ledger = buildCompatibilityLedger(
      {
        ...model,
        evidence: {
          ...model.evidence,
          observations,
        },
      },
      pendingRowLinkObservations,
    );
    expect(ledger.orphanObservations.map((o) => o.name)).not.toContain(
      'rules-firestore-staged-uncaptured-probe',
    );
  }, 20_000);

  test('post-link (PR #3): staged observation that acquires rowIds must drop pendingRowLink', () => {
    const targetRow = allCompatibilityRows.find((r) => r.surface === 'firestore-rules');
    expect(targetRow).toBeDefined();
    const rowId = targetRow ? targetRow.id : 'firestore-rules#1';
    const stagedObs = syntheticObservation({
      file: 'rules-firestore-staged-linked-probe.json',
      surfaceDir: 'firestore-rules',
      name: 'rules-firestore-staged-linked-probe',
      rowIds: [rowId],
    });
    const rows = allCompatibilityRows.map((row) => {
      if (row.id === rowId) {
        return {
          ...row,
          oracleObservations: [...row.oracleObservations, 'rules-firestore-staged-linked-probe'],
        };
      }
      return row;
    });
    const problems = validateCompatibilityRegistry({
      rows,
      descriptors: surfaceDescriptors,
      observations: [...loadObservations(), stagedObs],
      observationExceptions,
      pendingRowLinkObservations: new Set([
        ...loadPendingRowLinkObservations(),
        'rules-firestore-staged-linked-probe',
      ]),
    });
    expect(
      problems.some(
        (p) =>
          p.includes('rules-firestore-staged-linked-probe.json') && p.includes('pendingRowLink'),
      ),
    ).toBe(true);

    const checkEntry: OracleConformanceCheck = {
      finding: 'staged-check-link',
      observation: 'rules-firestore-staged-linked-probe',
      expect: { sampleCase: 'ALLOW' },
      probe: 'packages/conformance/test/src/staged-captures.test.ts',
      guards: 'conformanceChecks reference forces pendingRowLink removal',
    };
    const rowsViaCheck = allCompatibilityRows.map((row) => {
      if (row.id === rowId) {
        return { ...row, conformanceChecks: [...(row.conformanceChecks ?? []), checkEntry] };
      }
      return row;
    });
    const unlinkedIdObs = syntheticObservation({
      file: 'rules-firestore-staged-linked-probe.json',
      surfaceDir: 'firestore-rules',
      name: 'rules-firestore-staged-linked-probe',
      rowIds: [],
    });
    const checkProblems = validateCompatibilityRegistry({
      rows: rowsViaCheck,
      descriptors: surfaceDescriptors,
      observations: [...loadObservations(), unlinkedIdObs],
      observationExceptions,
      pendingRowLinkObservations: new Set([
        ...loadPendingRowLinkObservations(),
        'rules-firestore-staged-linked-probe',
      ]),
    });
    expect(
      checkProblems.some(
        (p) =>
          p.includes('rules-firestore-staged-linked-probe.json') && p.includes('pendingRowLink'),
      ),
    ).toBe(true);
  });

  test('non-staged observation with empty rowIds still fails validation as unlinked', () => {
    const unlinkedObs = syntheticObservation({
      file: 'rules-firestore-untracked-probe.json',
      surfaceDir: 'firestore-rules',
      name: 'rules-firestore-untracked-probe',
      rowIds: [],
    });
    const problems = validateCompatibilityRegistry({
      rows: allCompatibilityRows,
      descriptors: surfaceDescriptors,
      observations: [...loadObservations(), unlinkedObs],
      observationExceptions,
      pendingRowLinkObservations: new Set(),
    });
    expect(
      problems.some((p) =>
        p.includes('rules-firestore-untracked-probe.json: observation has no rowIds'),
      ),
    ).toBe(true);
  });

  test('observation-gate and isUnlinkedStagedObservation skip unlinked pendingRowLink captures until PR #3 links rowIds', () => {
    const pendingSet = new Set(['messaging-send-staged']);
    expect(isUnlinkedStagedObservation('messaging-send-staged', [], pendingSet)).toBe(true);
    expect(
      isUnlinkedStagedObservation('messaging-send-staged', ['messaging-admin#4'], pendingSet),
    ).toBe(false);
    expect(isUnlinkedStagedObservation('messaging-send-other', [], pendingSet)).toBe(false);

    const dir = mkdtempSync(join(tmpdir(), 'staged-obs-gate-'));
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'messaging-send-existing.json'),
        JSON.stringify({
          name: 'messaging-send-existing',
          rowIds: ['messaging-admin#4'],
          behavior: { status: 200 },
        }),
      );
      writeFileSync(
        join(dir, 'messaging-send-staged.json'),
        JSON.stringify({
          name: 'messaging-send-staged',
          rowIds: [],
          behavior: { status: 200 },
        }),
      );

      const gate = createObservationGate({
        dir,
        match: (file) => file.startsWith('messaging-send-') && file.endsWith('.json'),
        pendingRowLinkStems: pendingSet,
      });
      const existing = gate.load<{ status: number }>('messaging-send-existing');
      expect(existing.status).toBe(200);
      const report = gate.report();
      expect(report.committed).toEqual(['messaging-send-existing']);
      expect(report.uncovered).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('discoverUncapturedStagedTargets lists only staged targets whose observation file is absent', () => {
    const targets = discoverUncapturedStagedTargets({
      existingObservationNames: new Set(['rules-firestore-already-captured']),
      stagedItems: [
        {
          rig: 'rules-firestore',
          observationName: 'rules-firestore-already-captured',
          filterFlag: '--scenario',
          filterValue: 'already-captured',
        },
        {
          rig: 'rules-firestore',
          observationName: 'rules-firestore-pending-one',
          filterFlag: '--scenario',
          filterValue: 'pending-one',
        },
      ],
    });
    expect(targets).toEqual([
      {
        rig: 'rules-firestore',
        observationName: 'rules-firestore-pending-one',
        filterFlag: '--scenario',
        filterValue: 'pending-one',
      },
    ]);
  });

  test('checked-in staged probes validate cleanly with default pendingRowLinkObservations both pre-capture and post-capture', async () => {
    const stagedItems = loadStagedCaptureItems();
    expect(stagedItems.map((i) => i.observationName)).not.toContain(
      'messaging-send-webpush-lowercase-ttl',
    );
    for (const item of stagedItems) {
      expect(item.rig.length).toBeGreaterThan(0);
    }

    const currentObservations = loadObservations();
    const existingNames = new Set(currentObservations.map((o) => o.name));
    expect(discoverUncapturedStagedTargets()).toEqual(
      stagedItems.filter((item) => !existingNames.has(item.observationName)),
    );

    const rigManifests = await loadRigManifests();
    const rulesFirestoreScenarioIds = ALL_RULES_FIRESTORE_SCENARIOS.map((s) => s.id);
    const rulesStorageScenarioIds = ALL_RULES_STORAGE_SCENARIOS.map((s) => s.id);
    const probeFiles = listProbeFiles();

    // Pre-capture (or current disk state) using DEFAULT pendingRowLinkObservations
    expect(
      validateCompatibilityRegistry({
        rows: allCompatibilityRows,
        descriptors: surfaceDescriptors,
        observations: currentObservations,
        observationExceptions,
        rigManifests,
        probeFiles,
        rulesFirestoreScenarioIds,
        rulesStorageScenarioIds,
      }),
    ).toEqual([]);

    // Post-capture (PR #2 touching ONLY packages/conformance/observations/**, deduplicated by name)
    const obsByName = new Map(currentObservations.map((o) => [o.name, o]));
    for (const item of stagedItems) {
      if (!obsByName.has(item.observationName)) {
        obsByName.set(
          item.observationName,
          syntheticObservation({
            file: `${item.observationName}.json`,
            surfaceDir: surfaceDirForObservationName(item.observationName),
            name: item.observationName,
            rowIds: [],
          }),
        );
      }
    }

    expect(
      validateCompatibilityRegistry({
        rows: allCompatibilityRows,
        descriptors: surfaceDescriptors,
        observations: [...obsByName.values()],
        observationExceptions,
        rigManifests,
        probeFiles,
        rulesFirestoreScenarioIds,
        rulesStorageScenarioIds,
      }),
    ).toEqual([]);
  });

  test('linked corpus scenarios isolate path-literal bind forms and wrong-service compile checks', () => {
    expect(firestorePathBindForms.pendingRowLink).toBeUndefined();
    expect(firestorePathBindForms.allowCompileError).toBeUndefined();
    expect(firestorePathBindForms.cases).toHaveLength(4);
    expect(firestorePathBindForms.rules).not.toContain('(/a/');

    expect(firestorePathLiteralBraceBind.pendingRowLink).toBeUndefined();
    expect(firestorePathLiteralBraceBind.allowCompileError).toBe(true);
    expect(firestorePathLiteralBraceBind.rules).toContain("(/a/{x}).bind({'x': '1'})");
    expect(firestorePathLiteralDollarUnboundBind.pendingRowLink).toBeUndefined();
    expect(firestorePathLiteralDollarUnboundBind.allowCompileError).toBe(true);
    expect(firestorePathLiteralDollarUnboundBind.rules).toContain("(/a/$(x)).bind({'x': '1'})");
    expect(firestorePathLiteralDollarBoundBind.pendingRowLink).toBeUndefined();
    expect(firestorePathLiteralDollarBoundBind.allowCompileError).toBe(true);
    expect(firestorePathLiteralDollarBoundBind.rules).toContain('match /items/{x}');

    expect(storagePathBindForms.pendingRowLink).toBeUndefined();
    expect(storagePathBindForms.allowCompileError).toBeUndefined();
    const storageCases: readonly StorageTestCase[] = storagePathBindForms.cases;
    expect(storageCases).toHaveLength(4);
    expect(storagePathBindForms.rules).not.toContain('(/a/');

    expect(storagePathLiteralBraceBind.pendingRowLink).toBeUndefined();
    expect(storagePathLiteralBraceBind.allowCompileError).toBe(true);
    expect(storagePathLiteralBraceBind.rules).toContain("(/a/{x}).bind({'x': '1'})");
    expect(storagePathLiteralDollarUnboundBind.pendingRowLink).toBeUndefined();
    expect(storagePathLiteralDollarUnboundBind.allowCompileError).toBe(true);
    expect(storagePathLiteralDollarUnboundBind.rules).toContain("(/a/$(x)).bind({'x': '1'})");
    expect(storagePathLiteralDollarBoundBind.pendingRowLink).toBeUndefined();
    expect(storagePathLiteralDollarBoundBind.allowCompileError).toBe(true);
    expect(storagePathLiteralDollarBoundBind.rules).toContain('match /items/{x}');

    expect(firestoreServiceStorage.pendingRowLink).toBeUndefined();
    expect(firestoreServiceStorage.allowCompileError).toBe(true);
    expect(firestoreServiceUnknown.pendingRowLink).toBeUndefined();
    expect(firestoreServiceUnknown.allowCompileError).toBe(true);
  });

  test('modular sdk-probes probe files own their observations across PR #1 -> PR #2 -> PR #3 without editing rigs or surfaces', async () => {
    const rigManifests = await loadRigManifests();
    const baseProbeFiles = listProbeFiles();
    const probeFilesWithNewRtdb = [
      ...baseProbeFiles,
      {
        surfaceDir: 'rtdb-modular',
        name: 'rtdb-modular-synthetic-self-contained',
        declaredRig: 'sdk-probes',
      },
    ];

    // PR #1: probe file added with pendingRowLink: true, zero observation JSON yet
    expect(
      validateCompatibilityRegistry({
        rows: allCompatibilityRows,
        descriptors: surfaceDescriptors,
        observations: loadObservations(),
        observationExceptions,
        rigManifests,
        probeFiles: probeFilesWithNewRtdb,
        pendingRowLinkObservations: new Set([
          ...loadPendingRowLinkObservations(),
          'rtdb-modular-synthetic-self-contained',
        ]),
      }),
    ).toEqual([]);

    // PR #2: unlinked observation JSON lands with rowIds: []
    const pr2Obs = syntheticObservation({
      file: 'rtdb-modular-synthetic-self-contained.json',
      surfaceDir: 'rtdb-modular',
      name: 'rtdb-modular-synthetic-self-contained',
      rowIds: [],
    });
    expect(
      validateCompatibilityRegistry({
        rows: allCompatibilityRows,
        descriptors: surfaceDescriptors,
        observations: [...loadObservations(), pr2Obs],
        observationExceptions,
        rigManifests,
        probeFiles: probeFilesWithNewRtdb,
        pendingRowLinkObservations: new Set([
          ...loadPendingRowLinkObservations(),
          'rtdb-modular-synthetic-self-contained',
        ]),
      }),
    ).toEqual([]);

    // PR #3: linked to a registry row, pendingRowLink removed -- zero edits to rigs/sdk-probes.ts or surfaces/rtdb-modular.json
    const rtdbRow = allCompatibilityRows.find((r) => r.surface === 'rtdb');
    const rtdbRowId = rtdbRow ? rtdbRow.id : 'rtdb-modular#1';
    const pr3Obs = syntheticObservation({
      file: 'rtdb-modular-synthetic-self-contained.json',
      surfaceDir: 'rtdb-modular',
      name: 'rtdb-modular-synthetic-self-contained',
      rowIds: [rtdbRowId],
    });
    const pr3Rows = allCompatibilityRows.map((row) => {
      if (row.id !== rtdbRowId) return row;
      return {
        ...row,
        oracleObservations: [...row.oracleObservations, 'rtdb-modular-synthetic-self-contained'],
      };
    });
    const pr3Problems = validateCompatibilityRegistry({
      rows: pr3Rows,
      descriptors: surfaceDescriptors,
      observations: [...loadObservations(), pr3Obs],
      observationExceptions,
      rigManifests,
      probeFiles: probeFilesWithNewRtdb,
      pendingRowLinkObservations: loadPendingRowLinkObservations(),
    }).filter((p) => !p.includes('generated link targets untracked observation'));
    expect(pr3Problems).toEqual([]);

    // Guardrail: declaring a rig not in the surface's captureRigs fails validation
    const badSurfaceRigProblems = validateCompatibilityRegistry({
      rows: allCompatibilityRows,
      descriptors: surfaceDescriptors,
      observations: loadObservations(),
      observationExceptions,
      rigManifests,
      probeFiles: [
        ...baseProbeFiles,
        {
          surfaceDir: 'rtdb-modular',
          name: 'rtdb-modular-wrong-rig',
          declaredRig: 'admin-auth',
        },
      ],
    });
    expect(
      badSurfaceRigProblems.some((p) => p.includes("not listed in surface 'rtdb-modular' captureRigs")),
    ).toBe(true);
  });

  test('expectStagedUntilCaptured verifies both pre-capture uncaptured and post-capture captured states', () => {
    const stagedItems = [
      {
        rig: 'rules-storage',
        observationName: 'rules-storage-staged-alpha',
        filterFlag: '--scenario' as const,
        filterValue: 'staged-alpha',
      },
      {
        rig: 'rules-storage',
        observationName: 'rules-storage-staged-beta',
        filterFlag: '--scenario' as const,
        filterValue: 'staged-beta',
      },
    ];
    const uncapturedSeen: string[] = [];
    const capturedSeen: string[] = [];

    expectStagedUntilCaptured(['rules-storage-staged-alpha', 'rules-storage-staged-beta'], {
      rig: 'rules-storage',
      filterFlag: '--scenario',
      filterValueFor: (obsName) => obsName.replace(/^rules-storage-/, ''),
      existingObservationNames: new Set(['rules-storage-staged-beta']),
      stagedItems,
      whenUncaptured: (obsName) => uncapturedSeen.push(obsName),
      whenCaptured: (obsName) => capturedSeen.push(obsName),
    });

    expect(uncapturedSeen).toEqual(['rules-storage-staged-alpha']);
    expect(capturedSeen).toEqual(['rules-storage-staged-beta']);
    expect(() =>
      expectStagedUntilCaptured('rules-storage-missing', {
        existingObservationNames: new Set(),
        stagedItems,
      }),
    ).toThrow(/expected rules-storage-missing to declare pendingRowLink: true/);
  });

  test('conformance test files assert uncaptured staged state exclusively via expectStagedUntilCaptured', () => {
    expect(
      auditStagedCaptureTestFiles([
        {
          relPath: 'src/synthetic-probe.test.ts',
          source: 'const uncaptured = discoverUncapturedStagedTargets();',
        },
        {
          relPath: 'src/synthetic-scenarios.test.ts',
          source: "const ids = selectStorageScenarios(['--write']);",
        },
        {
          relPath: 'src/synthetic-clean.test.ts',
          source:
            "const ids = selectStorageScenarios(['--write']); expectStagedUntilCaptured('x', { whenUncaptured: () => {} });",
        },
      ]),
    ).toEqual([
      'src/synthetic-probe.test.ts: references discoverUncapturedStagedTargets directly; use expectStagedUntilCaptured from test/src/staged-capture-assertions.ts so PR #2 observation captures stay green',
      "src/synthetic-scenarios.test.ts: calls live select*Scenarios(['--write']) without expectStagedUntilCaptured(..., { whenUncaptured, whenCaptured }); guard live runner-exclusion assertions for PR #2 captures",
    ]);

    expect(auditStagedCaptureTestFiles()).toEqual([]);
  });
});
