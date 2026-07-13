import { describe, it, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { setRules } from 'pyric/sandbox/firestore';
import {
  getFirestore,
  collection,
  doc,
  setDoc,
  query,
  where,
  type Query,
} from 'pyric/firestore';
import { useFirestoreCollection } from '../../../src/firestore/hooks/useFirestoreCollection.js';
import { renderHook, waitFor, act } from '../../helpers/render-hook.js';

const OPEN_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /{document=**} { allow read, write: if true; }
  }
}`;

function makeFirestore() {
  const sandbox = initializeSandbox();
  const firestore = getFirestore(sandbox.withAuth({ uid: 'alice' }));
  setRules(sandbox, OPEN_RULES);
  return firestore;
}

// Skipped for the same underlying-bug reason as useFirestoreDoc —
// repeated `initializeSandbox + setRules + setDoc` cycles fail with
// `Failed to parse rules source` on the second cycle. See the
// matching comment in `useFirestoreDoc.test.tsx`.
describe.skip('useFirestoreCollection', () => {
  it('emits all docs in a collection', async () => {
    const firestore = makeFirestore();
    await setDoc(doc(firestore, 'users/alice'), { name: 'Alice', score: 1 });
    await setDoc(doc(firestore, 'users/bob'), { name: 'Bob', score: 2 });
    const usersRef = collection(firestore, 'users');

    const { result } = renderHook(
      (p: { q: Query | null }) => useFirestoreCollection(p.q),
      { q: usersRef },
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    const docs = result.current.data?.docs ?? [];
    expect(docs.length).toBe(2);
    const names = docs.map((d) => d.data().name).sort();
    expect(names).toEqual(['Alice', 'Bob']);
  });

  it('emits an empty snapshot for an empty collection', async () => {
    const firestore = makeFirestore();
    const emptyRef = collection(firestore, 'empty');

    const { result } = renderHook(
      (p: { q: Query | null }) => useFirestoreCollection(p.q),
      { q: emptyRef },
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.data?.empty).toBe(true);
    expect(result.current.data?.docs).toEqual([]);
  });

  it('updates when a doc is added to the collection', async () => {
    const firestore = makeFirestore();
    await setDoc(doc(firestore, 'users/alice'), { name: 'Alice' });
    const usersRef = collection(firestore, 'users');

    const { result } = renderHook(
      (p: { q: Query | null }) => useFirestoreCollection(p.q),
      { q: usersRef },
    );
    await waitFor(() => expect(result.current.data?.docs.length).toBe(1));

    await act(async () => {
      await setDoc(doc(firestore, 'users/bob'), { name: 'Bob' });
    });

    await waitFor(() => expect(result.current.data?.docs.length).toBe(2));
  });

  it('respects a query() with where()', async () => {
    const firestore = makeFirestore();
    await setDoc(doc(firestore, 'users/alice'), { name: 'Alice', active: true });
    await setDoc(doc(firestore, 'users/bob'), { name: 'Bob', active: false });
    await setDoc(doc(firestore, 'users/carol'), { name: 'Carol', active: true });

    const q = query(collection(firestore, 'users'), where('active', '==', true));

    const { result } = renderHook(
      (p: { q: Query | null }) => useFirestoreCollection(p.q),
      { q },
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    const names = (result.current.data?.docs ?? [])
      .map((d) => d.data().name as string)
      .sort();
    expect(names).toEqual(['Alice', 'Carol']);
  });

  it('short-circuits to idle state when query is null', () => {
    const { result } = renderHook(
      (p: { q: Query | null }) => useFirestoreCollection(p.q),
      { q: null },
    );
    expect(result.current).toEqual({
      data: undefined,
      error: undefined,
      isLoading: false,
    });
  });

  it('unsubscribes on unmount', async () => {
    const firestore = makeFirestore();
    await setDoc(doc(firestore, 'users/alice'), { name: 'Alice' });
    const usersRef = collection(firestore, 'users');

    const { unmount } = renderHook(
      (p: { q: Query | null }) => useFirestoreCollection(p.q),
      { q: usersRef },
    );
    unmount();

    await setDoc(doc(firestore, 'users/bob'), { name: 'Bob' });
  });
});
