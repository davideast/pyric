import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { deleteApp as fbDeleteApp, initializeApp as fbInitializeApp } from 'firebase/app';
import {
  FieldPath as fbFieldPath,
  disableNetwork as fbDisableNetwork,
  doc as fbDoc,
  getDocFromCache as fbGetDocFromCache,
  getDocsFromCache as fbGetDocsFromCache,
  initializeFirestore as fbInitializeFirestore,
  loadBundle as fbLoadBundle,
  memoryLocalCache as fbMemoryLocalCache,
  namedQuery as fbNamedQuery,
  terminate as fbTerminate,
} from 'firebase/firestore';
import { FirebaseError, deleteApp, initializeApp } from 'pyric/app';
import { resetAppRegistryForTests } from 'pyric/app/internal';
import {
  FieldPath,
  FirestoreError,
  LoadBundleTask,
  Query,
  Timestamp,
  VectorValue,
  disableNetwork,
  doc,
  getDocFromCache,
  getDocsFromCache,
  getFirestore,
  initializeFirestore,
  loadBundle,
  memoryLocalCache,
  namedQuery,
  setDoc,
  terminate,
  type LoadBundleTaskProgress,
} from 'pyric/firestore';
import { initializeSandbox } from 'pyric/sandbox';

function encodeElements(elements: readonly unknown[]): string {
  const enc = new TextEncoder();
  let out = '';
  for (const el of elements) {
    const json = JSON.stringify(el);
    out += `${enc.encode(json).byteLength}${json}`;
  }
  return out;
}

function sampleArticlesBundle(): string {
  const parent = 'projects/demo-bundle/databases/(default)/documents';
  const body = encodeElements([
    {
      namedQuery: {
        name: 'published-articles',
        readTime: '2026-01-15T12:00:00.000000000Z',
        bundledQuery: {
          parent,
          structuredQuery: {
            from: [{ collectionId: 'articles' }],
            where: {
              fieldFilter: {
                field: { fieldPath: 'published' },
                op: 'EQUAL',
                value: { booleanValue: true },
              },
            },
            orderBy: [{ field: { fieldPath: 'rank' }, direction: 'ASCENDING' }],
          },
          limitType: 'FIRST',
        },
      },
    },
    {
      documentMetadata: {
        name: `${parent}/articles/alpha`,
        readTime: '2026-01-15T12:00:00.000000000Z',
        exists: true,
        queries: ['published-articles'],
      },
    },
    {
      document: {
        name: `${parent}/articles/alpha`,
        fields: {
          title: { stringValue: 'First Post' },
          published: { booleanValue: true },
          rank: { integerValue: '1' },
        },
      },
    },
    {
      documentMetadata: {
        name: `${parent}/articles/ghost`,
        readTime: '2026-01-15T12:00:00.000000000Z',
        exists: false,
        queries: [],
      },
    },
  ]);
  const totalBytes = new TextEncoder().encode(body).byteLength;
  const header = encodeElements([
    {
      metadata: {
        id: 'articles-v1',
        createTime: '2026-01-15T12:00:00.000000000Z',
        version: 1,
        totalDocuments: 2,
        totalBytes,
      },
    },
  ]);
  return header + body;
}

