/**
 * Pyric Studio event-unification keystone (track T1) — cross-service emit.
 *
 * T1's contract: Auth, Storage, and RTDB must land their write activity on
 * the SAME unified `sandbox.onEvent` / `sandbox.history()` stream Firestore
 * already feeds, each as a provenance-stamped `service_mutation` event whose
 * `service` field attributes the activity. These tests assert that an auth
 * user-create, a storage put, and an RTDB write each surface there with the
 * right `service`, and that Firestore's own stream is untouched (no
 * `service_mutation` events, still its own `request`/`write` kinds).
 *
 * See the design rationale and `src/sandbox/types/events.ts` (ServiceMutationEvent).
 */
import 'fake-indexeddb/auto';
import { describe, it, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { getInternalEnv } from 'pyric/sandbox/internal';
import type {
  SandboxCommitEvent,
  SandboxEvent,
  SandboxListenerEvent,
  SandboxOperationEvent,
  ServiceMutationEvent,
} from 'pyric/sandbox';

const FIRESTORE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /notes/{id} {
      allow read, write: if request.auth.uid == 'alice';
    }
  }
}`;

const STORAGE_RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} {
      allow read, write: if true;
    }
  }
}`;

import {
  getAuth,
  signInAnonymously,
  signOut,
  createUserWithEmailAndPassword,
  sandbox as authSandbox,
} from '../../src/auth/index.js';
import { getStorageSandbox, ref as storageRef, uploadBytes, deleteObject, updateMetadata } from '../../src/storage/index.js';
import {
  getAdminDatabase,
  getDatabase,
  onValue,
  ref as dbRef,
  sandbox as rtdbSandbox,
  set,
  update,
  remove,
  runTransaction,
} from '../../src/database/index.js';

let dbSeq = 0;
function uniqueDbName(label: string): string {
  return `pyric-svc-events-${label}-${dbSeq++}`;
}

function mutations(events: SandboxEvent[]): ServiceMutationEvent[] {
  return events.filter(
    (e): e is ServiceMutationEvent & typeof e => e.kind === 'service_mutation',
  );
}

function operations(events: SandboxEvent[]): SandboxOperationEvent[] {
  return events.filter((e): e is SandboxOperationEvent & typeof e => e.kind === 'operation');
}

function commits(events: SandboxEvent[]): SandboxCommitEvent[] {
  return events.filter((e): e is SandboxCommitEvent & typeof e => e.kind === 'commit');
}

function listeners(events: SandboxEvent[]): SandboxListenerEvent[] {
  return events.filter((e): e is SandboxListenerEvent & typeof e => e.kind === 'listener');
}

function provenanceOK(
  e: ServiceMutationEvent,
  authLens: NonNullable<ServiceMutationEvent['authLens']> = { mode: 'app-session' },
): void {
  // Every emit funnels through stampProvenance, so the defaults are present.
  expect(e.actor).toEqual({ kind: 'unattributed' });
  expect(e.authLens).toEqual(authLens);
}

