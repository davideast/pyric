import { deleteApp, initializeApp } from 'firebase/app';
import {
  collection,
  collectionGroup,
  doc,
  getFirestore,
  query,
  queryEqual,
  refEqual,
  setDoc,
  where,
} from 'firebase/firestore';
import { describe, expect, test } from 'bun:test';
import { FirestoreQueryTimeoutError } from '../../src/firestore-probe-outcomes.ts';
import {
  createRecordedItemConverter,
  observeInitialQuerySnapshot,
} from '../../src/firestore-withconverter-probe-model.ts';
import {
  loadModularProbes,
  printModularProbePreview,
  selectModularProbes,
} from '../../src/sdk-probes.ts';
import { expectStagedUntilCaptured } from './staged-capture-assertions.ts';
import { probe as collMethodProbe } from '../../probes/firestore/firestore-withconverter-collection-method-propagation.ts';
import { probe as collToDocProbe } from '../../probes/firestore/firestore-withconverter-collection-propagates-to-doc.ts';
import { probe as collToQueryProbe } from '../../probes/firestore/firestore-withconverter-collection-propagates-to-query-getdocs.ts';
import { probe as docRoundtripProbe } from '../../probes/firestore/firestore-withconverter-doc-roundtrip.ts';
import { probe as getDocProbe } from '../../probes/firestore/firestore-withconverter-getdoc-invokes-fromfirestore.ts';
import { probe as nullStripProbe } from '../../probes/firestore/firestore-withconverter-null-strips-converter.ts';
import { probe as untypedIdentityProbe } from '../../probes/firestore/firestore-withconverter-preserves-untyped-ref-identity.ts';
import { probe as queryMethodProbe } from '../../probes/firestore/firestore-withconverter-query-method-and-subcollection-isolation.ts';
import { probe as setDocProbe } from '../../probes/firestore/firestore-withconverter-setdoc-invokes-tofirestore.ts';
import { probe as updateDocProbe } from '../../probes/firestore/firestore-withconverter-updatedoc-bypasses-converter.ts';

const WITHCONVERTER_PROBE_IDS = [
  'firestore-withconverter-collection-method-propagation',
  'firestore-withconverter-collection-propagates-to-doc',
  'firestore-withconverter-collection-propagates-to-query-getdocs',
  'firestore-withconverter-doc-roundtrip',
  'firestore-withconverter-getdoc-invokes-fromfirestore',
  'firestore-withconverter-null-strips-converter',
  'firestore-withconverter-preserves-untyped-ref-identity',
  'firestore-withconverter-query-method-and-subcollection-isolation',
  'firestore-withconverter-setdoc-invokes-tofirestore',
  'firestore-withconverter-updatedoc-bypasses-converter',
] as const;

