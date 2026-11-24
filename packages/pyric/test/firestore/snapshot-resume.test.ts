import { describe, expect, it } from 'bun:test';
import { FirebaseError } from 'pyric/app';
import {
  DocumentSnapshot,
  QuerySnapshot,
  collection,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  onSnapshotResume,
  query,
  setDoc,
  where,
  type FirestoreDataConverter,
} from 'pyric/firestore';
import { initializeSandbox } from 'pyric/sandbox';

describe('onSnapshotResume validation, converters, and options overloads', () => {
  it('validates normalizeSnapshotJsonFields synchronously and supports options + converter overloads', async () => {
    const producer = getFirestore(initializeSandbox());
    await setDoc(doc(producer, 'notes/n1'), { body: 'Hello SSR', pinned: true });
    const existingDocJson = (await getDoc(doc(producer, 'notes/n1'))).toJSON() as Record<string, unknown>;
    const missingDocJson = (await getDoc(doc(producer, 'notes/missing'))).toJSON();
    const queryJson = (await getDocs(query(collection(producer, 'notes'), where('pinned', '==', true)))).toJSON() as Record<string, unknown>;

    const consumer = getFirestore(initializeSandbox());
    expect(() => onSnapshotResume(consumer, missingDocJson, () => {})).toThrow(FirebaseError);
    expect(() => onSnapshotResume(consumer, {}, () => {})).toThrow(FirebaseError);
    expect(() =>
      onSnapshotResume(
        consumer,
        { bundle: String(existingDocJson.bundle), bundleName: '', bundleSource: 'DocumentSnapshot' },
        () => {},
      ),
    ).toThrow(FirebaseError);
    expect(() =>
      onSnapshotResume(
        consumer,
        { bundle: String(existingDocJson.bundle), bundleName: 'notes/n1', bundleSource: 'UnknownSource' },
        () => {},
      ),
    ).toThrow(FirebaseError);

    // Envelopes without the optional `type` field still resume when bundle, bundleName, and bundleSource are valid.
    const typelessEnvelope = {
      bundle: String(existingDocJson.bundle),
      bundleName: String(existingDocJson.bundleName),
      bundleSource: 'DocumentSnapshot',
    };
    const conv: FirestoreDataConverter<{ upper: string }> = {
      toFirestore: (m) => ({ body: m.upper }),
      fromFirestore: (snap) => ({ upper: String(snap.data().body).toUpperCase() }),
    };

    const convertedDoc = await new Promise<DocumentSnapshot<{ upper: string }>>((resolve, reject) => {
      const unsub = onSnapshotResume(
        consumer,
        typelessEnvelope,
        { includeMetadataChanges: true },
        {
          next: (s: DocumentSnapshot<{ upper: string }>) => {
            unsub();
            resolve(s);
          },
          error: reject,
        },
        conv,
      );
    });
    expect(convertedDoc).toBeInstanceOf(DocumentSnapshot);
    expect(convertedDoc.metadata.fromCache).toBe(true);
    expect(convertedDoc.data()).toEqual({ upper: 'HELLO SSR' });

    const resumedQuery = await new Promise<QuerySnapshot>((resolve, reject) => {
      const unsub = onSnapshotResume(
        consumer,
        queryJson,
        { includeMetadataChanges: false },
        (s) => {
          unsub();
          resolve(s as QuerySnapshot);
        },
        reject,
      );
    });
    expect(resumedQuery).toBeInstanceOf(QuerySnapshot);
    expect(resumedQuery.metadata.fromCache).toBe(true);
    expect(resumedQuery.docs.map((d) => d.id)).toEqual(['n1']);
  });
});