describe('Studio T1 — Auth emits service_mutation events', () => {
  it('signInAnonymously emits a user_create + sign_in on the unified stream', async () => {
    const sandbox = initializeSandbox();
    const events: SandboxEvent[] = [];
    sandbox.onEvent((e) => events.push(e));

    const auth = getAuth(sandbox);
    const cred = await signInAnonymously(auth);

    const authEvents = mutations(events).filter((e) => e.service === 'auth');
    const create = authEvents.find((e) => e.op === 'user_create');
    const signIn = authEvents.find((e) => e.op === 'sign_in');

    expect(create).toBeDefined();
    expect(create!.path).toBe(cred.user.uid);
    expect(create!.service).toBe('auth');
    provenanceOK(create!);

    expect(signIn).toBeDefined();
    expect(signIn!.path).toBe(cred.user.uid);
    expect((signIn!.auth as { uid: string }).uid).toBe(cred.user.uid);
  });

  it('admin createUser / updateUser / deleteUser each emit with auth: null', () => {
    const sandbox = initializeSandbox();
    const events: SandboxEvent[] = [];
    sandbox.onEvent((e) => events.push(e));
    const auth = getAuth(sandbox);

    authSandbox.createUser(auth, { uid: 'u1', email: 'u1@example.com' });
    authSandbox.updateUser(auth, 'u1', { displayName: 'One' });
    authSandbox.deleteUser(auth, 'u1');

    const ops = mutations(events)
      .filter((e) => e.service === 'auth' && e.path === 'u1')
      .map((e) => e.op);
    expect(ops).toEqual(['user_create', 'user_update', 'user_delete']);

    const update_ = mutations(events).find((e) => e.op === 'user_update');
    expect(update_!.auth).toBeNull();
    // Update carries a before/after diff.
    expect(update_!.before).toBeDefined();
    expect((update_!.after as { displayName: string }).displayName).toBe('One');
  });

  it('createUserWithEmailAndPassword emits a user_create', async () => {
    const sandbox = initializeSandbox();
    const events: SandboxEvent[] = [];
    sandbox.onEvent((e) => events.push(e));
    const auth = getAuth(sandbox);

    await createUserWithEmailAndPassword(auth, 'new@example.com', 'sekret1');

    const create = mutations(events).find(
      (e) => e.service === 'auth' && e.op === 'user_create',
    );
    expect(create).toBeDefined();
    expect((create!.after as { email: string }).email).toBe('new@example.com');
  });

  it('signOut emits a sign_out, recoverable from history()', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    await signInAnonymously(auth);
    await signOut(auth);

    const signOuts = mutations(sandbox.history()).filter(
      (e) => e.service === 'auth' && e.op === 'sign_out',
    );
    expect(signOuts.length).toBe(1);
    // No `after` — the session is gone.
    expect(signOuts[0]!.after).toBeUndefined();
  });
});

describe('Studio T1 — Storage emits service_mutation events', () => {
  it('uploadBytes emits an object_put with size/contentType detail', async () => {
    const sandbox = initializeSandbox();
    const events: SandboxEvent[] = [];
    sandbox.onEvent((e) => events.push(e));

    const storage = getStorageSandbox(sandbox.withAuth({ uid: 'alice' }), {
      dbName: uniqueDbName('put'),
      rules: STORAGE_RULES,
    });
    await uploadBytes(storageRef(storage, 'avatars/alice.png'), new Blob(['xyz']), {
      contentType: 'image/png',
    });

    const put = mutations(events).find(
      (e) => e.service === 'storage' && e.op === 'object_put',
    );
    expect(put).toBeDefined();
    expect(put!.path).toBe('avatars/alice.png');
    expect((put!.auth as { uid: string }).uid).toBe('alice');
    expect(put!.detail?.contentType).toBe('image/png');
    expect(put!.detail?.overwrite).toBe(false);
    provenanceOK(put!, { mode: 'as', uid: 'alice' });
  });

  it('deleteObject and updateMetadata emit object_delete / metadata_update', async () => {
    const sandbox = initializeSandbox();
    const events: SandboxEvent[] = [];
    const storage = getStorageSandbox(sandbox.withAuth(null), {
      dbName: uniqueDbName('del'),
      rules: STORAGE_RULES,
    });
    const r = storageRef(storage, 'docs/note.txt');
    await uploadBytes(r, new Blob(['hello']));
    await updateMetadata(r, { contentType: 'text/markdown' });
    await deleteObject(r);

    // Subscribe-after-the-fact: history() must carry all three.
    const ops = mutations(sandbox.history())
      .filter((e) => e.service === 'storage' && e.path === 'docs/note.txt')
      .map((e) => e.op);
    expect(ops).toEqual(['object_put', 'metadata_update', 'object_delete']);
    void events;
  });
});

