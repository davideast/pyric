/** `useDocumentList.createDocument` — create-vs-overwrite semantics (the
 *  JSON-import "skip existing" guarantee lives here, not in any loaded page). */
import { describe, it, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  getFirestore,
  collection,
  doc,
  getDoc,
  setDoc,
  sandbox as sandboxOps,
} from 'pyric/firestore';
import { useDocumentList } from '../../../src/firestore/hooks/useDocumentList.js';
import { act, renderHook, waitFor } from '../../helpers/render-hook.js';

const OPEN_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /{document=**} { allow read, write: if true; }
  }
}`;

function makeFirestore() {
  const sandbox = initializeSandbox();
  const firestore = getFirestore(sandbox.withAuth({ uid: 'alice' }));
  sandboxOps.setRules(firestore, OPEN_RULES);
  return firestore;
}

describe('useDocumentList.createDocument — onExisting semantics', () => {
  it("default ('overwrite') keeps the historical setDoc behavior", async () => {
    const firestore = makeFirestore();
    await setDoc(doc(firestore, 'users/alice'), { v: 1 });
    const usersRef = collection(firestore, 'users');
    const { result } = renderHook(() => useDocumentList({ collection: usersRef }));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await result.current.createDocument('alice', { v: 2 });
    const snap = await getDoc(doc(firestore, 'users/alice'));
    expect(snap.data()).toEqual({ v: 2 });
  });

  it("onExisting: 'fail' rejects already-exists WITHOUT writing — even for a doc beyond the loaded page", async () => {
    const firestore = makeFirestore();
    // pageSize 1 so 'bob' is NOT in the loaded page — the probe must still see it.
    await setDoc(doc(firestore, 'users/alice'), { v: 1 });
    await setDoc(doc(firestore, 'users/bob'), { v: 1 });
    const usersRef = collection(firestore, 'users');
    const { result } = renderHook(() => useDocumentList({ collection: usersRef, pageSize: 1 }));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.documents.length).toBe(1);

    await expect(
      result.current.createDocument('bob', { v: 99 }, { onExisting: 'fail' }),
    ).rejects.toMatchObject({ code: 'already-exists' });
    const snap = await getDoc(doc(firestore, 'users/bob'));
    expect(snap.data()).toEqual({ v: 1 }); // untouched

    // A genuinely new id still writes under 'fail'.
    await result.current.createDocument('carol', { v: 3 }, { onExisting: 'fail' });
    expect((await getDoc(doc(firestore, 'users/carol'))).data()).toEqual({ v: 3 });
  });
});

describe('useDocumentList live mode', () => {
  it('delivers external document updates without a manual refresh', async () => {
    const firestore = makeFirestore();
    await setDoc(doc(firestore, 'scores/alice'), { score: 1 });
    const scoresRef = collection(firestore, 'scores');
    const { result } = renderHook(() =>
      useDocumentList({ collection: scoresRef, mode: 'live' }),
    );
    await waitFor(() => expect(result.current.documents[0]?.data()).toEqual({ score: 1 }));

    await act(async () => {
      await setDoc(doc(firestore, 'scores/alice'), { score: 2 });
    });

    await waitFor(() => expect(result.current.documents[0]?.data()).toEqual({ score: 2 }));
  });

  it('starts a new comparison baseline when load-more re-subscribes', async () => {
    const firestore = makeFirestore();
    await setDoc(doc(firestore, 'scores/alice'), { score: 1 });
    await setDoc(doc(firestore, 'scores/bob'), { score: 2 });
    const scoresRef = collection(firestore, 'scores');
    const { result } = renderHook(() =>
      useDocumentList({ collection: scoresRef, mode: 'live', pageSize: 1 }),
    );
    await waitFor(() => expect(result.current.documents.length).toBe(1));
    const initialGeneration = result.current.subscriptionGeneration;

    act(() => result.current.loadMore());

    await waitFor(() => expect(result.current.documents.length).toBe(2));
    expect(result.current.subscriptionGeneration).toBeGreaterThan(initialGeneration);
  });
});
