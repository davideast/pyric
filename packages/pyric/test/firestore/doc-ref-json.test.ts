import { afterEach, describe, expect, it } from 'bun:test';
import * as upstreamApp from 'firebase/app';
import * as upstreamFs from 'firebase/firestore';
import { FirebaseError } from 'pyric/app';
import { initializeSandbox } from 'pyric/sandbox';
import {
  DocumentReference,
  FirestoreError,
  collection,
  doc,
  getDoc,
  getFirestore,
  refEqual,
  setDoc,
  type FirestoreDataConverter,
} from 'pyric/firestore';

describe('DocumentReference.toJSON and DocumentReference.fromJSON (#1984)', () => {
  afterEach(async () => {
    await Promise.all(upstreamApp.getApps().map((a) => upstreamApp.deleteApp(a).catch(() => {})));
  });

  it('serializes DocumentReference.toJSON() and round-trips DocumentReference.fromJSON() matching firebase/firestore@12.19.0', async () => {
    const upApp = upstreamApp.initializeApp({ projectId: 'ref-json', apiKey: 'fake' }, 'up-ref-json');
    const upDb = upstreamFs.getFirestore(upApp);
    const upRef = upstreamFs.doc(upDb, 'orgs/acme/members/alice');
    const upJson = upRef.toJSON();

    const db = getFirestore(initializeSandbox());
    const pyRef = doc(db, 'orgs/acme/members/alice');
    const pyJson = pyRef.toJSON();

    expect(pyJson).toEqual(upJson);
    expect(pyJson).toEqual({
      type: 'firestore/documentReference/1.0',
      referencePath: 'orgs/acme/members/alice',
    });

    const hydrated = DocumentReference.fromJSON(db, pyJson);
    expect(hydrated).toBeInstanceOf(DocumentReference);
    expect(refEqual(hydrated, pyRef)).toBe(true);
    expect(hydrated.toJSON()).toEqual(pyJson);

    const converter: FirestoreDataConverter<{ handle: string }> = {
      toFirestore: (m) => ({ handle: (m as { handle: string }).handle }),
      fromFirestore: (s) => ({ handle: `@${String(s.data().handle)}` }),
    };
    const typedRef = pyRef.withConverter(converter);
    expect(typedRef.toJSON()).toEqual(pyJson);

    const hydratedTyped = DocumentReference.fromJSON(db, pyJson, converter);
    expect(refEqual(hydratedTyped, typedRef)).toBe(true);
    await setDoc(hydratedTyped, { handle: 'alice' });
    const snap = await getDoc(hydratedTyped);
    expect(snap.data()).toEqual({ handle: '@alice' });
    expect(snap.ref.toJSON?.()).toEqual(pyJson);

    // Snapshot ref on an untyped read also exposes .toJSON()
    const untypedSnap = await getDoc(doc(collection(db, 'orgs/acme/members'), 'alice'));
    expect(untypedSnap.ref.toJSON?.()).toEqual(pyJson);
  });

  it('rejects invalid DocumentReference.fromJSON inputs with FirebaseError(invalid-argument) matching firebase/firestore@12.19.0', () => {
    const upApp = upstreamApp.initializeApp({ projectId: 'ref-json-err', apiKey: 'fake' }, 'up-ref-err');
    const upDb = upstreamFs.getFirestore(upApp);
    const db = getFirestore(initializeSandbox());

    const invalidPayloads: readonly unknown[] = [
      null,
      'users/alice',
      {},
      { type: 'firestore/documentReference/1.0' },
      { type: 'wrong/type/1.0', referencePath: 'users/alice' },
      { type: 'firestore/documentReference/1.0', referencePath: 42 },
      { type: 'firestore/documentReference/1.0', referencePath: 'users//alice' },
    ];

    for (const badPayload of invalidPayloads) {
      let upErr: unknown;
      let pyErr: unknown;
      try {
        upstreamFs.DocumentReference.fromJSON(upDb, badPayload as object);
      } catch (error) {
        upErr = error;
      }
      try {
        DocumentReference.fromJSON(db, badPayload as object);
      } catch (error) {
        pyErr = error;
      }
      expect(upErr).toBeInstanceOf(upstreamApp.FirebaseError);
      expect(pyErr).toBeInstanceOf(FirebaseError);
      expect(pyErr).not.toBeInstanceOf(FirestoreError);
      expect((pyErr as FirebaseError).code).toBe('invalid-argument');
    }
  });
});
