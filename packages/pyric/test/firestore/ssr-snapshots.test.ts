import { describe, expect, it } from 'bun:test';
import { FirebaseError } from 'pyric/app';
import {
  DocumentSnapshot,
  QueryDocumentSnapshot,
  QuerySnapshot,
  collection,
  doc,
  documentSnapshotFromJSON,
  getDoc,
  getDocs,
  getFirestore,
  onSnapshotResume,
  orderBy,
  query,
  querySnapshotFromJSON,
  setDoc,
  snapshotEqual,
  where,
} from 'pyric/firestore';
import { initializeSandbox } from 'pyric/sandbox';

describe('SSR snapshot serialization, hydration, and onSnapshotResume', () => {
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
      const unsub = onSnapshotResume(docConsumer, alphaJson, (s: DocumentSnapshot) => {
        unsub();
        resolve(s);
      }, reject);
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
});
