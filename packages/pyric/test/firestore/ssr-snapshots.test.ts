import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { deleteApp as fbDeleteApp, initializeApp as fbInitializeApp } from 'firebase/app';
import {
  collection as fbCollection,
  disableNetwork as fbDisableNetwork,
  doc as fbDoc,
  documentSnapshotFromJSON as fbDocFromJSON,
  getDocFromCache as fbGetDocFromCache,
  getDocsFromCache as fbGetDocsFromCache,
  initializeFirestore as fbInitializeFirestore,
  loadBundle as fbLoadBundle,
  memoryLocalCache as fbMemoryLocalCache,
  onSnapshotResume as fbOnSnapshotResume,
  orderBy as fbOrderBy,
  query as fbQuery,
  querySnapshotFromJSON as fbQueryFromJSON,
  setDoc as fbSetDoc,
  startAfter as fbStartAfter,
  terminate as fbTerminate,
} from 'firebase/firestore';
import { FirebaseError, deleteApp, initializeApp } from 'pyric/app';
import { resetAppRegistryForTests } from 'pyric/app/internal';
import {
  DocumentSnapshot,
  QueryDocumentSnapshot,
  QuerySnapshot,
  collection,
  disableNetwork,
  doc,
  documentSnapshotFromJSON,
  getDoc,
  getDocFromCache,
  getDocs,
  getDocsFromCache,
  getFirestore,
  initializeFirestore,
  loadBundle,
  memoryLocalCache,
  onSnapshotResume,
  orderBy,
  query,
  querySnapshotFromJSON,
  setDoc,
  snapshotEqual,
  startAfter,
  terminate,
  where,
  type FirestoreDataConverter,
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

describe('SSR snapshot serialization, hydration, and onSnapshotResume', () => {
  beforeEach(async () => {
    await resetAppRegistryForTests();
  });

  afterEach(async () => {
    await resetAppRegistryForTests();
  });

  it('round-trips DocumentSnapshot.toJSON() and QuerySnapshot.toJSON() with fromCache:false on *FromJSON', async () => {
    const producer = getFirestore(initializeSandbox());
    await setDoc(doc(producer, 'articles/alpha'), { title: 'First Post', published: true, rank: 1 });
    await setDoc(doc(producer, 'articles/beta'), { title: 'Draft Note', published: false, rank: 2 });

    const alphaSnap = await getDoc(doc(producer, 'articles/alpha'));
    const ghostSnap = await getDoc(doc(producer, 'articles/ghost'));
    const publishedQ = query(
      collection(producer, 'articles'),
      where('published', '==', true),
      orderBy('rank', 'asc'),
    );
    const querySnap = await getDocs(publishedQ);

    const alphaJson = alphaSnap.toJSON() as Record<string, unknown>;
    const ghostJson = ghostSnap.toJSON() as Record<string, unknown>;
    const queryJson = querySnap.toJSON() as Record<string, unknown>;

    expect(Object.keys(alphaJson).sort()).toEqual(['bundle', 'bundleName', 'bundleSource', 'type']);
    expect(alphaJson.type).toBe('firestore/documentSnapshot/1.0');
    expect(ghostJson.bundle).toBe('');
    expect(queryJson.type).toBe('firestore/querySnapshot/1.0');

    const consumer = getFirestore(initializeSandbox());
    const hydratedDoc = documentSnapshotFromJSON(consumer, alphaJson);
    expect(hydratedDoc).toBeInstanceOf(DocumentSnapshot);
    expect(hydratedDoc.exists()).toBe(true);
    expect(hydratedDoc.metadata.fromCache).toBe(false);
    expect(hydratedDoc.data()).toEqual({ title: 'First Post', published: true, rank: 1 });
    expect(hydratedDoc.get('title')).toBe('First Post');

    expect(() => documentSnapshotFromJSON(consumer, ghostJson)).toThrow(Error);
    let missingDocErr: unknown;
    try {
      documentSnapshotFromJSON(consumer, ghostJson);
    } catch (err) {
      missingDocErr = err;
    }
    expect(missingDocErr).not.toBeInstanceOf(FirebaseError);

    const hydratedQ1 = querySnapshotFromJSON(consumer, queryJson);
    const hydratedQ2 = querySnapshotFromJSON(consumer, queryJson);
    expect(hydratedQ1).toBeInstanceOf(QuerySnapshot);
    expect(hydratedQ1.metadata.fromCache).toBe(false);
    expect(hydratedQ1.size).toBe(1);
    expect(hydratedQ1.docs[0]).toBeInstanceOf(QueryDocumentSnapshot);
    expect(snapshotEqual(hydratedQ1, hydratedQ2)).toBe(true);

    expect(() => documentSnapshotFromJSON(consumer, {})).toThrow(FirebaseError);
    expect(() => documentSnapshotFromJSON(consumer, queryJson)).toThrow(FirebaseError);
    expect(() => querySnapshotFromJSON(consumer, {})).toThrow(FirebaseError);
    expect(() => querySnapshotFromJSON(consumer, alphaJson)).toThrow(FirebaseError);
  });

  it('delivers initial resumed snapshots with fromCache:true on onSnapshotResume', async () => {
    const producer = getFirestore(initializeSandbox());
    await setDoc(doc(producer, 'articles/alpha'), { title: 'First Post', published: true, rank: 1 });
    const alphaJson = (await getDoc(doc(producer, 'articles/alpha'))).toJSON();
    const queryJson = (await getDocs(query(collection(producer, 'articles'), where('published', '==', true)))).toJSON();

    const docConsumer = getFirestore(initializeSandbox());
    const resumedDoc = await new Promise<DocumentSnapshot>((resolve, reject) => {
      const unsub = onSnapshotResume(
        docConsumer,
        alphaJson,
        (s: DocumentSnapshot) => {
          unsub();
          resolve(s);
        },
        reject,
      );
      expect(typeof unsub).toBe('function');
    });
    expect(resumedDoc.metadata.fromCache).toBe(true);
    expect(resumedDoc.data()).toEqual({ title: 'First Post', published: true, rank: 1 });

    const queryConsumer = getFirestore(initializeSandbox());
    const resumedQuery = await new Promise<QuerySnapshot>((resolve, reject) => {
      const unsub = onSnapshotResume(queryConsumer, queryJson, {
        next: (s: QuerySnapshot) => {
          unsub();
          resolve(s);
        },
        error: reject,
      });
      expect(typeof unsub).toBe('function');
    });
    expect(resumedQuery.metadata.fromCache).toBe(true);
    expect(resumedQuery.docs.map((d) => d.id)).toEqual(['alpha']);
  });

  it('matches firebase/firestore on converters, pending-write failed-precondition, query sorting/cursors, and garbage rejection (#1982)', async () => {
    const projectId = 'ssr-parity-1982';
    const parent = `projects/${projectId}/databases/(default)/documents`;
    const seedBody = encodeElements([
      {
        documentMetadata: {
          name: `${parent}/posts/p1`,
          readTime: '2026-01-15T12:00:00.000000000Z',
          exists: true,
        },
      },
      {
        document: {
          name: `${parent}/posts/p1`,
          createTime: '2026-01-15T11:00:00.000000000Z',
          updateTime: '2026-01-15T11:30:00.000000000Z',
          fields: { rank: { integerValue: '10' }, title: { stringValue: 'Alpha' } },
        },
      },
      {
        documentMetadata: {
          name: `${parent}/posts/p2`,
          readTime: '2026-01-15T12:00:00.000000000Z',
          exists: true,
        },
      },
      {
        document: {
          name: `${parent}/posts/p2`,
          createTime: '2026-01-15T11:00:00.000000000Z',
          updateTime: '2026-01-15T11:30:00.000000000Z',
          fields: { rank: { integerValue: '20' }, title: { stringValue: 'Beta' } },
        },
      },
    ]);
    const seedBundle =
      encodeElements([
        {
          metadata: {
            id: 'seed-1982',
            createTime: '2026-01-15T12:00:00.000000000Z',
            version: 1,
            totalDocuments: 2,
            totalBytes: new TextEncoder().encode(seedBody).byteLength,
          },
        },
      ]) + seedBody;

    const fbApp1 = fbInitializeApp({ apiKey: 'fake-key', projectId }, 'ssr-parity-app-1');
    const fbApp2 = fbInitializeApp({ apiKey: 'fake-key', projectId }, 'ssr-parity-app-2');
    const fbAppOther = fbInitializeApp({ apiKey: 'fake-key', projectId: 'other-ssr-proj' }, 'ssr-parity-app-other');
    const fbDb = fbInitializeFirestore(fbApp1, { localCache: fbMemoryLocalCache() });
    const fbConsumer = fbInitializeFirestore(fbApp2, { localCache: fbMemoryLocalCache() });
    const fbOtherDb = fbInitializeFirestore(fbAppOther, { localCache: fbMemoryLocalCache() });
    const pyApp1 = initializeApp({ projectId }, 'py-ssr-parity-app-1');
    const pyApp2 = initializeApp({ projectId }, 'py-ssr-parity-app-2');
    const pyDb = initializeFirestore(pyApp1, { localCache: memoryLocalCache() });
    const pyConsumer = initializeFirestore(pyApp2, { localCache: memoryLocalCache() });

    try {
      await fbDisableNetwork(fbDb);
      await fbDisableNetwork(fbConsumer);
      await fbDisableNetwork(fbOtherDb);
      await disableNetwork(pyDb);
      await disableNetwork(pyConsumer);

      await fbLoadBundle(fbDb, seedBundle);
      await loadBundle(pyDb, seedBundle);

      // 1. FirestoreDataConverter round-trips raw wire fields on both DocumentSnapshot and QuerySnapshot.
      interface PostView {
        readonly summary: string;
      }
      const fbConv = {
        toFirestore: (model: PostView) => ({ title: model.summary, rank: 1 }),
        fromFirestore: (snap: { data(): Record<string, unknown> }): PostView => ({
          summary: `${String(snap.data().title)}#${String(snap.data().rank)}`,
        }),
      };
      const pyConv: FirestoreDataConverter<PostView> = {
        toFirestore: (model) => ({ title: model.summary, rank: 1 }),
        fromFirestore: (snap) => ({
          summary: `${String(snap.data().title)}#${String(snap.data().rank)}`,
        }),
      };

      const fbConvertedDocJson = (await fbGetDocFromCache(fbDoc(fbDb, 'posts/p1').withConverter(fbConv))).toJSON();
      const pyConvertedDocJson = (await getDocFromCache(doc(pyDb, 'posts/p1').withConverter(pyConv))).toJSON();
      expect(documentSnapshotFromJSON(pyConsumer, pyConvertedDocJson, pyConv).data()).toEqual(
        fbDocFromJSON(fbConsumer, fbConvertedDocJson, fbConv).data(),
      );
      expect(fbDocFromJSON(fbConsumer, pyConvertedDocJson, fbConv).data()).toEqual({ summary: 'Alpha#10' });
      expect(documentSnapshotFromJSON(pyConsumer, pyConvertedDocJson, pyConv).metadata.fromCache).toBe(false);

      const fbConvertedQueryJson = (
        await fbGetDocsFromCache(
          fbQuery(fbCollection(fbDb, 'posts').withConverter(fbConv), fbOrderBy('rank', 'asc'), fbStartAfter(10)),
        )
      ).toJSON();
      const pyConvertedQueryJson = (
        await getDocsFromCache(
          query(collection(pyDb, 'posts').withConverter(pyConv), orderBy('rank', 'asc'), startAfter(10)),
        )
      ).toJSON();

      const fbHydratedConvQ = fbQueryFromJSON(fbConsumer, fbConvertedQueryJson, fbConv);
      const pyHydratedConvQ = querySnapshotFromJSON(pyConsumer, pyConvertedQueryJson, pyConv);
      expect(pyHydratedConvQ.docs.map((d) => d.data())).toEqual([{ summary: 'Beta#20' }]);
      expect(pyHydratedConvQ.docs.map((d) => d.data())).toEqual(fbHydratedConvQ.docs.map((d) => d.data()));
      expect(fbQueryFromJSON(fbConsumer, pyConvertedQueryJson, fbConv).docs.map((d) => d.data())).toEqual([
        { summary: 'Beta#20' },
      ]);
      expect(pyHydratedConvQ.metadata.fromCache).toBe(false);

      // Cross-project *FromJSON rejects document keys from another project matching firebase/firestore.
      const otherSeedBody = encodeElements([
        {
          documentMetadata: {
            name: 'projects/other-ssr-proj/databases/(default)/documents/posts/p1',
            readTime: '2026-01-15T12:00:00.000000000Z',
            exists: true,
          },
        },
        {
          document: {
            name: 'projects/other-ssr-proj/databases/(default)/documents/posts/p1',
            updateTime: '2026-01-15T12:00:00.000000000Z',
            fields: { rank: { integerValue: '1' }, title: { stringValue: 'Other' } },
          },
        },
      ]);
      const otherSeedBundle =
        encodeElements([
          {
            metadata: {
              id: 'other-seed-1982',
              createTime: '2026-01-15T12:00:00.000000000Z',
              version: 1,
              totalDocuments: 1,
              totalBytes: new TextEncoder().encode(otherSeedBody).byteLength,
            },
          },
        ]) + otherSeedBody;
      await fbLoadBundle(fbOtherDb, otherSeedBundle);
      const otherDocJson = (await fbGetDocFromCache(fbDoc(fbOtherDb, 'posts/p1'))).toJSON();
      const otherQueryJson = (await fbGetDocsFromCache(fbCollection(fbOtherDb, 'posts'))).toJSON();
      const otherEmptyQueryJson = (await fbGetDocsFromCache(fbCollection(fbOtherDb, 'emptyPosts'))).toJSON();
      expect(() => fbDocFromJSON(fbConsumer, otherDocJson)).toThrow(
        `Tried to deserialize key from different project: other-ssr-proj vs ${projectId}`,
      );
      expect(() => documentSnapshotFromJSON(pyConsumer, otherDocJson)).toThrow(
        `Tried to deserialize key from different project: other-ssr-proj vs ${projectId}`,
      );
      expect(() => fbQueryFromJSON(fbConsumer, otherQueryJson)).toThrow(
        `Tried to deserialize key from different project: other-ssr-proj vs ${projectId}`,
      );
      expect(() => querySnapshotFromJSON(pyConsumer, otherQueryJson)).toThrow(
        `Tried to deserialize key from different project: other-ssr-proj vs ${projectId}`,
      );
      expect(fbQueryFromJSON(fbConsumer, otherEmptyQueryJson).empty).toBe(true);
      expect(querySnapshotFromJSON(pyConsumer, otherEmptyQueryJson).empty).toBe(true);

      // 2. onSnapshotResume preserves query cursors and applies trailing converter on DocumentSnapshot.
      await fbLoadBundle(fbConsumer, seedBundle);
      await loadBundle(pyConsumer, seedBundle);
      const fbResumedDoc = await new Promise<PostView | undefined>((resolve, reject) => {
        const unsub = fbOnSnapshotResume(
          fbConsumer,
          fbConvertedDocJson,
          (snap) => {
            unsub();
            resolve(snap.data());
          },
          reject,
          undefined,
          fbConv as never,
        );
      });
      const pyResumedDoc = await new Promise<PostView | undefined>((resolve, reject) => {
        const unsub = onSnapshotResume(
          pyConsumer,
          pyConvertedDocJson,
          (snap) => {
            unsub();
            resolve((snap as DocumentSnapshot<PostView>).data());
          },
          reject,
          undefined,
          pyConv,
        );
      });
      expect(pyResumedDoc).toEqual({ summary: 'Alpha#10' });
      expect(pyResumedDoc).toEqual(fbResumedDoc);

      const pyResumedCursorIds = await new Promise<string[]>((resolve, reject) => {
        const unsub = onSnapshotResume(
          pyConsumer,
          pyConvertedQueryJson,
          (snap) => {
            unsub();
            resolve((snap as QuerySnapshot).docs.map((d) => d.id));
          },
          reject,
        );
      });
      expect(pyResumedCursorIds).toEqual(['p2']);

      // 3. querySnapshotFromJSON sorts out-of-order bundled documents by the query comparator.
      const outOfOrderBody = encodeElements([
        {
          namedQuery: {
            name: 'ordered-posts',
            readTime: '2026-01-15T12:00:00.000000000Z',
            bundledQuery: {
              parent,
              structuredQuery: {
                from: [{ collectionId: 'posts' }],
                orderBy: [{ field: { fieldPath: 'rank' }, direction: 'ASCENDING' }],
              },
              limitType: 'FIRST',
            },
          },
        },
        {
          documentMetadata: {
            name: `${parent}/posts/p2`,
            readTime: '2026-01-15T12:00:00.000000000Z',
            exists: true,
            queries: ['ordered-posts'],
          },
        },
        {
          document: {
            name: `${parent}/posts/p2`,
            createTime: '2026-01-15T11:00:00.000000000Z',
            updateTime: '2026-01-15T11:30:00.000000000Z',
            fields: { rank: { integerValue: '20' }, title: { stringValue: 'Beta' } },
          },
        },
        {
          documentMetadata: {
            name: `${parent}/posts/p1`,
            readTime: '2026-01-15T12:00:00.000000000Z',
            exists: true,
            queries: ['ordered-posts'],
          },
        },
        {
          document: {
            name: `${parent}/posts/p1`,
            createTime: '2026-01-15T11:00:00.000000000Z',
            updateTime: '2026-01-15T11:30:00.000000000Z',
            fields: { rank: { integerValue: '10' }, title: { stringValue: 'Alpha' } },
          },
        },
      ]);
      const outOfOrderJson = {
        type: 'firestore/querySnapshot/1.0',
        bundleSource: 'QuerySnapshot',
        bundleName: 'ordered-posts',
        bundle:
          encodeElements([
            {
              metadata: {
                id: 'ordered-posts',
                createTime: '2026-01-15T12:00:00.000000000Z',
                version: 1,
                totalDocuments: 2,
                totalBytes: new TextEncoder().encode(outOfOrderBody).byteLength,
              },
            },
          ]) + outOfOrderBody,
      };
      expect(querySnapshotFromJSON(pyConsumer, outOfOrderJson).docs.map((d) => d.id)).toEqual(
        fbQueryFromJSON(fbConsumer, outOfOrderJson).docs.map((d) => d.id),
      );

      // 4. toJSON() throws failed-precondition when metadata.hasPendingWrites is true.
      void fbSetDoc(fbDoc(fbDb, 'posts/pending'), { rank: 99, title: 'Pending' });
      void setDoc(doc(pyDb, 'posts/pending'), { rank: 99, title: 'Pending' });
      const fbPendingDoc = await fbGetDocFromCache(fbDoc(fbDb, 'posts/pending'));
      const pyPendingDoc = await getDocFromCache(doc(pyDb, 'posts/pending'));
      const pyPendingQuery = await getDocsFromCache(collection(pyDb, 'posts'));
      expect(() => fbPendingDoc.toJSON()).toThrow();
      expect(() => pyPendingDoc.toJSON()).toThrow(FirebaseError);
      expect(() => pyPendingQuery.toJSON()).toThrow(FirebaseError);
      let pendingErrCode = '';
      try {
        pyPendingDoc.toJSON();
      } catch (err) {
        pendingErrCode = (err as { code?: string }).code ?? '';
      }
      expect(pendingErrCode).toBe('failed-precondition');

      // 5. Garbage envelopes, client NOT SUPPORTED sentinels, wrong doc/query counts, and empty resume bundles are refused.
      const zeroBundle = encodeElements([
        { metadata: { id: 'empty', createTime: '2026-01-15T12:00:00.000000000Z', version: 1, totalDocuments: 0, totalBytes: 0 } },
      ]);
      for (const badDocInput of [
        null,
        'garbage',
        [],
        new Date(),
        { type: 'firestore/documentSnapshot/1.0', bundleSource: 'DocumentSnapshot', bundleName: 'posts/p1', bundle: 'NOT SUPPORTED' },
        { type: 'firestore/documentSnapshot/1.0', bundleSource: 'DocumentSnapshot', bundleName: 'posts/p1', bundle: zeroBundle },
        { type: 'firestore/documentSnapshot/1.0', bundleSource: 'DocumentSnapshot', bundleName: 'posts/p1', bundle: seedBundle },
      ]) {
        expect(() => documentSnapshotFromJSON(pyConsumer, badDocInput as object)).toThrow(FirebaseError);
      }
      for (const badQueryInput of [
        null,
        123,
        [],
        new Date(),
        { type: 'firestore/querySnapshot/1.0', bundleSource: 'QuerySnapshot', bundleName: 'q', bundle: 'NOT SUPPORTED' },
        { type: 'firestore/querySnapshot/1.0', bundleSource: 'QuerySnapshot', bundleName: 'q', bundle: zeroBundle },
      ]) {
        expect(() => querySnapshotFromJSON(pyConsumer, badQueryInput as object)).toThrow(FirebaseError);
      }

      const missingDocJson = {
        type: 'firestore/documentSnapshot/1.0',
        bundleSource: 'DocumentSnapshot',
        bundleName: 'posts/missing',
        bundle: '',
      };
      expect(() => onSnapshotResume(pyConsumer, missingDocJson, () => {})).toThrow(FirebaseError);
      expect(() => onSnapshotResume(pyConsumer, { bundle: seedBundle, bundleName: '', bundleSource: 'DocumentSnapshot' }, () => {})).toThrow(
        FirebaseError,
      );
      expect(() => onSnapshotResume(pyConsumer, { bundle: seedBundle, bundleName: 'posts/p1', bundleSource: 'Invalid' }, () => {})).toThrow(
        FirebaseError,
      );
      expect(() => onSnapshotResume(pyConsumer, null as unknown as object, () => {})).toThrow(TypeError);
    } finally {
      await terminate(pyDb);
      await terminate(pyConsumer);
      await deleteApp(pyApp1);
      await deleteApp(pyApp2);
      await fbTerminate(fbDb);
      await fbTerminate(fbConsumer);
      await fbTerminate(fbOtherDb);
      await fbDeleteApp(fbApp1);
      await fbDeleteApp(fbApp2);
      await fbDeleteApp(fbAppOther);
    }
  });
});