describe('Firestore withConverter staged probes (sdk-probes)', () => {
  test('registers all 10 withConverter probes on sdk-probes with pendingRowLink and empty rowIds', async () => {
    const loaded = await loadModularProbes('sdk-probes');
    const loadedIds = loaded.map((entry) => entry.id);
    for (const id of WITHCONVERTER_PROBE_IDS) {
      expect(loadedIds).toContain(id);
    }

    const probes = [
      collMethodProbe,
      collToDocProbe,
      collToQueryProbe,
      docRoundtripProbe,
      getDocProbe,
      nullStripProbe,
      untypedIdentityProbe,
      queryMethodProbe,
      setDocProbe,
      updateDocProbe,
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

    expectStagedUntilCaptured(WITHCONVERTER_PROBE_IDS, {
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
    expect(lines.some((line) => line.includes('firestore-withconverter-doc-roundtrip'))).toBe(
      true,
    );
  });

  test('records converter toFirestore and fromFirestore call metadata and enforces snapshot timeout cleanup', async () => {
    const { converter, toFirestoreCalls, fromFirestoreCalls, resetCalls } =
      createRecordedItemConverter();

    const fullPayload = converter.toFirestore({ title: 'Book', count: 4, tag: 'sci-fi' });
    expect(fullPayload).toEqual({
      convertedWrite: true,
      dbTitle: 'Book',
      dbCount: 40,
      dbTag: 'sci-fi',
    });
    const mergePayload = converter.toFirestore({ count: 9 }, { mergeFields: ['dbCount'] });
    expect(mergePayload).toEqual({
      convertedWrite: true,
      dbCount: 90,
    });
    expect(toFirestoreCalls).toEqual([
      { argCount: 1, hasOptions: false, merge: null, mergeFields: null },
      { argCount: 2, hasOptions: true, merge: null, mergeFields: ['dbCount'] },
    ]);

    const convertedRead = converter.fromFirestore(
      {
        id: 'doc-1',
        data() {
          return { dbTitle: 'Book', dbCount: 40, dbTag: 'sci-fi' };
        },
      } as never,
      undefined,
    );
    expect(convertedRead).toEqual({
      title: 'Book',
      count: 4,
      label: 'Book#40',
      tag: 'sci-fi',
    });
    expect(fromFirestoreCalls).toEqual([{ id: 'doc-1', argCount: 2, hasOptions: false }]);

    resetCalls();
    expect(toFirestoreCalls).toEqual([]);
    expect(fromFirestoreCalls).toEqual([]);

    let unsubscribedCount = 0;
    const rows = await observeInitialQuerySnapshot(
      (onNext) => {
        onNext({
          size: 1,
          docs: [],
        });
        onNext({
          size: 2,
          docs: [
            { id: 'b', data: () => ({ v: 2 }), ref: { converter } },
            { id: 'a', data: () => ({ v: 1 }), ref: { converter: null } },
          ],
        });
        return () => {
          unsubscribedCount += 1;
        };
      },
      2,
    );
    expect(rows).toEqual([
      { id: 'a', data: { v: 1 }, refHasConverter: false },
      { id: 'b', data: { v: 2 }, refHasConverter: true },
    ]);
    expect(unsubscribedCount).toBe(1);

    let timedOutUnsubscribed = false;
    await expect(
      observeInitialQuerySnapshot(
        () => () => {
          timedOutUnsubscribed = true;
        },
        1,
        25,
      ),
    ).rejects.toBeInstanceOf(FirestoreQueryTimeoutError);
    expect(timedOutUnsubscribed).toBe(true);
  });

  test('observes upstream firebase/firestore converter attachment, stripping, subcollection isolation, and setDoc preflight args', async () => {
    const app = initializeApp(
      { projectId: 'demo-withconverter-probe-test', apiKey: 'demo-key' },
      `wc-probe-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    try {
      const db = getFirestore(app);
      const { converter, toFirestoreCalls } = createRecordedItemConverter();

      const rawColl = collection(db, 'items');
      const typedColl = rawColl.withConverter(converter);
      const strippedColl = typedColl.withConverter(null);
      expect(rawColl.converter).toBeNull();
      expect(typedColl.converter).toBe(converter);
      expect(strippedColl.converter).toBeNull();
      expect(refEqual(rawColl, strippedColl)).toBe(true);
      expect(refEqual(rawColl, typedColl)).toBe(false);

      const childDoc = doc(typedColl, 'd1');
      const autoDoc = doc(typedColl);
      expect(childDoc.converter).toBe(converter);
      expect(autoDoc.converter).toBe(converter);
      expect(autoDoc.id.length).toBe(20);

      const subColl = collection(childDoc, 'notes');
      expect(subColl.converter).toBeNull();

      const baseQuery = query(rawColl, where('dbCount', '==', 10));
      const typedQuery = baseQuery.withConverter(converter);
      expect(typedQuery.converter).toBe(converter);
      expect(queryEqual(baseQuery, typedQuery)).toBe(false);
      expect(queryEqual(baseQuery, typedQuery.withConverter(null))).toBe(true);

      const groupQuery = collectionGroup(db, 'posts').withConverter(converter);
      expect(groupQuery.converter).toBe(converter);

      const stopConverter = {
        toFirestore(...args: unknown[]) {
          converter.toFirestore(...(args as [never]));
          throw new Error('STOP_PREFLIGHT');
        },
        fromFirestore: converter.fromFirestore,
      };
      const stopDoc = doc(rawColl, 'stop').withConverter(stopConverter);
      expect(() => setDoc(stopDoc, { title: 'One', count: 1 })).toThrow('STOP_PREFLIGHT');
      expect(() => setDoc(stopDoc, { count: 2 }, { merge: true })).toThrow('STOP_PREFLIGHT');
      expect(toFirestoreCalls).toEqual([
        { argCount: 1, hasOptions: false, merge: null, mergeFields: null },
        { argCount: 2, hasOptions: true, merge: true, mergeFields: null },
      ]);
    } finally {
      await deleteApp(app);
    }
  });
});