describe('loadBundle, LoadBundleTask, and namedQuery', () => {
  beforeEach(async () => {
    await resetAppRegistryForTests();
  });

  afterEach(async () => {
    await resetAppRegistryForTests();
  });

  it('loads string, Uint8Array, and ReadableStream bundles with progress and namedQuery hydration', async () => {
    const db = getFirestore(initializeSandbox());
    const bundle = sampleArticlesBundle();
    const steps: LoadBundleTaskProgress[] = [];
    let completed = false;
    const task = loadBundle(db, bundle);
    expect(task).toBeInstanceOf(LoadBundleTask);
    task.onProgress(
      (p) => steps.push(p),
      undefined,
      () => {
        completed = true;
      },
    );
    const finalProgress = await task;
    expect(completed).toBe(true);
    expect(finalProgress.taskState).toBe('Success');
    expect(finalProgress.documentsLoaded).toBe(2);
    expect(steps.length).toBe(4);

    const alpha = await getDocFromCache(doc(db, 'articles/alpha'));
    expect(alpha.exists()).toBe(true);
    expect(alpha.metadata.fromCache).toBe(true);
    expect(alpha.data()).toEqual({ title: 'First Post', published: true, rank: 1 });

    const ghost = await getDocFromCache(doc(db, 'articles/ghost'));
    expect(ghost.exists()).toBe(false);
    expect(ghost.metadata.fromCache).toBe(true);
    expect(ghost.data()).toBeUndefined();

    const q = await namedQuery(db, 'published-articles');
    expect(q).toBeInstanceOf(Query);
    expect(await namedQuery(db, 'missing')).toBeNull();
    const qSnap = await getDocsFromCache(q as Query);
    expect(qSnap.size).toBe(1);
    expect(qSnap.metadata.fromCache).toBe(true);
    expect(qSnap.docs.map((d) => d.id)).toEqual(['alpha']);

    const dbStream = getFirestore(initializeSandbox());
    const bytes = new TextEncoder().encode(bundle);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.subarray(0, 40));
        controller.enqueue(bytes.subarray(40));
        controller.close();
      },
    });
    const streamProgress = await loadBundle(dbStream, stream);
    expect(streamProgress.taskState).toBe('Success');
  });

  it('matches offline firebase/firestore on protobuf server bundles with unaryFilter, cursors, VectorValue, and version monotonicity (#1983)', async () => {
    const projectId = 'bundle-parity-1983';
    const parent = `projects/${projectId}/databases/(default)/documents`;
    const body = encodeElements([
      {
        namedQuery: {
          name: 'active-window',
          readTime: { seconds: '1700002000', nanos: 0 },
          bundledQuery: {
            parent,
            structuredQuery: {
              from: [{ collectionId: 'items' }],
              where: {
                unaryFilter: {
                  op: 'IS_NULL',
                  field: { fieldPath: 'deletedAt' },
                },
              },
              orderBy: [
                { field: { fieldPath: 'rank' }, direction: 'ASCENDING' },
                { field: { fieldPath: '__name__' }, direction: 'ASCENDING' },
              ],
              startAt: {
                before: true,
                values: [{ integerValue: '2' }, { referenceValue: `${parent}/items/b` }],
              },
              endAt: {
                before: false,
                values: [{ integerValue: '3' }, { referenceValue: `${parent}/items/c` }],
              },
            },
            limitType: 'FIRST',
          },
        },
      },
      {
        documentMetadata: {
          name: `${parent}/items/a`,
          readTime: { seconds: '1700002000', nanos: 0 },
          exists: true,
          queries: [],
        },
      },
      {
        document: {
          name: `${parent}/items/a`,
          createTime: { seconds: '1700001000', nanos: 0 },
          updateTime: { seconds: '1700001500', nanos: 0 },
          fields: {
            rank: { integerValue: '1' },
            deletedAt: { nullValue: 'NULL_VALUE' },
            when: { timestampValue: { seconds: '1700000000', nanos: 123456000 } },
            embedding: {
              mapValue: {
                fields: {
                  __type__: { stringValue: '__vector__' },
                  value: {
                    arrayValue: {
                      values: [{ doubleValue: 1.5 }, { doubleValue: -2.25 }],
                    },
                  },
                },
              },
            },
            'meta.tag': { stringValue: 'escaped-dot' },
          },
        },
      },
      {
        documentMetadata: {
          name: `${parent}/items/b`,
          readTime: { seconds: '1700002000', nanos: 0 },
          exists: true,
          queries: ['active-window'],
        },
      },
      {
        document: {
          name: `${parent}/items/b`,
          createTime: { seconds: '1700001000', nanos: 0 },
          updateTime: { seconds: '1700001500', nanos: 0 },
          fields: {
            rank: { integerValue: '2' },
            deletedAt: { nullValue: 'NULL_VALUE' },
          },
        },
      },
      {
        documentMetadata: {
          name: `${parent}/items/c`,
          readTime: { seconds: '1700002000', nanos: 0 },
          exists: true,
          queries: [],
        },
      },
      {
        document: {
          name: `${parent}/items/c`,
          createTime: { seconds: '1700001000', nanos: 0 },
          updateTime: { seconds: '1700001500', nanos: 0 },
          fields: {
            rank: { integerValue: '3' },
            deletedAt: { stringValue: 'archived' },
          },
        },
      },
      {
        documentMetadata: {
          name: `${parent}/items/d`,
          readTime: { seconds: '1700002000', nanos: 0 },
          exists: true,
          queries: [],
        },
      },
      {
        document: {
          name: `${parent}/items/d`,
          createTime: { seconds: '1700001000', nanos: 0 },
          updateTime: { seconds: '1700001500', nanos: 0 },
          fields: {
            rank: { integerValue: '4' },
            deletedAt: { nullValue: 'NULL_VALUE' },
          },
        },
      },
    ]);
    const totalBytes = new TextEncoder().encode(body).byteLength;
    const bundle =
      encodeElements([
        {
          metadata: {
            id: 'server-feed',
            createTime: { seconds: '1700002000', nanos: 0 },
            version: 1,
            totalDocuments: 4,
            totalBytes: String(totalBytes),
          },
        },
      ]) + body;

    const fbApp = fbInitializeApp({ apiKey: 'fake-key', projectId }, 'bundle-parity-app-1983');
    const fbDb = fbInitializeFirestore(fbApp, { localCache: fbMemoryLocalCache() });
    const pyApp = initializeApp({ projectId }, 'py-bundle-parity-app-1983');
    const pyDb = initializeFirestore(pyApp, { localCache: memoryLocalCache() });
    try {
      await fbDisableNetwork(fbDb);
      await disableNetwork(pyDb);

      await fbLoadBundle(fbDb, bundle);
      await loadBundle(pyDb, bundle);

      const fbQuery = await fbNamedQuery(fbDb, 'active-window');
      const pyQuery = await namedQuery(pyDb, 'active-window');
      expect(fbQuery).not.toBeNull();
      expect(pyQuery).not.toBeNull();
      const fbIds = (await fbGetDocsFromCache(fbQuery as NonNullable<typeof fbQuery>)).docs.map((d) => d.id);
      const pyIds = (await getDocsFromCache(pyQuery as Query)).docs.map((d) => d.id);
      expect(pyIds).toEqual(['b']);
      expect(pyIds).toEqual(fbIds);

      const fbDocA = await fbGetDocFromCache(fbDoc(fbDb, 'items/a'));
      const pyDocA = await getDocFromCache(doc(pyDb, 'items/a'));
      const pyWhen = pyDocA.data()?.when as Timestamp | undefined;
      expect(pyWhen).toBeInstanceOf(Timestamp);
      expect(pyWhen?.seconds).toBe(1_700_000_000);
      expect(pyWhen?.nanoseconds).toBe(fbDocA.data()?.when?.nanoseconds);
      const pyVec = pyDocA.data()?.embedding as VectorValue | undefined;
      expect(pyVec).toBeInstanceOf(VectorValue);
      expect(pyVec?.toArray()).toEqual(fbDocA.data()?.embedding?.toArray());
      expect(pyDocA.get(new FieldPath('meta.tag'))).toBe(fbDocA.get(new fbFieldPath('meta.tag')));

      // Stale bundle with same id is skipped with a single terminal Success progress step.
      const staleBody = encodeElements([
        {
          documentMetadata: {
            name: `${parent}/items/b`,
            readTime: { seconds: '1700001000', nanos: 0 },
            exists: true,
          },
        },
        {
          document: {
            name: `${parent}/items/b`,
            createTime: { seconds: '1700000500', nanos: 0 },
            updateTime: { seconds: '1700000900', nanos: 0 },
            fields: { rank: { integerValue: '999' }, deletedAt: { nullValue: 'NULL_VALUE' } },
          },
        },
      ]);
      const staleSameId =
        encodeElements([
          {
            metadata: {
              id: 'server-feed',
              createTime: { seconds: '1700001000', nanos: 0 },
              version: 1,
              totalDocuments: 1,
              totalBytes: new TextEncoder().encode(staleBody).byteLength,
            },
          },
        ]) + staleBody;

      const fbSkipEvents: unknown[] = [];
      const pySkipEvents: LoadBundleTaskProgress[] = [];
      const fbSkipTask = fbLoadBundle(fbDb, staleSameId);
      fbSkipTask.onProgress((p) => fbSkipEvents.push(p));
      await fbSkipTask;
      const pySkipTask = loadBundle(pyDb, staleSameId);
      pySkipTask.onProgress((p) => pySkipEvents.push(p));
      await pySkipTask;
      expect(pySkipEvents).toEqual(fbSkipEvents as LoadBundleTaskProgress[]);
      expect((await getDocFromCache(doc(pyDb, 'items/b'))).data()?.rank).toBe(2);

      // Different bundle id carrying an older document updateTime does not overwrite newer cached doc.
      const staleDocNewId =
        encodeElements([
          {
            metadata: {
              id: 'other-feed',
              createTime: { seconds: '1700003000', nanos: 0 },
              version: 1,
              totalDocuments: 1,
              totalBytes: new TextEncoder().encode(staleBody).byteLength,
            },
          },
        ]) + staleBody;
      await fbLoadBundle(fbDb, staleDocNewId);
      await loadBundle(pyDb, staleDocNewId);
      expect((await getDocFromCache(doc(pyDb, 'items/b'))).data()?.rank).toBe(
        (await fbGetDocFromCache(fbDoc(fbDb, 'items/b'))).data()?.rank,
      );

      // Local offline pending writes stay overlaid on top of bundled ground state.
      void setDoc(doc(pyDb, 'items/b'), { rank: 77, deletedAt: null });
      const overlaid = await getDocFromCache(doc(pyDb, 'items/b'));
      expect(overlaid.metadata.hasPendingWrites).toBe(true);
      expect(overlaid.data()?.rank).toBe(77);
    } finally {
      await terminate(pyDb);
      await deleteApp(pyApp);
      await fbTerminate(fbDb);
      await fbDeleteApp(fbApp);
    }
  });

  it('enforces NoDocument readTime version monotonicity (C1 & C2) and cross-project key rejection matching firebase/firestore', async () => {
    const projectId = 'bundle-mono-1983';
    const parent = `projects/${projectId}/databases/(default)/documents`;
    const makeSingleDocBundle = (
      bundleId: string,
      createSec: number,
      metaEl: Record<string, unknown>,
      docEl?: Record<string, unknown>,
    ): string => {
      const els = docEl === undefined ? [metaEl] : [metaEl, docEl];
      const b = encodeElements(els);
      const h = encodeElements([
        {
          metadata: {
            id: bundleId,
            createTime: { seconds: String(createSec), nanos: 0 },
            version: 1,
            totalDocuments: 1,
            totalBytes: new TextEncoder().encode(b).byteLength,
          },
        },
      ]);
      return h + b;
    };

    const fbApp = fbInitializeApp({ apiKey: 'fake-key', projectId }, 'fb-bundle-mono-1983');
    const fbDb = fbInitializeFirestore(fbApp, { localCache: fbMemoryLocalCache() });
    const pyApp = initializeApp({ projectId }, 'py-bundle-mono-1983');
    const pyDb = initializeFirestore(pyApp, { localCache: memoryLocalCache() });
    try {
      await fbDisableNetwork(fbDb);
      await disableNetwork(pyDb);

      // Seed Found @ updateTime T2 (1700002000).
      const seedFoundT2 = makeSingleDocBundle(
        'b-seed-t2',
        1_700_002_000,
        { documentMetadata: { name: `${parent}/items/x`, readTime: { seconds: '1700002000', nanos: 0 }, exists: true } },
        {
          document: {
            name: `${parent}/items/x`,
            updateTime: { seconds: '1700002000', nanos: 0 },
            fields: { v: { stringValue: 't2' } },
          },
        },
      );
      await fbLoadBundle(fbDb, seedFoundT2);
      await loadBundle(pyDb, seedFoundT2);

      // C1: Older NoDocument (readTime T1 = 1700001000 < T2) in a newer bundle does NOT delete Found@T2.
      const staleNoDocT1 = makeSingleDocBundle('b-nodoc-t1', 1_700_002_500, {
        documentMetadata: { name: `${parent}/items/x`, readTime: { seconds: '1700001000', nanos: 0 }, exists: false },
      });
      await fbLoadBundle(fbDb, staleNoDocT1);
      await loadBundle(pyDb, staleNoDocT1);
      expect((await getDocFromCache(doc(pyDb, 'items/x'))).exists()).toBe(true);
      expect((await getDocFromCache(doc(pyDb, 'items/x'))).exists()).toBe(
        (await fbGetDocFromCache(fbDoc(fbDb, 'items/x'))).exists(),
      );
      expect((await getDocFromCache(doc(pyDb, 'items/x'))).data()).toEqual({ v: 't2' });

      // Newer NoDocument (readTime T3 = 1700003000 > T2) deletes Found@T2.
      const newerNoDocT3 = makeSingleDocBundle('b-nodoc-t3', 1_700_003_000, {
        documentMetadata: { name: `${parent}/items/x`, readTime: { seconds: '1700003000', nanos: 0 }, exists: false },
      });
      await fbLoadBundle(fbDb, newerNoDocT3);
      await loadBundle(pyDb, newerNoDocT3);
      expect((await getDocFromCache(doc(pyDb, 'items/x'))).exists()).toBe(false);
      expect((await getDocFromCache(doc(pyDb, 'items/x'))).exists()).toBe(
        (await fbGetDocFromCache(fbDoc(fbDb, 'items/x'))).exists(),
      );

      // C2: Older Found (updateTime T2 = 1700002000 < T3) does NOT resurrect NoDocument@T3.
      const staleFoundT2 = makeSingleDocBundle(
        'b-found-stale-t2',
        1_700_003_500,
        { documentMetadata: { name: `${parent}/items/x`, readTime: { seconds: '1700003500', nanos: 0 }, exists: true } },
        {
          document: {
            name: `${parent}/items/x`,
            updateTime: { seconds: '1700002000', nanos: 0 },
            fields: { v: { stringValue: 'resurrected-stale' } },
          },
        },
      );
      await fbLoadBundle(fbDb, staleFoundT2);
      await loadBundle(pyDb, staleFoundT2);
      expect((await getDocFromCache(doc(pyDb, 'items/x'))).exists()).toBe(false);
      expect((await getDocFromCache(doc(pyDb, 'items/x'))).exists()).toBe(
        (await fbGetDocFromCache(fbDoc(fbDb, 'items/x'))).exists(),
      );

      // Newer Found (updateTime T4 = 1700004000 > T3) resurrects the document.
      const newerFoundT4 = makeSingleDocBundle(
        'b-found-t4',
        1_700_004_000,
        { documentMetadata: { name: `${parent}/items/x`, readTime: { seconds: '1700004000', nanos: 0 }, exists: true } },
        {
          document: {
            name: `${parent}/items/x`,
            updateTime: { seconds: '1700004000', nanos: 0 },
            fields: { v: { stringValue: 't4' } },
          },
        },
      );
      await fbLoadBundle(fbDb, newerFoundT4);
      await loadBundle(pyDb, newerFoundT4);
      expect((await getDocFromCache(doc(pyDb, 'items/x'))).data()).toEqual(
        (await fbGetDocFromCache(fbDoc(fbDb, 'items/x'))).data(),
      );

      // Cross-project document key in bundle rejects with invalid-argument matching firebase/firestore.
      const wrongProjBundle = makeSingleDocBundle(
        'b-wrong-proj',
        1_700_005_000,
        {
          documentMetadata: {
            name: 'projects/other-proj/databases/(default)/documents/items/x',
            readTime: { seconds: '1700005000', nanos: 0 },
            exists: false,
          },
        },
      );
      let fbProjErr: unknown;
      try {
        await fbLoadBundle(fbDb, wrongProjBundle);
      } catch (err) {
        fbProjErr = err;
      }
      let pyProjErr: unknown;
      try {
        await loadBundle(pyDb, wrongProjBundle);
      } catch (err) {
        pyProjErr = err;
      }
      expect(pyProjErr).toBeInstanceOf(FirebaseError);
      expect((pyProjErr as { code?: string }).code).toBe((fbProjErr as { code?: string }).code);
      expect((pyProjErr as Error).message).toContain(
        `Tried to deserialize key from different project: other-proj vs ${projectId}`,
      );
    } finally {
      await terminate(pyDb);
      await deleteApp(pyApp);
      await fbTerminate(fbDb);
      await fbDeleteApp(fbApp);
    }
  });

  it('rejects raw ArrayBuffer synchronously with FirebaseError(invalid-argument) and rejects malformed payloads asynchronously with plain Error', async () => {
    const db = getFirestore(initializeSandbox());
    expect(() => loadBundle(db, new ArrayBuffer(8))).toThrow(FirebaseError);

    let progressErr: unknown;
    const badTask = loadBundle(db, 'not-a-valid-bundle');
    badTask.onProgress(undefined, (err) => {
      progressErr = err;
    });
    let rejected: unknown;
    try {
      await badTask;
    } catch (err) {
      rejected = err;
    }
    expect(rejected).toBeInstanceOf(Error);
    expect(rejected).not.toBeInstanceOf(FirebaseError);
    expect(rejected).not.toBeInstanceOf(FirestoreError);
    expect(progressErr).toBe(rejected);
  });
});
