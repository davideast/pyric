import { deleteApp, FirebaseError, initializeApp } from 'firebase/app';
import {
  collection,
  collectionGroup,
  doc,
  getFirestore,
  refEqual,
} from 'firebase/firestore';
import { describe, expect, test } from 'bun:test';
import { observationExceptions } from '../../exceptions/load.ts';
import { listProbeFiles } from '../../probes/load.ts';
import { allCompatibilityRows } from '../../registry/index.ts';
import { loadRigManifests } from '../../rigs/load.ts';
import { ALL_RULES_FIRESTORE_SCENARIOS } from '../../rules-corpus/firestore/index.ts';
import {
  ALL_RULES_RTDB_DEPLOY_SCENARIOS,
  ALL_RULES_RTDB_SCENARIOS,
} from '../../rules-corpus/rtdb/index.ts';
import { ALL_RULES_STORAGE_SCENARIOS } from '../../rules-corpus/storage/index.ts';
import {
  isFirestoreAutoIdShape,
  observeFirestoreConstructorCall,
} from '../../src/firestore-path-constructor-probe-helpers.ts';
import { loadObservations } from '../../src/ledger.ts';
import {
  loadModularProbes,
  printModularProbePreview,
  selectModularProbes,
} from '../../src/sdk-probes.ts';
import { loadPendingRowLinkObservations } from '../../src/staged-captures.ts';
import { validateCompatibilityRegistry } from '../../src/validate-registry.ts';
import { surfaceDescriptors } from '../../surfaces/load.ts';
import { probe as collDbProbe } from '../../probes/firestore/firestore-collection-db-path-reference-shape.ts';
import { probe as collSubProbe } from '../../probes/firestore/firestore-collection-from-doc-subcollection.ts';
import { probe as docDbProbe } from '../../probes/firestore/firestore-doc-db-path-reference-shape.ts';
import { probe as docAutoIdProbe } from '../../probes/firestore/firestore-doc-from-collection-autoid.ts';
import { probe as docFromCollProbe } from '../../probes/firestore/firestore-doc-from-collection-with-id.ts';
import { probe as docVariadicProbe } from '../../probes/firestore/firestore-doc-variadic-segments.ts';
import { probe as unknownRefProbe } from '../../probes/firestore/firestore-path-constructors-unknown-ref-errors.ts';

const EXPECTED_PATH_CONSTRUCTOR_LINKS = [
  ['firestore-doc-db-path-reference-shape', docDbProbe, 'firestore#7'],
  ['firestore-doc-variadic-segments', docVariadicProbe, 'firestore#8'],
  ['firestore-collection-db-path-reference-shape', collDbProbe, 'firestore#9'],
  ['firestore-doc-from-collection-with-id', docFromCollProbe, 'firestore#10'],
  ['firestore-doc-from-collection-autoid', docAutoIdProbe, 'firestore#11'],
  ['firestore-collection-from-doc-subcollection', collSubProbe, 'firestore#12'],
  ['firestore-path-constructors-unknown-ref-errors', unknownRefProbe, 'firestore#14'],
] as const;

