import { describe, expect, it } from 'bun:test';
import { FirebaseError } from 'pyric/app';
import { FieldValue, vector } from 'pyric/firestore';
import { setRules } from 'pyric/sandbox/firestore';
import { connectFirestoreEmulator } from '../../../../src/serve/worker/client/firestore-emulator.js';
import {
  ensureFirestoreConfigured,
  executeWrite,
  terminate,
} from '../../../../src/serve/worker/client/firestore-lifecycle.js';
import { getDoc } from '../../../../src/serve/worker/client/firestore-reads.js';
import {
  arrayRemove,
  arrayUnion,
  deleteField,
  doc,
  increment,
  serverTimestamp,
} from '../../../../src/serve/worker/client/firestore-refs.js';
import { setDoc, updateDoc } from '../../../../src/serve/worker/client/firestore-writes.js';
import { connectClientToHost, makeHostCtx } from '../integration-support.js';
import { restoreSharedWorker } from '../oracle-captures/support.ts';

restoreSharedWorker();

const OPEN_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} { allow read, write: if true; }
  }
}`;

describe('worker client FieldValue sentinels and ensureFirestoreConfigured/executeWrite', () => {
  it('constructs FieldValue instances with structural isEqual and round-trips writes over the port', async () => {
    expect(deleteField() instanceof FieldValue).toBe(true);
    expect(serverTimestamp() instanceof FieldValue).toBe(true);
    expect(increment(4) instanceof FieldValue).toBe(true);
    expect(arrayUnion('alpha') instanceof FieldValue).toBe(true);
    expect(arrayRemove('alpha') instanceof FieldValue).toBe(true);
    expect(vector([1, 2]) instanceof FieldValue).toBe(false);

    expect(deleteField().isEqual(deleteField())).toBe(true);
    expect(deleteField().isEqual(serverTimestamp())).toBe(false);
    expect(increment(4).isEqual(increment(4))).toBe(true);
    expect(increment(Number.NaN).isEqual(increment(Number.NaN))).toBe(true);
    expect(increment(4).isEqual(increment(5))).toBe(false);
    expect(arrayUnion('alpha', 1).isEqual(arrayUnion('alpha', 1))).toBe(true);
    expect(arrayUnion('alpha', 1).isEqual(arrayUnion(1, 'alpha'))).toBe(false);
    expect(arrayUnion('alpha').isEqual(arrayRemove('alpha'))).toBe(false);

    const host = await makeHostCtx();
    setRules(host.sandbox, OPEN_RULES);
    try {
      const { db } = connectClientToHost(host, 'worker://fv-roundtrip');
      const ref = doc(db, 'items/doc-1');
      await setDoc(ref, {
        count: 10,
        tags: ['alpha', 'beta'],
        obsolete: 'temp',
      });
      await updateDoc(ref, {
        count: increment(5),
        tags: arrayRemove('beta'),
        obsolete: deleteField(),
      });
      await updateDoc(ref, {
        tags: arrayUnion('gamma'),
      });
      expect(() => updateDoc(ref, { tags: arrayUnion(undefined) })).toThrow(FirebaseError);
      const snap = await getDoc(ref);
      expect(snap.data()).toEqual({
        count: 15,
        tags: ['alpha', 'gamma'],
      });
    } finally {
      host.sandbox.dispose();
    }
  });

  it('enforces ensureFirestoreConfigured and executeWrite lifecycle preconditions synchronously', async () => {
    const host = await makeHostCtx();
    setRules(host.sandbox, OPEN_RULES);
    try {
      const cfgClient = connectClientToHost(host, 'worker://plumbing-cfg').db;
      const clientObj = ensureFirestoreConfigured(cfgClient);
      expect(typeof clientObj).toBe('object');
      expect(clientObj).not.toBeNull();
      expect(() => connectFirestoreEmulator(cfgClient, '127.0.0.1', 8080)).toThrow(FirebaseError);

      const execClient = connectClientToHost(host, 'worker://plumbing-exec').db;
      await expect(executeWrite(execClient, [])).resolves.toBeUndefined();
      expect(() => connectFirestoreEmulator(execClient, '127.0.0.1', 8080)).toThrow(FirebaseError);

      await terminate(execClient);
      expect(() => ensureFirestoreConfigured(execClient)).toThrow(FirebaseError);
      let syncThrew = false;
      try {
        void executeWrite(execClient, []);
      } catch (err) {
        syncThrew = err instanceof FirebaseError && err.code === 'failed-precondition';
      }
      expect(syncThrew).toBe(true);
    } finally {
      host.sandbox.dispose();
    }
  });
});
