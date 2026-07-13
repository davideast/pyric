/**
 * Web-SDK conformance: an `onSnapshot` listener whose caller supplied NO error
 * callback must NOT fail silently when it is denied. The Firebase Web SDK logs
 * an uncaught listener error to the console; pyric used to swallow it, so a
 * denied listener (a rules change, or a sign-out that revokes read access) left
 * the last snapshot frozen on screen with zero signal. This pins the fix:
 * `defaultSnapshotErrorHandler` surfaces the error via `console.error`.
 */
import { describe, it, expect, spyOn } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { setRules } from 'pyric/sandbox/firestore';
import {
  getFirestore,
  doc,
  setDoc,
  onSnapshot,
  query,
  where,
  collection,
  type Firestore,
  type QuerySnapshot,
} from '../../src/firestore/index.js';

const OWNER_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /notes/{id} {
      allow read:   if request.auth != null && resource.data.owner == request.auth.uid;
      allow create: if request.auth != null && request.resource.data.owner == request.auth.uid;
    }
  }
}`;

const tick = (ms = 10): Promise<void> => new Promise((r) => setTimeout(r, ms));

function setup(): { sandbox: ReturnType<typeof initializeSandbox>; live: Firestore } {
  const sandbox = initializeSandbox();
  const live = getFirestore(sandbox);
  setRules(sandbox, OWNER_RULES);
  return { sandbox, live };
}

describe('onSnapshot unobserved error (Web-SDK conformance)', () => {
  it('console.errors a denied listener when no error callback is supplied', async () => {
    const { sandbox, live } = setup();
    sandbox.currentUser = { uid: 'alice' };
    await setDoc(doc(live, 'notes/n1'), { text: 'alice secret', owner: 'alice' });

    const seen: number[] = [];
    const q = query(collection(live, 'notes'), where('owner', '==', 'alice'));
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      // No error callback — the exact shape the test apps use.
      const unsub = onSnapshot(q, (snap: QuerySnapshot) => seen.push(snap.size));
      await tick();
      expect(seen.at(-1)).toBe(1); // alice sees her note

      sandbox.currentUser = null; // bare sign-out revokes read access
      await tick();

      // The denial must surface — not vanish.
      expect(errorSpy).toHaveBeenCalled();
      const surfaced = errorSpy.mock.calls
        .flat()
        .some((a) => typeof a === 'string' && a.includes('snapshot listener'));
      expect(surfaced).toBe(true);
      unsub();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('does NOT call the default handler when the caller supplied an error callback', async () => {
    const { sandbox, live } = setup();
    sandbox.currentUser = { uid: 'alice' };
    await setDoc(doc(live, 'notes/n1'), { text: 'alice secret', owner: 'alice' });

    const q = query(collection(live, 'notes'), where('owner', '==', 'alice'));
    let errCode: string | undefined;
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const unsub = onSnapshot(
        q,
        () => {},
        (e: unknown) => {
          errCode = (e as { code?: string }).code;
        },
      );
      await tick();
      sandbox.currentUser = null;
      await tick();

      // The caller's handler ran; our default did NOT log.
      expect(errCode).toBe('permission-denied');
      const surfaced = errorSpy.mock.calls
        .flat()
        .some((a) => typeof a === 'string' && a.includes('snapshot listener'));
      expect(surfaced).toBe(false);
      unsub();
    } finally {
      errorSpy.mockRestore();
    }
  });
});
