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
import {
  getDatabase, limitToFirst, onChildAdded, onValue, orderByKey, query, ref, set,
  sandbox as rtdbSandbox,
} from '../../src/database/index.js';

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
    await signInWithCustomToken(auth, JSON.stringify({ uid: 'alice' }));
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
    await signInWithCustomToken(auth, JSON.stringify({ uid: 'alice' }));
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
