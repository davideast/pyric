/**
 * An app's RTDB listeners follow its Auth identity. When the identity changes
 * and the listener may still read, its data is unchanged, so it fires
 * nothing; when it may no longer read, it is cancelled.
 */
import { expect, test } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { createAppForSandbox } from '../../src/app/internal.js';
import { deleteApp } from '../../src/app/index.js';
import { getAuth, signInWithCustomToken, signOut } from '../../src/auth/index.js';
import { mintCustomTokenFor } from '../../src/auth/internal.js';
import {
  get,
  getAdminDatabase,
  getDatabase,
  limitToFirst,
  onChildAdded,
  onValue,
  orderByKey,
  query,
  ref,
  set,
  sandbox as rtdbSandbox,
} from '../../src/database/index.js';
import {
  AUTH_CHANGE_LIVE_ROUTING_RUN_RULES,
  observeAuthChangeLiveRouting,
  withDeniedGetCode,
  type AuthChangeLiveRoutingObservation,
} from '../../../conformance/probes/rtdb-modular/rtdb-modular-auth-change-live-routing.ts';
import { load } from './modular/oracle-conformance.support.js';

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('an identity change that keeps a listener readable delivers nothing', async () => {
  const sandbox = initializeSandbox();
  const app = createAppForSandbox(sandbox, { projectId: 'live-auth' }, `live-auth-${Math.random()}`);
  try {
    const db = getDatabase(app);
    rtdbSandbox.setRules(db, { rules: { '.read': true, '.write': true } });
    await set(ref(db, 'items/a'), 1);
    const events: string[] = [];
    onValue(ref(db, 'items'), (snapshot) => events.push(`value ${JSON.stringify(snapshot.val())}`));
    onValue(query(ref(db, 'items'), orderByKey(), limitToFirst(2)), (snapshot) => events.push(`query ${JSON.stringify(snapshot.val())}`));
    onChildAdded(ref(db, 'items'), (snapshot) => events.push(`added ${snapshot.key}`));
    onChildAdded(query(ref(db, 'items'), orderByKey()), (snapshot) => events.push(`query added ${snapshot.key}`));
    expect(events).toEqual(['value {"a":1}', 'query {"a":1}', 'added a', 'query added a']);

    const auth = getAuth(app);
    await signInWithCustomToken(auth, mintCustomTokenFor(auth, 'alice'));
    await signOut(auth);
    await settle();
    expect(events).toEqual(['value {"a":1}', 'query {"a":1}', 'added a', 'query added a']);

    // The listeners stay live under the new identity.
    await set(ref(db, 'items/b'), 2);
    expect(events.slice(4).sort()).toEqual(['added b', 'query added b', 'query {"a":1,"b":2}', 'value {"a":1,"b":2}']);
  } finally {
    await deleteApp(app);
    sandbox.dispose();
  }
});

test('an identity change that denies a listener cancels it', async () => {
  const sandbox = initializeSandbox();
  const app = createAppForSandbox(sandbox, { projectId: 'live-auth' }, `live-auth-${Math.random()}`);
  try {
    const db = getDatabase(app);
    rtdbSandbox.setRules(db, { rules: { '.read': 'auth != null', '.write': true } });
    const auth = getAuth(app);
    await signInWithCustomToken(auth, mintCustomTokenFor(auth, 'alice'));
    const events: string[] = [];
    onValue(ref(db, 'items'), () => events.push('value'), (error) => events.push(`cancel ${(error as { code?: string }).code}`));
    await signOut(auth);
    await settle();
    expect(events).toEqual(['value', 'cancel PERMISSION_DENIED']);
  } finally {
    await deleteApp(app);
    sandbox.dispose();
  }
});

test('replays rtdb-modular-auth-change-live-routing across uninterrupted custom-token transitions (rtdb-modular#M38)', async () => {
  const observed = load('rtdb-modular-auth-change-live-routing.json') as unknown as AuthChangeLiveRoutingObservation;

  // Upstream firebase/database 12.19.0 cold "g"-wire PersistentConnection.get rejects
  // rules-denied reads with Error("Permission denied") (code: null), while Pyric get()
  // pins code: "PERMISSION_DENIED" per rtdb-modular#110.
  expect(observed.initialSignedOut.readAuthed.code).toBeNull();
  expect(observed.afterSwitchToBob.readAliceOther.code).toBeNull();
  expect(observed.afterSignOut.readAuthedDenied.code).toBeNull();

  const sandbox = initializeSandbox();
  const app = createAppForSandbox(
    sandbox,
    { projectId: 'live-auth-oracle' },
    `live-auth-oracle-${Math.random()}`,
  );
  try {
    const auth = getAuth(app);
    const db = getDatabase(app);
    const adminDb = getAdminDatabase(sandbox);
    const runId = 'rtdb_replay_run';
    const basePath = `/pyric_oracle/${runId}`;
    const aliceUid = 'alice-replay-uid';
    const bobUid = 'bob-replay-uid';

    rtdbSandbox.setRules(db, {
      rules: {
        '.read': false,
        '.write': false,
        pyric_oracle: {
          [runId]: AUTH_CHANGE_LIVE_ROUTING_RUN_RULES,
        },
      },
    });

    const replayed = await observeAuthChangeLiveRouting({
      db: db as never,
      basePath,
      aliceUid,
      bobUid,
      ref: ref as never,
      get: get as never,
      set: set as never,
      onValue: onValue as never,
      onChildAdded: onChildAdded as never,
      async seedAdminData(subpath, value) {
        await set(ref(adminDb, `${basePath}/${subpath}`), value as never);
      },
      async signInAs(role) {
        let uid = bobUid;
        if (role === 'alice') {
          uid = aliceUid;
        }
        await signInWithCustomToken(auth, mintCustomTokenFor(auth, uid));
      },
      async signOut() {
        await signOut(auth);
      },
    });

    expect(replayed.initialSignedOut.readAuthed.code).toBe('PERMISSION_DENIED');
    expect(replayed.afterSwitchToBob.readAliceOther.code).toBe('PERMISSION_DENIED');
    expect(replayed.afterSignOut.readAuthedDenied.code).toBe('PERMISSION_DENIED');
    expect(replayed).toEqual(withDeniedGetCode(observed, 'PERMISSION_DENIED'));
  } finally {
    await deleteApp(app);
    sandbox.dispose();
  }
});
