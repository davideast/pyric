import { describe, expect, it } from 'bun:test';
import { setRules } from 'pyric/sandbox/firestore';
import { clearIndexedDbPersistence } from '../../../../src/serve/worker/client/firestore-bundles-ssr.js';
import {
  enableIndexedDbPersistence,
  enableMultiTabIndexedDbPersistence,
  terminate,
} from '../../../../src/serve/worker/client/firestore-lifecycle.js';
import { getDoc, getDocs, onSnapshot, onSnapshotsInSync } from '../../../../src/serve/worker/client/firestore-reads.js';
import { collection, doc } from '../../../../src/serve/worker/client/firestore-refs.js';
import { setDoc } from '../../../../src/serve/worker/client/firestore-writes.js';
import * as client from '../../../../src/serve/worker/index.js';
import { connectClientToHost, makeHostCtx } from '../integration-support.js';
import { restoreSharedWorker } from '../oracle-captures/support.ts';

restoreSharedWorker();

const OPEN_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} { allow read, write: if true; }
  }
}`;

describe('worker client firestore-lifecycle', () => {
  it('accepts persistence before first use, permits multi-tab across clients, and rejects after first use or repeat init', async () => {
    const host = await makeHostCtx();
    setRules(host.sandbox, OPEN_RULES);
    try {
      const freshSingle = connectClientToHost(host, 'worker://lc-single').db;
      await expect(enableIndexedDbPersistence(freshSingle)).resolves.toBeUndefined();
      await expect(enableIndexedDbPersistence(freshSingle)).rejects.toMatchObject({
        code: 'failed-precondition',
      });

      const startedSingle = connectClientToHost(host, 'worker://lc-started-single').db;
      await getDoc(doc(startedSingle, 'items/item-1'));
      await expect(enableIndexedDbPersistence(startedSingle)).rejects.toMatchObject({
        code: 'failed-precondition',
      });

      const startedMulti = connectClientToHost(host, 'worker://lc-started-multi').db;
      await getDoc(doc(startedMulti, 'items/item-2'));
      await expect(enableMultiTabIndexedDbPersistence(startedMulti)).rejects.toMatchObject({
        code: 'failed-precondition',
      });

      const multiA = connectClientToHost(host, 'worker://lc-multi-a').db;
      const multiB = connectClientToHost(host, 'worker://lc-multi-b').db;
      await expect(enableMultiTabIndexedDbPersistence(multiA)).resolves.toBeUndefined();
      await expect(enableMultiTabIndexedDbPersistence(multiB)).resolves.toBeUndefined();
    } finally {
      host.sandbox.dispose();
    }
  });

  it('terminates only the targeted Firestore handle, stops owned listeners quietly, and keeps Auth and sibling Firestore alive', async () => {
    const host = await makeHostCtx();
    setRules(host.sandbox, OPEN_RULES);
    try {
      const primary = connectClientToHost(host, 'worker://lc-term-primary').db;
      const sibling = connectClientToHost(host, 'worker://lc-term-sibling').db;

      const heldDoc = doc(primary, 'items/item-1');
      const heldColl = collection(primary, 'items');
      await setDoc(heldDoc, { stage: 'before' });

      const delivered: Array<string | undefined> = [];
      const listenerErrors: unknown[] = [];
      let syncCount = 0;
      onSnapshot(
        heldDoc,
        (snap) => {
          delivered.push((snap.data() as { stage?: string } | undefined)?.stage);
        },
        (err) => {
          listenerErrors.push(err);
        },
      );
      onSnapshotsInSync(primary, () => {
        syncCount += 1;
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      const deliveredBeforeTerminate = delivered.length;
      const syncBeforeTerminate = syncCount;

      await expect(terminate(primary)).resolves.toBeUndefined();
      await expect(terminate(primary)).resolves.toBeUndefined();

      await expect(getDoc(heldDoc)).rejects.toMatchObject({ code: 'failed-precondition' });
      await expect(getDocs(heldColl)).rejects.toMatchObject({ code: 'failed-precondition' });
      await expect(setDoc(heldDoc, { stage: 'blocked' })).rejects.toMatchObject({ code: 'failed-precondition' });
      expect(() => doc(primary, 'items/item-2')).toThrow();
      await expect(clearIndexedDbPersistence(primary)).resolves.toBeUndefined();

      // Auth on the SAME shared port continues to work after Firestore terminate.
      const auth = client.getAuth(primary);
      const cred = await client.signInAnonymously(auth);
      expect(typeof cred.user.uid).toBe('string');

      // Sibling Firestore client continues to read/write without triggering terminated listeners.
      const siblingDoc = doc(sibling, 'items/item-1');
      await setDoc(siblingDoc, { stage: 'sibling' });
      await new Promise((resolve) => setTimeout(resolve, 25));

      expect((await getDoc(siblingDoc)).data()).toEqual({ stage: 'sibling' });
      expect(delivered.length).toBe(deliveredBeforeTerminate);
      expect(syncCount).toBe(syncBeforeTerminate);
      expect(listenerErrors).toEqual([]);
    } finally {
      host.sandbox.dispose();
    }
  });
});
