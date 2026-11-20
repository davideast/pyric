import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { seedDocuments, setRules } from 'pyric/sandbox/firestore';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  onSnapshot,
  query,
  where,
  type QuerySnapshot,
} from '../../src/firestore/index.js';

const VISIBILITY_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /articles/{id} {
      allow get: if resource.data.visibility == 'public';
      allow list: if resource.data.visibility == 'public';
    }
  }
}`;

describe('warmed client cache initial onSnapshot delivery before backend permission-denied', () => {
  it('delivers warmed cached query docs on initial unprovable onSnapshot and stops cleanly when unsubscribed in next', async () => {
    const sandbox = initializeSandbox({ projectId: 'demo-warm-cache' });
    setRules(sandbox, VISIBILITY_RULES);
    seedDocuments(sandbox, {
      'articles/pub1': { visibility: 'public', title: 'One' },
      'articles/pub2': { visibility: 'public', title: 'Two' },
      'articles/priv1': { visibility: 'private', title: 'Hidden' },
    });

    const db = getFirestore(sandbox.withAuth({ uid: 'reader' }));
    await getDocs(query(collection(db, 'articles'), where('visibility', '==', 'public')));

    let errorFired = false;
    const initialSnap = await new Promise<{ ids: string[]; fromCache: boolean }>((resolve, reject) => {
      let unsub: () => void = () => {};
      unsub = onSnapshot(
        collection(db, 'articles'),
        (rawSnap) => {
          unsub();
          const snap = rawSnap as QuerySnapshot;
          resolve({
            ids: snap.docs.map((d) => d.id).sort(),
            fromCache: snap.metadata.fromCache,
          });
        },
        (err) => {
          errorFired = true;
          reject(err);
        },
      );
    });

    expect(initialSnap).toEqual({ ids: ['pub1', 'pub2'], fromCache: true });
    expect(errorFired).toBe(false);
    sandbox.dispose();
  });

  it('delivers fromCache snapshot followed by permission-denied when caller stays subscribed, and skips empty unwarmed cache', async () => {
    const sandbox = initializeSandbox({ projectId: 'demo-warm-cache-2' });
    setRules(sandbox, VISIBILITY_RULES);
    seedDocuments(sandbox, {
      'articles/pub1': { visibility: 'public', title: 'One' },
      'articles/priv1': { visibility: 'private', title: 'Hidden' },
    });

    const coldDb = getFirestore(sandbox.withAuth({ uid: 'cold_reader' }));
    const coldEvents: string[] = [];
    await new Promise<void>((resolve) => {
      onSnapshot(
        collection(coldDb, 'articles'),
        () => {
          coldEvents.push('next');
        },
        (err) => {
          coldEvents.push(`error:${(err as { code?: string }).code ?? 'unknown'}`);
          resolve();
        },
      );
    });
    expect(coldEvents).toEqual(['error:permission-denied']);

    const warmDb = getFirestore(sandbox.withAuth({ uid: 'warm_reader' }));
    await getDoc(doc(warmDb, 'articles/pub1'));
    const warmEvents: string[] = [];
    await new Promise<void>((resolve) => {
      onSnapshot(
        collection(warmDb, 'articles'),
        (rawSnap) => {
          const snap = rawSnap as QuerySnapshot;
          warmEvents.push(`next:${snap.docs.map((d) => d.id).join(',')}:cache=${String(snap.metadata.fromCache)}`);
        },
        (err) => {
          warmEvents.push(`error:${(err as { code?: string }).code ?? 'unknown'}`);
          resolve();
        },
      );
    });
    expect(warmEvents).toEqual(['next:pub1:cache=true', 'error:permission-denied']);
    sandbox.dispose();
  });
});
