import { deleteApp, FirebaseError, initializeApp } from 'firebase/app';
import { doc, FieldPath, getFirestore, setDoc } from 'firebase/firestore';
import { describe, expect, test } from 'bun:test';
import {
  createSetDocOptionsRecorder,
  observeFirestoreWriteAttempt,
} from '../../src/firestore-setdoc-probe-helpers.ts';
import {
  loadModularProbes,
  printModularProbePreview,
  selectModularProbes,
} from '../../src/sdk-probes.ts';
import { expectStagedUntilCaptured } from './staged-capture-assertions.ts';
import { probe as bothFlagsProbe } from '../../probes/firestore/firestore-setdoc-both-merge-and-mergefields.ts';
import { probe as converterOptsProbe } from '../../probes/firestore/firestore-setdoc-converter-options-forwarding.ts';
import { probe as replaceProbe } from '../../probes/firestore/firestore-setdoc-default-replaces-entire-doc.ts';
import { probe as mergeTrueProbe } from '../../probes/firestore/firestore-setdoc-merge-true-deep-merges-maps.ts';
import { probe as mergeFieldsProbe } from '../../probes/firestore/firestore-setdoc-mergefields-dotted-and-fieldpath.ts';

const SETDOC_PROBE_IDS = [
  'firestore-setdoc-both-merge-and-mergefields',
  'firestore-setdoc-converter-options-forwarding',
  'firestore-setdoc-default-replaces-entire-doc',
  'firestore-setdoc-merge-true-deep-merges-maps',
  'firestore-setdoc-mergefields-dotted-and-fieldpath',
] as const;

describe('Firestore setDoc staged probes (sdk-probes)', () => {
  test('registers all 5 setDoc probes on sdk-probes with pendingRowLink and empty rowIds', async () => {
    const loaded = await loadModularProbes('sdk-probes');
    const loadedIds = loaded.map((entry) => entry.id);
    for (const id of SETDOC_PROBE_IDS) {
      expect(loadedIds).toContain(id);
    }

    const probes = [
      bothFlagsProbe,
      converterOptsProbe,
      replaceProbe,
      mergeTrueProbe,
      mergeFieldsProbe,
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

    expectStagedUntilCaptured(SETDOC_PROBE_IDS, {
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
      lines.some((line) => line.includes('firestore-setdoc-default-replaces-entire-doc')),
    ).toBe(true);
  });

  test('records converter options forwarding and synchronous setDoc validation without network I/O', async () => {
    const app = initializeApp(
      { projectId: 'demo-setdoc-probes', apiKey: 'demo-api-key' },
      `setdoc-probe-unit-${Math.random().toString(36).slice(2, 10)}`,
    );
    try {
      const db = getFirestore(app);
      const { converter, calls } = createSetDocOptionsRecorder();
      const stopConverter = {
        toFirestore(...args: unknown[]) {
          converter.toFirestore(...(args as [never]));
          throw new FirebaseError('invalid-argument', 'STOP_BEFORE_NETWORK');
        },
        fromFirestore: converter.fromFirestore,
      };
      const typedRef = doc(db, 'items/item-1').withConverter(stopConverter as never);

      const fullAttempt = await observeFirestoreWriteAttempt(
        () => setDoc(typedRef, { label: 'A', units: 3 }),
        FirebaseError,
      );
      expect(fullAttempt.threw).toBe(true);
      expect(fullAttempt.isFirebaseError).toBe(true);
      expect(fullAttempt.code).toBe('invalid-argument');

      const mergeAttempt = await observeFirestoreWriteAttempt(
        () => setDoc(typedRef, { units: 4 }, { merge: true }),
        FirebaseError,
      );
      expect(mergeAttempt.threw).toBe(true);

      const maskAttempt = await observeFirestoreWriteAttempt(
        () =>
          setDoc(
            typedRef,
            { label: 'B' },
            { mergeFields: ['dbLabel', new FieldPath('dbNote')] },
          ),
        FirebaseError,
      );
      expect(maskAttempt.threw).toBe(true);

      expect(calls).toEqual([
        { argCount: 1, hasOptions: false, merge: null, mergeFields: null },
        { argCount: 2, hasOptions: true, merge: true, mergeFields: null },
        { argCount: 2, hasOptions: true, merge: null, mergeFields: ['dbLabel', 'dbNote'] },
      ]);

      const okAttempt = await observeFirestoreWriteAttempt(
        async () => 'ok',
        FirebaseError,
      );
      expect(okAttempt.threw).toBe(false);
    } finally {
      await deleteApp(app);
    }
  });
});
