import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as upstreamApp from 'firebase/app';
import * as upstreamFs from 'firebase/firestore';
import { deleteApp, getApps, initializeApp } from 'pyric/app';
import { resetAppRegistryForTests } from 'pyric/app/internal';
import { initializeSandbox } from 'pyric/sandbox';
import {
  CollectionReference,
  Query,
  SnapshotMetadata,
  collection,
  disableNetwork,
  doc,
  documentSnapshotFromJSON,
  enableNetwork,
  getAdminFirestore,
  getDoc,
  getDocFromCache,
  getDocs,
  getDocsFromCache,
  getFirestore,
  onSnapshot,
  onSnapshotResume,
  query,
  queryEqual,
  querySnapshotFromJSON,
  setDoc,
  where,
  type FirestoreDataConverter,
  type QuerySnapshot,
} from 'pyric/firestore';

describe('Firestore.app/.type, QuerySnapshot.query, and SnapshotMetadata.isEqual (#1984)', () => {
  beforeEach(async () => {
    await resetAppRegistryForTests();
  });

  afterEach(async () => {
    await Promise.all(upstreamApp.getApps().map((a) => upstreamApp.deleteApp(a).catch(() => {})));
    await Promise.all(getApps().map((a) => deleteApp(a).catch(() => {})));
    await resetAppRegistryForTests();
  });

  it('exposes Firestore.app and Firestore.type matching firebase/firestore@12.19.0', () => {
    const upApp = upstreamApp.initializeApp({ projectId: 'meta-proj', apiKey: 'fake' }, 'up-1984');
    const upDb = upstreamFs.getFirestore(upApp);
    const pyApp = initializeApp({ projectId: 'meta-proj' }, 'py-1984');
    const pyDb = getFirestore(pyApp);
    const pyAdminDb = getAdminFirestore(pyApp);
    const sbDb = getFirestore(initializeSandbox());

    expect(pyDb.type).toBe(upDb.type);
    expect(pyDb.type).toBe('firestore');
    expect(pyDb.app).toBe(pyApp);
    expect(pyAdminDb.type).toBe('firestore');
    expect(pyAdminDb.app).toBe(pyApp);
    expect(sbDb.type).toBe('firestore');
  });

  it('implements SnapshotMetadata.isEqual across all (fromCache, hasPendingWrites) states and snapshot producers', async () => {
    const db = getFirestore(initializeSandbox());
    await setDoc(doc(db, 'notes/n1'), { text: 'hello' });

    const onlineDoc = await getDoc(doc(db, 'notes/n1'));
    const onlineDoc2 = await getDoc(doc(db, 'notes/n1'));
    const cachedDoc = await getDocFromCache(doc(db, 'notes/n1'));

    expect(onlineDoc.metadata).toBeInstanceOf(SnapshotMetadata);
    expect(cachedDoc.metadata).toBeInstanceOf(SnapshotMetadata);
    expect(Object.getPrototypeOf(onlineDoc.metadata)).toBe(SnapshotMetadata.prototype);
    expect(Object.keys(onlineDoc.metadata).sort()).toEqual(['fromCache', 'hasPendingWrites']);
    expect(onlineDoc.metadata).toEqual(onlineDoc2.metadata);

    expect(onlineDoc.metadata.isEqual?.(onlineDoc2.metadata)).toBe(true);
    expect(onlineDoc.metadata.isEqual?.({ fromCache: false, hasPendingWrites: false })).toBe(true);
    expect(onlineDoc.metadata.isEqual?.({ fromCache: false, hasPendingWrites: true })).toBe(false);
    expect(cachedDoc.metadata.isEqual?.({ fromCache: true, hasPendingWrites: false })).toBe(true);
    expect(onlineDoc.metadata.isEqual?.(cachedDoc.metadata)).toBe(false);

    await disableNetwork(db);
    const pendingWrite = setDoc(doc(db, 'notes/n1'), { text: 'offline' });
    const offlinePendingDoc = await getDoc(doc(db, 'notes/n1'));
    expect(offlinePendingDoc.metadata.isEqual?.({ fromCache: true, hasPendingWrites: true })).toBe(true);
    expect(offlinePendingDoc.metadata.isEqual?.(cachedDoc.metadata)).toBe(false);
    await enableNetwork(db);
    await pendingWrite;
  });

  it('populates QuerySnapshot.query and SnapshotMetadata.isEqual across getDocs, getDocsFromCache, onSnapshot, querySnapshotFromJSON, and onSnapshotResume', async () => {
    const db = getFirestore(initializeSandbox());
    await setDoc(doc(db, 'books/b1'), { title: 'Dune', active: true });

    const booksColl = collection(db, 'books');
    const activeBooks = query(booksColl, where('active', '==', true));

    const collSnap = await getDocs(booksColl);
    expect(collSnap.query).toBe(booksColl);
    expect(collSnap.query).toBeInstanceOf(CollectionReference);
    expect(collSnap.metadata.isEqual({ fromCache: false, hasPendingWrites: false })).toBe(true);

    const filteredSnap = await getDocs(activeBooks);
    expect(filteredSnap.query).toBe(activeBooks);
    expect(filteredSnap.query).toBeInstanceOf(Query);
    expect(queryEqual(filteredSnap.query, activeBooks)).toBe(true);

    const converter: FirestoreDataConverter<{ name: string }> = {
      toFirestore: (m) => ({ title: (m as { name: string }).name, active: true }),
      fromFirestore: (s) => ({ name: String(s.data().title) }),
    };
    const typedQuery = activeBooks.withConverter(converter);
    const typedSnap = await getDocs(typedQuery);
    expect(typedSnap.query).toBe(typedQuery);
    expect(queryEqual(typedSnap.query, typedQuery)).toBe(true);

    // Cold and warm getDocsFromCache
    const coldColl = collection(db, 'uncached');
    const coldCacheSnap = await getDocsFromCache(coldColl);
    expect(coldCacheSnap.query).toBe(coldColl);
    expect(coldCacheSnap.metadata.isEqual({ fromCache: true, hasPendingWrites: false })).toBe(true);

    const warmCacheSnap = await getDocsFromCache(activeBooks);
    expect(warmCacheSnap.query).toBe(activeBooks);
    expect(warmCacheSnap.metadata.isEqual({ fromCache: true, hasPendingWrites: false })).toBe(true);

    // Live listener QuerySnapshot
    const listenerSnap = await new Promise<QuerySnapshot>((resolve, reject) => {
      const unsub = onSnapshot(
        activeBooks,
        (s) => {
          unsub();
          resolve(s as QuerySnapshot);
        },
        reject,
      );
    });
    expect(listenerSnap.query).toBe(activeBooks);
    expect(listenerSnap.metadata.isEqual({ fromCache: false, hasPendingWrites: false })).toBe(true);
    expect(listenerSnap.metadata).toEqual(collSnap.metadata);

    // SSR querySnapshotFromJSON + documentSnapshotFromJSON + onSnapshotResume
    const consumerDb = getFirestore(initializeSandbox());
    const hydratedDoc = documentSnapshotFromJSON(consumerDb, (await getDoc(doc(db, 'books/b1'))).toJSON());
    expect(hydratedDoc.metadata.isEqual?.({ fromCache: false, hasPendingWrites: false })).toBe(true);

    const hydratedQ = querySnapshotFromJSON(consumerDb, filteredSnap.toJSON());
    expect(hydratedQ.query).toBeInstanceOf(Query);
    expect(queryEqual(hydratedQ.query, query(collection(consumerDb, 'books'), where('active', '==', true)))).toBe(true);
    expect(hydratedQ.metadata.isEqual({ fromCache: false, hasPendingWrites: false })).toBe(true);

    const resumeDb = getFirestore(initializeSandbox());
    const resumedQ = await new Promise<QuerySnapshot>((resolve, reject) => {
      const unsub = onSnapshotResume(
        resumeDb,
        filteredSnap.toJSON(),
        (s: QuerySnapshot) => {
          unsub();
          resolve(s);
        },
        reject,
      );
    });
    expect(resumedQ.query).toBeInstanceOf(Query);
    expect(resumedQ.metadata.isEqual({ fromCache: true, hasPendingWrites: false })).toBe(true);
  });
});
