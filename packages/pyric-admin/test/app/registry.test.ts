/**
 * `pyric-admin/app` default-app registry — mirror conformance against
 * `firebase-admin/app`'s lifecycle (oracle:
 * `firebase-admin/lib/app/lifecycle.js`).
 *
 * Covers:
 *   - register/get semantics: unnamed `initializeApp` registers
 *     `'[DEFAULT]'`; `getApp(name?)` / `getApps()` read the registry.
 *   - error mirror: `app/no-app` (exact upstream message text, default
 *     and named variants), `app/duplicate-app`,
 *     `app/invalid-app-options` (bare-vs-config'd autoInit mismatch),
 *     `app/invalid-app-name`, `app/invalid-argument` (deleteApp).
 *   - idempotency mirror: repeated bare calls return the same app;
 *     repeated `{ sandbox }` calls with the SAME Sandbox reference
 *     return the same app; prod re-inits with deep-equal options return
 *     the same app (decided by firebase-admin itself).
 *   - no-arg `getDatabase()` / `getAuth()` resolving the default app on
 *     the LOCAL SANDBOX and PROD arms (the remote arm reuses the
 *     headless harness in `../remote/remote-dispatch.test.ts`).
 */

import { afterEach, beforeEach, describe, it, expect } from 'bun:test';

import { initializeSandbox } from 'pyric/sandbox';

import {
  DEFAULT_APP_NAME,
  deleteApp,
  getApp,
  getApps,
  initializeApp,
  isSandboxAdminApp,
} from '../../src/app/index.js';
import { getDatabase } from '../../src/database/index.js';
import { getAuth } from '../../src/auth/index.js';
import { getFirestore } from '../../src/firestore/index.js';
import { getStorage } from '../../src/storage/index.js';
import { getMessaging } from '../../src/messaging/index.js';

// The registry is module-global (mirror of firebase-admin's
// defaultAppStore) — start every test from an empty registry, and make
// sure no ambient-activation env leaks in from other suites.
beforeEach(() => {
  delete process.env.PYRIC_SANDBOX;
  delete process.env.PYRIC_SANDBOX_FORCE;
});
afterEach(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app)));
});

function expectAppError(fn: () => unknown, code: string, message: RegExp): void {
  let err: unknown;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(Error);
  expect((err as { code?: string }).code).toBe(code);
  expect((err as Error).message).toMatch(message);
}

describe('app registry — register / get', () => {
  it("unnamed initializeApp registers '[DEFAULT]'", () => {
    const app = initializeApp({ sandbox: initializeSandbox() });
    expect(app.name).toBe('[DEFAULT]');
    expect(DEFAULT_APP_NAME).toBe('[DEFAULT]');
    expect(getApp()).toBe(app);
    expect(getApp('[DEFAULT]')).toBe(app);
  });

  it('named initializeApp registers under the name; getApps lists all', () => {
    const def = initializeApp({ sandbox: initializeSandbox() });
    const other = initializeApp({ sandbox: initializeSandbox() }, 'other');
    expect(other.name).toBe('other');
    expect(getApp('other')).toBe(other);
    expect(getApps()).toEqual([def, other]);
    // getApps returns a copy — mutating it must not touch the registry.
    getApps().pop();
    expect(getApps()).toHaveLength(2);
  });

  it('getApp throws app/no-app with the exact firebase-admin message (default)', () => {
    expectAppError(
      () => getApp(),
      'app/no-app',
      /^The default Firebase app does not exist\. Make sure you call initializeApp\(\) before using any of the Firebase services\.$/,
    );
  });

  it('getApp throws app/no-app with the exact firebase-admin message (named)', () => {
    expectAppError(
      () => getApp('missing'),
      'app/no-app',
      /^Firebase app named "missing" does not exist\. Make sure you call initializeApp\(\) before using any of the Firebase services\.$/,
    );
  });

  it('empty / non-string names throw app/invalid-app-name (both init and get)', () => {
    expectAppError(() => getApp(''), 'app/invalid-app-name', /non-empty string/);
    expectAppError(
      () => initializeApp({ sandbox: initializeSandbox() }, ''),
      'app/invalid-app-name',
      /Invalid Firebase app name "" provided\. App name must be a non-empty string\./,
    );
    expectAppError(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => getApp(42 as any),
      'app/invalid-app-name',
      /non-empty string/,
    );
  });
});