describe('Firestore Path constructors linked probes (sdk-probes)', () => {
  test('registers all 7 Path constructor probes on sdk-probes linked to their target registry rows', async () => {
    const loaded = await loadModularProbes('sdk-probes');
    const byId = new Map(loaded.map((entry) => [entry.id, entry]));
    const unfilteredIds = new Set(
      selectModularProbes(loaded, [], 'sdk-probes', {
        includeUncapturedStaged: false,
      }).map((entry) => entry.id),
    );

    for (const [id, probeRecord, expectedRowId] of EXPECTED_PATH_CONSTRUCTOR_LINKS) {
      const found = byId.get(id);
      expect(found, `missing modular probe ${id}`).toBeDefined();
      expect(found?.probe).toBe(probeRecord);
      expect(probeRecord.rig).toBe('sdk-probes');
      expect(probeRecord.requires).toEqual(['web-config', 'firestore-rules']);
      expect(probeRecord.pendingRowLink).toBeUndefined();
      expect(probeRecord.matrixRow).toBe(expectedRowId);
      expect(probeRecord.rowIds).toEqual([expectedRowId]);
      expect(probeRecord.description.length).toBeGreaterThan(20);
      expect(unfilteredIds.has(id)).toBe(true);
    }

    const lines: string[] = [];
    printModularProbePreview({
      rig: 'sdk-probes',
      scriptPath: 'packages/conformance/src/sdk-probes.ts',
      probes: loaded,
      log: (line) => lines.push(line),
    });
    expect(
      lines.some((line) => line.includes('firestore-doc-db-path-reference-shape')),
    ).toBe(true);
  });

  test('links all 7 committed observations to oracle-backed registry rows with zero validation problems', async () => {
    const existingObservations = loadObservations();
    const obsByName = new Map(existingObservations.map((obs) => [obs.name, obs]));
    const rowsById = new Map(allCompatibilityRows.map((row) => [row.id, row]));

    for (const [id, , expectedRowId] of EXPECTED_PATH_CONSTRUCTOR_LINKS) {
      const obs = obsByName.get(id);
      expect(obs, `missing committed observation ${id}`).toBeDefined();
      expect(obs?.rowIds).toEqual([expectedRowId]);
      expect(obs?.matrixRow).toBe(expectedRowId);

      const row = rowsById.get(expectedRowId);
      expect(row, `missing compatibility row ${expectedRowId}`).toBeDefined();
      expect(row?.automation).toBe('oracle-backed');
      expect(row?.oracleObservations).toContain(id);
    }

    const rigManifests = await loadRigManifests();
    const probeFiles = listProbeFiles();
    const pendingRowLinkObservations = loadPendingRowLinkObservations();
    const rulesFirestoreScenarioIds = ALL_RULES_FIRESTORE_SCENARIOS.map((s) => s.id);
    const rulesStorageScenarioIds = ALL_RULES_STORAGE_SCENARIOS.map((s) => s.id);
    const rulesRtdbScenarioIds = [
      ...ALL_RULES_RTDB_SCENARIOS.map((s) => s.id),
      ...ALL_RULES_RTDB_DEPLOY_SCENARIOS.map((s) => s.id),
    ];

    expect(
      validateCompatibilityRegistry({
        rows: allCompatibilityRows,
        descriptors: surfaceDescriptors,
        observations: existingObservations,
        observationExceptions,
        rigManifests,
        probeFiles,
        rulesFirestoreScenarioIds,
        rulesStorageScenarioIds,
        rulesRtdbScenarioIds,
        pendingRowLinkObservations,
      }),
    ).toEqual([]);
  });

  test('observes upstream firebase/firestore synchronous path constructors and error classes without network I/O', async () => {
    const app = initializeApp(
      { projectId: 'demo-path-probes', apiKey: 'demo-api-key' },
      `path-probe-unit-${Math.random().toString(36).slice(2, 10)}`,
    );
    try {
      const db = getFirestore(app);
      const rootColl = collection(db, 'items');
      const d1 = doc(rootColl, 'item-1');
      const variadic = doc(db, 'items', 'item-1');
      const auto = doc(rootColl);
      const sub = collection(d1, 'notes');

      expect(refEqual(d1, variadic)).toBe(true);
      expect(isFirestoreAutoIdShape(auto.id)).toBe(true);
      expect(isFirestoreAutoIdShape('short')).toBe(false);
      expect(sub.path).toBe('items/item-1/notes');
      expect(sub.parent !== null && refEqual(sub.parent, d1)).toBe(true);

      const unknownDbOutcome = observeFirestoreConstructorCall(
        () => collectionGroup({} as never, 'items'),
        FirebaseError,
      );
      expect(unknownDbOutcome.threw).toBe(true);
      expect(unknownDbOutcome.isFirebaseError).toBe(true);
      expect(unknownDbOutcome.code).toBe('invalid-argument');

      const okOutcome = observeFirestoreConstructorCall(() => d1.path, FirebaseError);
      expect(okOutcome).toEqual({
        threw: false,
        errorName: null,
        isTypeError: false,
        isFirebaseError: false,
        code: null,
        message: null,
      });
    } finally {
      await deleteApp(app);
    }
  });
});
