import { deleteApp, FirebaseError, initializeApp } from 'firebase/app';
import {
  collection,
  collectionGroup,
  doc,
  getFirestore,
  refEqual,
} from 'firebase/firestore';
import { describe, expect, test } from 'bun:test';
import {
  isFirestoreAutoIdShape,
  observeFirestoreConstructorCall,
} from '../../src/firestore-path-constructor-probe-helpers.ts';
import {
  loadModularProbes,
  printModularProbePreview,
  selectModularProbes,
} from '../../src/sdk-probes.ts';
import { expectStagedUntilCaptured } from './staged-capture-assertions.ts';
import { probe as collDbProbe } from '../../probes/firestore/firestore-collection-db-path-reference-shape.ts';
import { probe as collSubProbe } from '../../probes/firestore/firestore-collection-from-doc-subcollection.ts';
import { probe as docDbProbe } from '../../probes/firestore/firestore-doc-db-path-reference-shape.ts';
import { probe as docAutoIdProbe } from '../../probes/firestore/firestore-doc-from-collection-autoid.ts';
import { probe as docFromCollProbe } from '../../probes/firestore/firestore-doc-from-collection-with-id.ts';
import { probe as docVariadicProbe } from '../../probes/firestore/firestore-doc-variadic-segments.ts';
import { probe as unknownRefProbe } from '../../probes/firestore/firestore-path-constructors-unknown-ref-errors.ts';

const PATH_CONSTRUCTOR_PROBE_IDS = [
  'firestore-collection-db-path-reference-shape',
  'firestore-collection-from-doc-subcollection',
  'firestore-doc-db-path-reference-shape',
  'firestore-doc-from-collection-autoid',
  'firestore-doc-from-collection-with-id',
  'firestore-doc-variadic-segments',
  'firestore-path-constructors-unknown-ref-errors',
] as const;

describe('Firestore Path constructors staged probes (sdk-probes)', () => {
  test('registers all 7 Path constructor probes on sdk-probes with pendingRowLink and empty rowIds', async () => {
    const loaded = await loadModularProbes('sdk-probes');
    const loadedIds = loaded.map((entry) => entry.id);
    for (const id of PATH_CONSTRUCTOR_PROBE_IDS) {
      expect(loadedIds).toContain(id);
    }

    const probes = [
      collDbProbe,
      collSubProbe,
      docDbProbe,
      docAutoIdProbe,
      docFromCollProbe,
      docVariadicProbe,
      unknownRefProbe,
    ];
    for (const probeRecord of probes) {
      expect(probeRecord.rig).toBe('sdk-probes');
      expect(probeRecord.requires).toEqual(['web-config', 'firestore-rules']);
      expect(probeRecord.pendingRowLink).toBe(true);
      expect(probeRecord.matrixRow).toBe('');
      expect(probeRecord.rowIds).toEqual([]);
      expect(probeRecord.description.length).toBeGreaterThan(20);
    }

    const unfilteredIds = new Set(
      selectModularProbes(loaded, [], 'sdk-probes', {
        includeUncapturedStaged: false,
      }).map((entry) => entry.id),
    );

    expectStagedUntilCaptured(PATH_CONSTRUCTOR_PROBE_IDS, {
      rig: 'sdk-probes',
      filterFlag: '--probe',
      filterValueFor: (name) => name,
      whenUncaptured(name) {
        expect(unfilteredIds.has(name)).toBe(false);
      },
      whenCaptured(name) {
        expect(unfilteredIds.has(name)).toBe(true);
      },
    });

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
