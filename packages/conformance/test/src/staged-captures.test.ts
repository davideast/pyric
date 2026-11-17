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
  loadPendingRowLinkObservations,
} from '../../src/staged-captures.ts';
import { ALL_RULES_FIRESTORE_SCENARIOS } from '../../rules-corpus/firestore/index.ts';
import { scenario as firestorePathBindForms } from '../../rules-corpus/firestore/path-bind-forms.ts';
import { scenario as firestoreServiceStorage } from '../../rules-corpus/firestore/service-name-storage-in-firestore.ts';
import { scenario as firestoreServiceUnknown } from '../../rules-corpus/firestore/service-name-unknown-in-firestore.ts';
import { ALL_RULES_STORAGE_SCENARIOS } from '../../rules-corpus/storage/index.ts';
import { scenario as storagePathBindForms } from '../../rules-corpus/storage/storage-path-bind-forms.ts';
import type { StorageTestCase } from '../../rules-corpus/storage/types.ts';
import { listProbeFiles } from '../../probes/load.ts';

function syntheticObservation(overrides: Partial<Observation> & Pick<Observation, 'file' | 'surfaceDir' | 'name'>): Observation {
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
      description: 'Synthetic staged observation for unit test.',
      observedAt: '2026-11-16T00:00:00.000Z',
      fbSdkVersion: '12.19.0',
      behavior: { sampleCase: 'ALLOW' },
    },
  };
  return { ...base, ...overrides };
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
      pendingRowLinkObservations: new Set(['rules-firestore-staged-uncaptured-probe']),
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
    const observations = [...loadObservations(), stagedObs];
    const pendingRowLinkObservations = new Set(['rules-firestore-staged-uncaptured-probe']);

    const problems = validateCompatibilityRegistry({
      rows: allCompatibilityRows,
      descriptors: surfaceDescriptors,
      observations,
      observationExceptions,
      rigManifests,
      rulesFirestoreScenarioIds: [
        ...observations
          .filter((o) => o.file.startsWith('rules-firestore-'))
          .map((o) => o.name.slice('rules-firestore-'.length)),
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
    expect(ledger.orphanObservations.map((o) => o.name)).not.toContain('rules-firestore-staged-uncaptured-probe');
  });

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
        return { ...row, oracleObservations: [...row.oracleObservations, 'rules-firestore-staged-linked-probe'] };
      }
      return row;
    });
    const problems = validateCompatibilityRegistry({
      rows,
      descriptors: surfaceDescriptors,
      observations: [...loadObservations(), stagedObs],
      observationExceptions,
      pendingRowLinkObservations: new Set(['rules-firestore-staged-linked-probe']),
    });
    expect(
      problems.some((p) =>
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
    expect(problems.some((p) => p.includes('rules-firestore-untracked-probe.json: observation has no rowIds'))).toBe(true);
  });

  test('observation-gate skips unlinked pendingRowLink captures until PR #3 links rowIds', () => {
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
        match: (f) => f.startsWith('messaging-send-'),
        pendingRowLinkStems: new Set(['messaging-send-staged']),
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
        {
          rig: 'messaging-send',
          observationName: 'messaging-send-pending-ttl',
          filterFlag: '--probe',
          filterValue: 'messaging-send-pending-ttl',
        },
      ],
    });
    expect(targets).toEqual([
      {
        rig: 'messaging-send',
        observationName: 'messaging-send-pending-ttl',
        filterFlag: '--probe',
        filterValue: 'messaging-send-pending-ttl',
      },
      {
        rig: 'rules-firestore',
        observationName: 'rules-firestore-pending-one',
        filterFlag: '--scenario',
        filterValue: 'pending-one',
      },
    ]);
  });

  test('checked-in staged probes are discovered pre-capture and validate cleanly both pre-capture and post-capture', async () => {
    const uncaptured = discoverUncapturedStagedTargets();
    expect(uncaptured).toEqual([
      {
        rig: 'messaging-send',
        observationName: 'messaging-send-webpush-lowercase-ttl',
        filterFlag: '--probe',
        filterValue: 'messaging-send-webpush-lowercase-ttl',
      },
      {
        rig: 'rules-firestore',
        observationName: 'rules-firestore-path-bind-forms',
        filterFlag: '--scenario',
        filterValue: 'path-bind-forms',
      },
      {
        rig: 'rules-firestore',
        observationName: 'rules-firestore-service-name-storage-in-firestore',
        filterFlag: '--scenario',
        filterValue: 'service-name-storage-in-firestore',
      },
      {
        rig: 'rules-firestore',
        observationName: 'rules-firestore-service-name-unknown-in-firestore',
        filterFlag: '--scenario',
        filterValue: 'service-name-unknown-in-firestore',
      },
      {
        rig: 'rules-storage',
        observationName: 'rules-storage-storage-path-bind-forms',
        filterFlag: '--scenario',
        filterValue: 'storage-path-bind-forms',
      },
    ]);

    const rigManifests = await loadRigManifests();
    const pendingRowLinkObservations = loadPendingRowLinkObservations();
    const rulesFirestoreScenarioIds = ALL_RULES_FIRESTORE_SCENARIOS.map((s) => s.id);
    const rulesStorageScenarioIds = ALL_RULES_STORAGE_SCENARIOS.map((s) => s.id);
    const probeFiles = listProbeFiles();

    // Pre-capture (PR #1)
    expect(
      validateCompatibilityRegistry({
        rows: allCompatibilityRows,
        descriptors: surfaceDescriptors,
        observations: loadObservations(),
        observationExceptions,
        rigManifests,
        probeFiles,
        rulesFirestoreScenarioIds,
        rulesStorageScenarioIds,
        pendingRowLinkObservations,
      }),
    ).toEqual([]);

    // Post-capture (PR #2 touching ONLY packages/conformance/observations/**)
    const postCaptureObservations = [
      ...loadObservations(),
      syntheticObservation({
        file: 'messaging-send-webpush-lowercase-ttl.json',
        surfaceDir: 'messaging-admin',
        name: 'messaging-send-webpush-lowercase-ttl',
        rowIds: [],
      }),
      syntheticObservation({
        file: 'rules-firestore-path-bind-forms.json',
        surfaceDir: 'firestore-rules',
        name: 'rules-firestore-path-bind-forms',
        rowIds: [],
      }),
      syntheticObservation({
        file: 'rules-firestore-service-name-storage-in-firestore.json',
        surfaceDir: 'firestore-rules',
        name: 'rules-firestore-service-name-storage-in-firestore',
        rowIds: [],
      }),
      syntheticObservation({
        file: 'rules-firestore-service-name-unknown-in-firestore.json',
        surfaceDir: 'firestore-rules',
        name: 'rules-firestore-service-name-unknown-in-firestore',
        rowIds: [],
      }),
      syntheticObservation({
        file: 'rules-storage-storage-path-bind-forms.json',
        surfaceDir: 'storage-rules',
        name: 'rules-storage-storage-path-bind-forms',
        rowIds: [],
      }),
    ];

    expect(
      validateCompatibilityRegistry({
        rows: allCompatibilityRows,
        descriptors: surfaceDescriptors,
        observations: postCaptureObservations,
        observationExceptions,
        rigManifests,
        probeFiles,
        rulesFirestoreScenarioIds,
        rulesStorageScenarioIds,
        pendingRowLinkObservations,
      }),
    ).toEqual([]);
  });

  test('staged corpus scenarios cover Path.bind forms and wrong-service compile checks', () => {
    const checkShape: OracleConformanceCheck = {
      finding: 'sample',
      observation: 'rules-firestore-path-bind-forms',
      expect: { allow: 'ALLOW' },
      probe: 'packages/conformance/rules-corpus/firestore/path-bind-forms.ts',
      guards: 'Path.bind forms',
    };
    expect(checkShape.observation).toBe('rules-firestore-path-bind-forms');

    expect(firestorePathBindForms.pendingRowLink).toBe(true);
    expect(firestorePathBindForms.allowCompileError).toBeUndefined();
    expect(firestorePathBindForms.rules).toContain("path('/a/$(x)').bind({'x': '1'})");
    expect(firestorePathBindForms.rules).toContain("(/a/$(x)).bind({'x': '1'})");
    expect(firestorePathBindForms.rules).toContain("path('/a/{x}').bind({'x': 1.5})");

    expect(storagePathBindForms.pendingRowLink).toBe(true);
    expect(storagePathBindForms.rules).toContain("path('/a/$(x)').bind({'x': '1'})");
    expect(storagePathBindForms.rules).toContain("(/a/$(x)).bind({'x': '1'})");
    expect(storagePathBindForms.rules).toContain("path('/a/{x}').bind({'x': 1.5})");
    const storageCases: readonly StorageTestCase[] = storagePathBindForms.cases;
    expect(storageCases).toHaveLength(7);

    expect(firestoreServiceStorage.pendingRowLink).toBe(true);
    expect(firestoreServiceStorage.allowCompileError).toBe(true);
    expect(firestoreServiceStorage.rules).toContain('service firebase.storage');

    expect(firestoreServiceUnknown.pendingRowLink).toBe(true);
    expect(firestoreServiceUnknown.allowCompileError).toBe(true);
    expect(firestoreServiceUnknown.rules).toContain('service foo.bar');
  });
});