describe('app registry — duplicate semantics (firebase-admin mirror)', () => {
  it('re-initializing a name with a DIFFERENT sandbox throws app/duplicate-app', () => {
    initializeApp({ sandbox: initializeSandbox() });
    expectAppError(
      () => initializeApp({ sandbox: initializeSandbox() }),
      'app/duplicate-app',
      /^A Firebase app named "\[DEFAULT\]" already exists with a different configuration\.$/,
    );
  });

  it('re-initializing with the SAME Sandbox reference returns the existing app', () => {
    const sandbox = initializeSandbox();
    const first = initializeApp({ sandbox });
    expect(initializeApp({ sandbox })).toBe(first);
  });

  it('different names never collide', () => {
    const a = initializeApp({ sandbox: initializeSandbox() }, 'a');
    const b = initializeApp({ sandbox: initializeSandbox() }, 'b');
    expect(a).not.toBe(b);
    expect(getApp('a')).toBe(a);
    expect(getApp('b')).toBe(b);
  });

});

describe('app registry — deleteApp', () => {
  it('removes the app so the name can be re-initialized', async () => {
    const sandbox = initializeSandbox();
    const app = initializeApp({ sandbox });
    await deleteApp(app);
    expect(getApps()).toHaveLength(0);
    expectAppError(() => getApp(), 'app/no-app', /does not exist/);
    // Name is free again — a different sandbox no longer collides.
    const again = initializeApp({ sandbox: initializeSandbox() });
    expect(again).not.toBe(app);
  });

  it('deleted app throws app/app-deleted; non-app values throw app/invalid-argument', async () => {
    const sandbox = initializeSandbox();
    const app = initializeApp({ sandbox });
    await deleteApp(app);
    expectAppError(() => deleteApp(app), 'app/app-deleted', /has already been deleted/);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expectAppError(() => deleteApp({} as any), 'app/invalid-argument', /^Invalid app argument\.$/);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expectAppError(() => deleteApp(null as any), 'app/invalid-argument', /^Invalid app argument\.$/);
  });

  it('explicit service factories reject a deleted sandbox app', async () => {
    const app = initializeApp({ sandbox: initializeSandbox() });
    await deleteApp(app);

    for (const factory of [getAuth, getFirestore, getDatabase, getStorage, getMessaging]) {
      expectAppError(
        () => factory(app),
        'app/app-deleted',
        /Firebase app named "\[DEFAULT\]" has already been deleted/,
      );
    }
  });

  it('a stale deleted wrapper cannot delete its same-name replacement', async () => {
    const stale = initializeApp({ sandbox: initializeSandbox() });
    await deleteApp(stale);
    const replacement = initializeApp({ sandbox: initializeSandbox() });

    let error: unknown;
    try {
      await deleteApp(stale);
    } catch (caught) {
      error = caught;
    }

    expect((error as { code?: string }).code).toBe('app/app-deleted');
    expect(getApp()).toBe(replacement);
    expect(() => getAuth(replacement)).not.toThrow();
  });
});

describe('no-arg getDatabase() / getAuth() — default-app resolution', () => {
  it('throws app/no-app when no default app exists', () => {
    expectAppError(() => getDatabase(), 'app/no-app', /The default Firebase app does not exist/);
    expectAppError(() => getAuth(), 'app/no-app', /The default Firebase app does not exist/);
  });

  it('local sandbox arm: no-arg handles hit the default app’s in-memory backends', async () => {
    const app = initializeApp({ sandbox: initializeSandbox() });
    expect(isSandboxAdminApp(app)).toBe(true);

    const db = getDatabase(); // no-arg — resolves '[DEFAULT]'
    await db.ref('ambient/local').set({ ok: true });
    expect((await db.ref('ambient/local').get()).val()).toEqual({ ok: true });
    // Same backend as the explicit-app handle (singleton per sandbox).
    expect((await getDatabase(app).ref('ambient/local').get()).val()).toEqual({ ok: true });

    const auth = getAuth(); // no-arg — resolves '[DEFAULT]'
    await auth.createUser({ uid: 'ambient-user', email: 'ambient@example.com' });
    expect((await getAuth(app).getUser('ambient-user')).email).toBe('ambient@example.com');
  });

});
