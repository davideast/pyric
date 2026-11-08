/**
 * `pyric/firestore` — `terminate` honest teardown-forward.
 *
 * Before this change, `terminate` was not exported from
 * `pyric/firestore` at all — importing it from an app bundled under
 * pyric would fail at import time, crashing before the app ever ran a
 * read or write. Unlike the persistence/network family, this is NOT a
 * pure no-op: on a sandbox handle it genuinely calls `Sandbox.dispose()`,
 * which tears down listener registries on the sandbox's environment.
 */
import { describe, it, expect, mock } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { setRules } from 'pyric/sandbox/firestore';
import { getInternalEnv } from 'pyric/sandbox/internal';
import { getFirestore, doc, collection, getDoc, getDocs, getDocFromServer, getDocsFromServer, onSnapshot, setDoc } from '../../src/firestore/index.js';
import { terminate } from '../../src/firestore/index.js';

const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /notes/{id} {
      allow read, write: if request.auth != null;
    }
  }
}`;

function setup() {
  const sandbox = initializeSandbox();
  const db = getFirestore(sandbox.withAuth({ uid: 'alice' }));
  setRules(sandbox, RULES);
  return { sandbox, db };
}

describe('terminate', () => {
  it('resolves without throwing on a sandbox handle', async () => {
    const { sandbox, db } = setup();
    try {
      await expect(terminate(db)).resolves.toBeUndefined();
    } finally {
      getInternalEnv(sandbox).dispose();
    }
  });

  it('terminates only this Firestore handle and leaves its sibling usable', async () => {
    const { sandbox, db } = setup();
    try {
      const sibling = getFirestore(sandbox.withAuth({ uid: 'alice' }));
      const disposeSpy = mock(sandbox.dispose.bind(sandbox));
      sandbox.dispose = disposeSpy;
      const terminatedRef = doc(db, 'notes/n1');
      await setDoc(terminatedRef, { text: 'before' });

      const terminatedQuery = collection(db, 'notes');
      await terminate(db);

      expect(disposeSpy).not.toHaveBeenCalled();
      for (const read of [
        () => getDoc(terminatedRef),
        () => getDocs(terminatedQuery),
        () => getDocFromServer(terminatedRef),
        () => getDocsFromServer(terminatedQuery),
      ]) {
        await expect(read()).rejects.toMatchObject({ code: 'failed-precondition' });
      }
      await setDoc(doc(sibling, 'notes/n1'), { text: 'after' });
      expect((await getDoc(doc(sibling, 'notes/n1'))).data()).toEqual({ text: 'after' });
    } finally {
      getInternalEnv(sandbox).dispose();
    }
  });

  it('is idempotent — calling it twice does not throw', async () => {
    const { sandbox, db } = setup();
    try {
      await terminate(db);
      await expect(terminate(db)).resolves.toBeUndefined();
    } finally {
      getInternalEnv(sandbox).dispose();
    }
  });

  it('does not fire aborted on listeners already cancelled with permission-denied', async () => {
    const sandbox = initializeSandbox();
    try {
      setRules(sandbox, RULES);
      const db = getFirestore(sandbox.withAuth({ uid: 'user-1' }));
      await setDoc(doc(db, 'notes/n1'), { text: 'visible' });

      const callbackErrors: string[] = [];
      const observerErrors: string[] = [];

      // 1. Listener that initially succeeds and is then revoked by a rules tighten
      onSnapshot(
        doc(db, 'notes/n1'),
        { includeMetadataChanges: true },
        () => {},
        (err) => callbackErrors.push((err as { code?: string }).code ?? 'unknown'),
      );
      await new Promise<void>((resolve) => queueMicrotask(resolve));

      setRules(
        sandbox,
        `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /notes/{id} {
      allow read, write: if false;
    }
  }
}`,
      );
      await new Promise<void>((resolve) => queueMicrotask(resolve));

      // 2. Observer listener that errors immediately with permission-denied on attach
      onSnapshot(doc(db, 'notes/n1'), {
        next: () => {},
        error: (err) => observerErrors.push((err as { code?: string }).code ?? 'unknown'),
      });
      await new Promise<void>((resolve) => queueMicrotask(resolve));

      expect(callbackErrors).toEqual(['permission-denied']);
      expect(observerErrors).toEqual(['permission-denied']);

      await terminate(db);

      expect(callbackErrors).toEqual(['permission-denied']);
      expect(observerErrors).toEqual(['permission-denied']);
    } finally {
      getInternalEnv(sandbox).dispose();
    }
  });
});
