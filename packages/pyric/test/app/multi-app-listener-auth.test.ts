import { beforeEach, describe, expect, it } from 'bun:test';
import { deleteApp, getApps, initializeApp } from 'pyric/app';
import {
  GoogleAuthProvider,
  getAuth,
  onAuthStateChanged,
  sandbox as authSandbox,
  signInAnonymously,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
} from 'pyric/auth';
import {
  collection,
  getFirestore,
  onSnapshot,
  query,
  type QuerySnapshot,
  where,
} from 'pyric/firestore';
import {
  getAdminDatabase,
  getDatabase,
  off,
  onValue,
  ref,
  sandbox as databaseSandbox,
  set,
} from 'pyric/database';
import { setRules } from 'pyric/sandbox/firestore';
import { getMessaging, onMessage, sandbox as messagingSandbox } from 'pyric/messaging';
import { sandboxForApp } from '../../dist/app/runtime.js';
import { resetAppRegistryForTests } from '../../dist/app/registry.js';

const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /notes/{id} {
      allow read: if request.auth != null && request.auth.uid == resource.data.owner;
    }
  }
}`;

const OPTIONS = { projectId: 'multi-app-listener-auth' };

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

beforeEach(async () => {
  await resetAppRegistryForTests();
  await Promise.all(getApps().map((app) => deleteApp(app)));
});

describe('named Firebase apps isolate listener authorization', () => {
  it('keeps the replacement persistence binding during overlapping same-name deletion', async () => {
    const options = { projectId: 'overlapping-session-registration-lifecycle' };
    const first = initializeApp(options, 'overlap');
    const sandbox = sandboxForApp(first);
    getAuth(first);

    const deleting = deleteApp(first);
    const replacement = initializeApp(options, 'overlap');
    getAuth(replacement);
    await deleting;

    expect(sandbox.snapshot().services).toHaveProperty('auth-session:overlap');
  });

  it('notifies sign-out after the default app is deleted and reinitialized', async () => {
    const options = { projectId: 'default-auth-reinitialize-notification' };
    const first = initializeApp(options);
    const firstAuth = getAuth(first);
    const uid = (await signInAnonymously(firstAuth)).user.uid;
    await deleteApp(first);

    const replacement = initializeApp(options);
    const replacementAuth = getAuth(replacement);
    const events: Array<string | null> = [];
    onAuthStateChanged(replacementAuth, (user) => events.push(user?.uid ?? null));
    await Promise.resolve();
    await signOut(replacementAuth);
    await Promise.resolve();

    expect(events).toEqual([uid, null]);
  });

  it('evicts a deleted named app session registration before same-name reinitialization', async () => {
    const options = { projectId: 'named-session-registration-lifecycle' };
    const first = initializeApp(options, 'named-session');
    const sandbox = sandboxForApp(first);
    getAuth(first);
    expect(sandbox.snapshot().services).toHaveProperty('auth-session:named-session');

    await deleteApp(first);

    expect(sandbox.snapshot().services).not.toHaveProperty('auth-session:named-session');
    const replacement = initializeApp(options, 'named-session');
    expect(() => getAuth(replacement)).not.toThrow();
    expect(sandbox.snapshot().services).toHaveProperty('auth-session:named-session');
  });

  it('keeps provider-enforcement delegation scoped to its app backend', async () => {
    const defaultApp = initializeApp({ projectId: 'provider-delegation-isolation' });
    const namedApp = initializeApp({ projectId: 'provider-delegation-isolation' }, 'named');
    const defaultAuth = getAuth(defaultApp);
    const namedAuth = getAuth(namedApp);

    authSandbox.setAuthProviderConfig(namedAuth, 'google.com', false);
    authSandbox.delegateProviderEnforcement(defaultAuth, true);

    await expect(signInWithPopup(namedAuth, new GoogleAuthProvider())).rejects.toMatchObject({
      code: 'auth/operation-not-allowed',
    });
  });

  it('deleting an app stops its Auth observers', async () => {
    const app = initializeApp({ projectId: 'app-delete-auth-listener' });
    const sandbox = sandboxForApp(app);
    const users: Array<string | null> = [];
    onAuthStateChanged(getAuth(app), (user) => users.push(user?.uid ?? null));
    await Promise.resolve();
    expect(users).toEqual([null]);

    await deleteApp(app);
    sandbox.currentUser = { uid: 'after-delete' };
    await Promise.resolve();

    expect(users).toEqual([null]);
  });

  it('deleting an app aborts its Firestore listeners while preserving the backend', async () => {
    const app = initializeApp({ projectId: 'app-delete-firestore-listener' });
    const sandbox = sandboxForApp(app);
    setRules(sandbox, `rules_version = '2'; service cloud.firestore {
      match /databases/{database}/documents { match /{document=**} { allow read: if true; } }
    }`);
    const snapshots: QuerySnapshot[] = [];
    const errors: Array<{ code?: string }> = [];
    onSnapshot(collection(getFirestore(app), 'notes'), (snapshot) => {
      snapshots.push(snapshot as QuerySnapshot);
    }, (error) => errors.push(error as { code?: string }));
    await tick();
    expect(snapshots).toHaveLength(1);

    await deleteApp(app);
    sandbox.admin.setDocument('notes/after-delete', { text: 'still persisted' });
    await tick();

    expect(snapshots).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: 'aborted' });
    expect(sandbox.admin.getDocument('notes/after-delete')).toEqual({ text: 'still persisted' });
  });

  it('deleting one app stops its RTDB listeners without affecting a sibling app', async () => {
    const defaultApp = initializeApp({ projectId: 'multi-app-delete-listener' });
    const namedApp = initializeApp({ projectId: 'multi-app-delete-listener' }, 'named');
    const defaultRef = ref(getDatabase(defaultApp), 'shared/value');
    const namedRef = ref(getDatabase(namedApp), 'shared/value');
    const defaultValues: unknown[] = [];
    const namedValues: unknown[] = [];

    onValue(defaultRef, (snapshot) => defaultValues.push(snapshot.val()));
    onValue(namedRef, (snapshot) => namedValues.push(snapshot.val()));
    expect(defaultValues).toEqual([null]);
    expect(namedValues).toEqual([null]);

    await deleteApp(defaultApp);
    await set(namedRef, 1);

    expect(defaultValues).toEqual([null]);
    expect(namedValues).toEqual([null, 1]);
  });

  it('deleting one app stops its Messaging observers without affecting the shared broker', async () => {
    const deletedApp = initializeApp({ projectId: 'multi-app-delete-messaging' });
    const siblingApp = initializeApp({ projectId: 'multi-app-delete-messaging' }, 'named');
    const deletedMessaging = getMessaging(deletedApp);
    const siblingMessaging = getMessaging(siblingApp);
    const deletedPayloads: unknown[] = [];
    const siblingPayloads: unknown[] = [];
    onMessage(deletedMessaging, (payload) => deletedPayloads.push(payload));
    onMessage(siblingMessaging, (payload) => siblingPayloads.push(payload));

    await deleteApp(deletedApp);
    await messagingSandbox.deliver(siblingMessaging, {
      visibilityState: 'visible',
      data: { afterDelete: 'yes' },
    });

    expect(deletedPayloads).toHaveLength(0);
    expect(siblingPayloads).toHaveLength(1);
  });

  it('off(ref) cancels only listeners owned by that app instance', async () => {
    const defaultApp = initializeApp({ projectId: 'multi-app-off-listener' });
    const namedApp = initializeApp({ projectId: 'multi-app-off-listener' }, 'named');
    const defaultRef = ref(getDatabase(defaultApp), 'shared/value');
    const namedRef = ref(getDatabase(namedApp), 'shared/value');
    const defaultValues: unknown[] = [];
    const namedValues: unknown[] = [];

    onValue(defaultRef, (snapshot) => defaultValues.push(snapshot.val()));
    onValue(namedRef, (snapshot) => namedValues.push(snapshot.val()));
    off(defaultRef);
    await set(namedRef, 1);

    expect(defaultValues).toEqual([null]);
    expect(namedValues).toEqual([null, 1]);
  });

  it('off(ref, event, callback) removes duplicate callback registrations one at a time', async () => {
    const app = initializeApp({ projectId: 'duplicate-rtdb-listener' });
    const valueRef = ref(getDatabase(app), 'shared/value');
    const values: unknown[] = [];
    const callback = (snapshot: { val(): unknown }): void => {
      values.push(snapshot.val());
    };
    onValue(valueRef, callback);
    onValue(valueRef, callback);
    expect(values).toEqual([null, null]);

    off(valueRef, 'value', callback);
    await set(valueRef, 1);
    expect(values).toEqual([null, null, 1]);

    off(valueRef, 'value', callback);
    await set(valueRef, 2);

    expect(values).toEqual([null, null, 1]);
  });

  it('only the initiating app session reauthorizes its Firestore listener', async () => {
    const defaultApp = initializeApp(OPTIONS);
    const namedApp = initializeApp({ ...OPTIONS }, 'named');
    const sandbox = sandboxForApp(defaultApp);
    setRules(sandbox, RULES);
    sandbox.admin.setDocument('notes/b', { owner: 'b', text: 'private' });

    const defaultAuth = getAuth(defaultApp);
    const namedAuth = getAuth(namedApp);
    authSandbox.seedUsers(namedAuth, [{ email: 'b@example.com', password: 'password-123', uid: 'b' }]);
    authSandbox.seedUsers(defaultAuth, [{ email: 'a@example.com', password: 'password-123', uid: 'a' }]);
    await signInWithEmailAndPassword(namedAuth, 'b@example.com', 'password-123');

    const snapshots: QuerySnapshot[] = [];
    const errors: unknown[] = [];
    const namedDb = getFirestore(namedApp);
    const unsubscribe = onSnapshot(
      query(collection(namedDb, 'notes'), where('owner', '==', 'b')),
      (snapshot) => snapshots.push(snapshot as QuerySnapshot),
      (error) => errors.push(error),
    );
    await tick();
    expect(snapshots).toHaveLength(1);
    expect(errors).toHaveLength(0);

    await signInWithEmailAndPassword(defaultAuth, 'a@example.com', 'password-123');
    await tick();
    expect(namedAuth.currentUser?.uid).toBe('b');
    expect(errors).toHaveLength(0);

    await signOut(namedAuth);
    await tick();
    expect(errors).toHaveLength(1);
    unsubscribe();
  });

  it('does not resurrect an RTDB listener after its app session loses access', async () => {
    const defaultApp = initializeApp({ projectId: 'multi-app-rtdb-listener' });
    const namedApp = initializeApp({ projectId: 'multi-app-rtdb-listener' }, 'named');
    const defaultAuth = getAuth(defaultApp);
    const namedAuth = getAuth(namedApp);
    authSandbox.seedUsers(namedAuth, [{ email: 'b@example.com', password: 'password-123', uid: 'b' }]);
    authSandbox.seedUsers(defaultAuth, [{ email: 'a@example.com', password: 'password-123', uid: 'a' }]);

    const namedDb = getDatabase(namedApp);
    const adminDb = getAdminDatabase(defaultApp);
    await set(ref(adminDb, 'notes/b'), { owner: 'b', text: 'private' });
    databaseSandbox.setRules(namedDb, {
      rules: {
        notes: {
          '$id': {
            '.read': "auth != null && auth.uid == data.child('owner').val()",
          },
        },
      },
    });
    await signInWithEmailAndPassword(namedAuth, 'b@example.com', 'password-123');

    const values: unknown[] = [];
    const unsubscribe = onValue(ref(namedDb, 'notes/b'), (snapshot) => {
      values.push(snapshot.val());
    });
    expect(values).toHaveLength(1);

    await signInWithEmailAndPassword(defaultAuth, 'a@example.com', 'password-123');
    expect(values).toHaveLength(1);

    await signOut(namedAuth);
    await set(ref(adminDb, 'notes/b/text'), 'changed while signed out');
    expect(values).toHaveLength(1);

    await signInWithEmailAndPassword(namedAuth, 'b@example.com', 'password-123');
    expect(values).toHaveLength(1);
    const freshValues: unknown[] = [];
    const unsubscribeFresh = onValue(ref(namedDb, 'notes/b'), (snapshot) => {
      freshValues.push(snapshot.val());
    });
    expect(freshValues).toEqual([{ owner: 'b', text: 'changed while signed out' }]);
    await set(ref(adminDb, 'notes/b/text'), 'fresh listener only');
    expect(values).toHaveLength(1);
    expect(freshValues.at(-1)).toEqual({ owner: 'b', text: 'fresh listener only' });
    unsubscribeFresh();
    unsubscribe();
  });
});
