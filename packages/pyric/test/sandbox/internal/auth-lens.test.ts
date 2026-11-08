import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { deleteApp, getApps, initializeApp } from '../../../src/app/index.js';
import { resetAppRegistryForTests } from '../../../src/app/registry.js';
import {
  createUserWithEmailAndPassword,
  getAuth,
  signInWithEmailAndPassword,
  signOut,
} from '../../../src/auth/index.js';
import {
  collection,
  doc,
  getFirestore,
  onSnapshot,
  setDoc,
} from '../../../src/firestore/index.js';
import { getFirestore as getAdminFirestore } from '../../../src/sandbox/admin-firestore/index.js';
import { initializeSandbox } from 'pyric/sandbox';
import { getInternalEnv } from '../../../src/sandbox/internal/sandbox-impl.js';
import { getAuthLens, onAuthLensChanged, switchAuthLens } from '../../../src/sandbox/internal/auth-lens.js';
import { resolveClientApp } from '../../../src/sandbox/internal/client-app.js';

const APP_OPTIONS = { projectId: 'demo-auth-lens' };

beforeEach(async () => {
  switchAuthLens(undefined);
  await resetAppRegistryForTests();
});

afterEach(async () => {
  switchAuthLens(undefined);
  for (const app of getApps()) {
    resolveClientApp(app)?.sandbox.reset();
  }
  await Promise.all(getApps().map((app) => deleteApp(app)));
  await resetAppRegistryForTests();
});