describe('Studio T1 — RTDB emits service_mutation events', () => {
  it('set / update / remove each emit on the unified stream', async () => {
    const sandbox = initializeSandbox();
    const events: SandboxEvent[] = [];
    sandbox.onEvent((e) => events.push(e));

    const db = getDatabase(sandbox.withAuth({ uid: 'alice' }));
    rtdbSandbox.setDefaultPolicy(db, 'allow');
    await set(dbRef(db, 'rooms/r1'), { name: 'lobby' });
    await update(dbRef(db, 'rooms/r1'), { topic: 'hi' });
    await remove(dbRef(db, 'rooms/r1'));

    const rtdb = mutations(events).filter((e) => e.service === 'rtdb');
    const setEv = rtdb.find((e) => e.op === 'set');
    const updEv = rtdb.find((e) => e.op === 'update');
    const remEv = rtdb.find((e) => e.op === 'remove');

    expect(setEv).toBeDefined();
    expect(setEv!.path).toBe('/rooms/r1');
    expect((setEv!.auth as { uid: string }).uid).toBe('alice');
    expect((setEv!.after as { name: string }).name).toBe('lobby');
    provenanceOK(setEv!);

    expect(updEv).toBeDefined();
    expect(updEv!.path).toBe('/rooms/r1');

    expect(remEv).toBeDefined();
    expect(remEv!.path).toBe('/rooms/r1');
    expect(remEv!.after).toBeNull();
  });

  it('set(ref, null) is labelled remove, not set', async () => {
    const sandbox = initializeSandbox();
    const events: SandboxEvent[] = [];
    sandbox.onEvent((e) => events.push(e));

    const db = getDatabase(sandbox.withAuth(null));
    rtdbSandbox.setDefaultPolicy(db, 'allow');
    await set(dbRef(db, 'a/b'), 'value');
    await set(dbRef(db, 'a/b'), null);

    const ops = mutations(events)
      .filter((e) => e.service === 'rtdb' && e.path === '/a/b')
      .map((e) => e.op);
    expect(ops).toEqual(['set', 'remove']);
  });

  it('runTransaction emits a transaction event on commit', async () => {
    const sandbox = initializeSandbox();
    const events: SandboxEvent[] = [];
    sandbox.onEvent((e) => events.push(e));

    const db = getDatabase(sandbox.withAuth(null));
    rtdbSandbox.setDefaultPolicy(db, 'allow');
    await set(dbRef(db, 'counter'), 1);
    await runTransaction(dbRef(db, 'counter'), (cur) => (typeof cur === 'number' ? cur + 1 : 1));

    const txn = mutations(events).find(
      (e) => e.service === 'rtdb' && e.op === 'transaction',
    );
    expect(txn).toBeDefined();
    expect(txn!.path).toBe('/counter');
    expect(txn!.after).toBe(2);
    expect(txn!.detail?.committed).toBe(true);
  });

  it('emits canonical operation and commit events for RTDB writes', async () => {
    const sandbox = initializeSandbox();
    const events: SandboxEvent[] = [];
    sandbox.onEvent((e) => events.push(e));

    const db = getDatabase(sandbox.withAuth({ uid: 'alice' }));
    rtdbSandbox.setDefaultPolicy(db, 'allow');
    await set(dbRef(db, 'rooms/r1'), { name: 'lobby' });

    const op = operations(events).find((e) => e.service === 'rtdb' && e.path === '/rooms/r1');
    expect(op).toBeDefined();
    expect(op!.method).toBe('set');
    expect(op!.result).toBe('allow');
    expect(op!.origin).toBe('user');
    expect((op!.auth as { uid: string }).uid).toBe('alice');
    expect(op!.resourceAfter).toEqual({ data: { name: 'lobby' }, exists: true });

    const commit = commits(events).find((e) => e.service === 'rtdb' && e.path === '/rooms/r1');
    expect(commit).toBeDefined();
    expect(commit!.method).toBe('set');
    expect(commit!.nextState).toEqual({ name: 'lobby' });
  });

  it('emits canonical listener lifecycle events for RTDB onValue', async () => {
    const sandbox = initializeSandbox();
    const events: SandboxEvent[] = [];
    sandbox.onEvent((e) => events.push(e));

    const db = getDatabase(sandbox.withAuth(null));
    rtdbSandbox.setDefaultPolicy(db, 'allow');
    const seen: unknown[] = [];
    const unsub = onValue(dbRef(db, 'rooms/r1'), (snap) => seen.push(snap.val()));
    await set(dbRef(db, 'rooms/r1'), { name: 'lobby' });
    unsub();

    expect(seen).toEqual([null, { name: 'lobby' }]);
    const rtdbListeners = listeners(events).filter((e) => e.service === 'rtdb');
    expect(rtdbListeners.some((e) => e.phase === 'attach' && e.target.path === '/rooms/r1')).toBe(true);
    expect(rtdbListeners.some((e) => e.phase === 'delivery' && e.target.path === '/rooms/r1')).toBe(true);
    expect(rtdbListeners.some((e) => e.phase === 'detach' && e.target.path === '/rooms/r1')).toBe(true);
  });

  it('emits deny operation details for RTDB rules failures', async () => {
    const sandbox = initializeSandbox();
    const events: SandboxEvent[] = [];
    sandbox.onEvent((e) => events.push(e));

    const db = getDatabase(sandbox.withAuth({ uid: 'bob' }));
    rtdbSandbox.setRules(db, {
      rules: {
        private: {
          '.read': 'auth != null && auth.uid == "alice"',
          '.write': 'auth != null && auth.uid == "alice"',
        },
      },
    });

    await expect(set(dbRef(db, 'private/item'), { secret: true })).rejects.toThrow(
      'PERMISSION_DENIED',
    );

    const denied = operations(events).find(
      (e) => e.service === 'rtdb' && e.path === '/private/item' && e.result === 'deny',
    );
    expect(denied).toBeDefined();
    expect(denied!.method).toBe('set');
    expect(denied!.rules?.engine).toBe('rtdb');
    expect(denied!.reasons.length).toBeGreaterThan(0);
  });

  it('emits admin RTDB operations without mutating user auth', async () => {
    const sandbox = initializeSandbox();
    const events: SandboxEvent[] = [];
    sandbox.onEvent((e) => events.push(e));

    const userDb = getDatabase(sandbox.withAuth({ uid: 'bob' }));
    rtdbSandbox.setRules(userDb, {
      rules: {
        private: {
          '.read': 'auth != null && auth.uid == "alice"',
          '.write': 'auth != null && auth.uid == "alice"',
        },
      },
    });

    const adminDb = getAdminDatabase(sandbox);
    await set(dbRef(adminDb, 'private/item'), { secret: true });

    const adminOp = operations(events).find(
      (e) => e.service === 'rtdb' && e.path === '/private/item' && e.origin === 'admin',
    );
    expect(adminOp).toBeDefined();
    expect(adminOp!.result).toBe('not-applicable');
    expect(adminOp!.auth).toBeNull();

    await expect(set(dbRef(userDb, 'private/item'), { secret: false })).rejects.toThrow(
      'PERMISSION_DENIED',
    );
  });
});

describe('Studio T1 — Firestore stream is untouched', () => {
  it('Firestore writes still emit request/write, never service_mutation', async () => {
    const sandbox = initializeSandbox();
    const env = getInternalEnv(sandbox);
    env.seed({ rules: FIRESTORE_RULES });
    const events: SandboxEvent[] = [];
    sandbox.onEvent((e) => events.push(e));

    // Drive a rules-allowed Firestore write — emits request + write.
    env.execute({ method: 'set', path: 'notes/n1', auth: { uid: 'alice' }, data: { body: 'hi' } });

    expect(mutations(events).length).toBe(0);
    expect(events.some((e) => e.kind === 'request' || e.kind === 'write')).toBe(true);
    for (const e of events) {
      // Firestore events default to service 'firestore'.
      expect(e.service).toBe('firestore');
    }
  });
});