describe('cross-surface AuthLens state', () => {
  it('stores active lenses, collapses app-session to undefined, and notifies subscribers', () => {
    const seen: Array<string | undefined> = [];
    const unsubscribe = onAuthLensChanged((lens) => {
      seen.push(lens?.mode);
    });

    switchAuthLens({ mode: 'admin' });
    expect(getAuthLens()).toEqual({ mode: 'admin' });

    switchAuthLens({ mode: 'app-session' });
    expect(getAuthLens()).toBeUndefined();

    unsubscribe();
    switchAuthLens({ mode: 'anon' });
    expect(seen).toEqual(['admin', undefined]);
  });

  it('shares active lens state across package copies and sandbox-target Firestore handles', async () => {
    const copy = (await import(`../../../src/sandbox/internal/auth-lens.js?copy=${Date.now()}`)) as typeof import('../../../src/sandbox/internal/auth-lens.js');
    const sandbox = initializeSandbox();
    getFirestore(sandbox);

    copy.switchAuthLens({ mode: 'as', uid: 'user-1', token: { role: 'reader' } });
    expect(getAuthLens()).toEqual({ mode: 'as', uid: 'user-1', token: { role: 'reader' } });

    sandbox.dispose();
  });

  it('keeps live onSnapshot listeners pinned to an active impersonation lens across signIn and signOut', async () => {
    const app = initializeApp(APP_OPTIONS, 'lens-impersonation-app');
    const sandbox = resolveClientApp(app)!.sandbox;
    const env = getInternalEnv(sandbox);
    getAdminFirestore(sandbox.withAuth(null)).setRules(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{uid}/items/{itemId} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
    }
  }
}`);
    sandbox.admin.setDocument('users/alice/items/item-1', { step: 1 });

    const auth = getAuth(app);
    await createUserWithEmailAndPassword(auth, 'bob@example.com', 'secret-pw');
    await signOut(auth);

    switchAuthLens({ mode: 'as', uid: 'alice' });

    const db = getFirestore(app);
    const appSnapshots: number[] = [];
    const appErrors: string[] = [];
    const unsubApp = onSnapshot(
      doc(db, 'users/alice/items/item-1'),
      (snap) => {
        const data = snap.data() as { step?: number } | undefined;
        if (data?.step !== undefined) appSnapshots.push(data.step);
      },
      (err) => appErrors.push(err.code),
    );

    const sandboxDb = getFirestore(sandbox);
    const sbSnapshots: number[] = [];
    const sbErrors: string[] = [];
    const unsubSb = onSnapshot(
      doc(sandboxDb, 'users/alice/items/item-1'),
      (snap) => {
        const data = snap.data() as { step?: number } | undefined;
        if (data?.step !== undefined) sbSnapshots.push(data.step);
      },
      (err) => sbErrors.push(err.code),
    );

    env.flushListeners();
    expect(appSnapshots).toEqual([1]);
    expect(sbSnapshots).toEqual([1]);

    await signInWithEmailAndPassword(auth, 'bob@example.com', 'secret-pw');
    await signOut(auth);
    sandbox.currentUser = { uid: 'bob' };
    sandbox.currentUser = null;

    expect(appErrors).toEqual([]);
    expect(sbErrors).toEqual([]);

    await setDoc(doc(db, 'users/alice/items/item-1'), { step: 2 });
    env.flushListeners();
    expect(appSnapshots).toEqual([1, 2]);
    expect(sbSnapshots).toEqual([1, 2]);

    unsubApp();
    unsubSb();
  });

  it('preserves live onSnapshot listeners when transitioning from impersonation to admin while signed out', async () => {
    const app = initializeApp(APP_OPTIONS, 'lens-to-admin-app');
    const sandbox = resolveClientApp(app)!.sandbox;
    const env = getInternalEnv(sandbox);
    getAdminFirestore(sandbox.withAuth(null)).setRules(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /orgs/{orgId}/items/{itemId} {
      allow read: if request.auth != null && request.auth.uid == 'alice';
    }
  }
}`);
    sandbox.admin.setDocument('orgs/org-1/items/item-1', { title: 'alpha' });

    switchAuthLens({ mode: 'as', uid: 'alice' });
    const db = getFirestore(app);
    const titles: string[][] = [];
    const errors: string[] = [];
    const unsub = onSnapshot(
      collection(db, 'orgs/org-1/items'),
      (snap) => {
        titles.push(snap.docs.map((d) => String((d.data() as { title?: string }).title)));
      },
      (err) => errors.push(err.code),
    );

    env.flushListeners();
    expect(titles).toEqual([['alpha']]);

    switchAuthLens({ mode: 'admin' });
    expect(errors).toEqual([]);

    getAdminFirestore(sandbox.withAuth(null)).setRules(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if false;
    }
  }
}`);
    sandbox.admin.setDocument('orgs/org-1/items/item-2', { title: 'beta' });
    env.flushListeners();
    expect(errors).toEqual([]);
    expect(titles).toEqual([['alpha'], ['alpha', 'beta']]);

    unsub();
  });

  it('revokes admin bypass and delivers permission-denied when switching from admin to anon on a locked collection', async () => {
    const app = initializeApp(APP_OPTIONS, 'lens-admin-to-anon-app');
    const sandbox = resolveClientApp(app)!.sandbox;
    const env = getInternalEnv(sandbox);
    getAdminFirestore(sandbox.withAuth(null)).setRules(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /locked/{itemId} {
      allow read, write: if false;
    }
  }
}`);
    sandbox.admin.setDocument('locked/item-1', { secret: 'v1' });

    switchAuthLens({ mode: 'admin' });

    const db = getFirestore(app);
    const appSizes: number[] = [];
    const appErrors: string[] = [];
    const unsubApp = onSnapshot(
      collection(db, 'locked'),
      (snap) => appSizes.push(snap.size),
      (err) => appErrors.push(err.code),
    );

    const sandboxDb = getFirestore(sandbox);
    const sbSizes: number[] = [];
    const sbErrors: string[] = [];
    const unsubSb = onSnapshot(
      collection(sandboxDb, 'locked'),
      (snap) => sbSizes.push(snap.size),
      (err) => sbErrors.push(err.code),
    );

    env.flushListeners();
    expect(appSizes).toEqual([1]);
    expect(sbSizes).toEqual([1]);
    expect(appErrors).toEqual([]);
    expect(sbErrors).toEqual([]);

    switchAuthLens({ mode: 'anon' });
    expect(appErrors).toEqual(['permission-denied']);
    expect(sbErrors).toEqual(['permission-denied']);

    sandbox.admin.setDocument('locked/item-2', { secret: 'v2' });
    env.flushListeners();
    expect(appSizes).toEqual([1]);
    expect(sbSizes).toEqual([1]);

    unsubApp();
    unsubSb();
  });
});
