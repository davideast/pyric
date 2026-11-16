/**
 * App-brand validation tests for `getFirestore()` in `pyric-admin/firestore`.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { ADMIN_APP_TARGET, deleteApp, getApps, initializeApp } from '../../src/app/index.js';
import { getFirestore } from '../../src/firestore/index.js';

afterEach(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app)));
});

describe('pyric-admin/firestore getFirestore app-brand validation', () => {
  it('rejects unbranded objects, null, primitives, and bare Sandbox handles with TypeError', () => {
    const sandbox = initializeSandbox();
    expect(() => getFirestore({} as never)).toThrow(TypeError);
    expect(() => getFirestore(null as never)).toThrow(TypeError);
    expect(() => getFirestore('not-an-app' as never)).toThrow(TypeError);
    expect(() => getFirestore(42 as never)).toThrow(TypeError);
    expect(() => getFirestore([] as never)).toThrow(TypeError);
    expect(() => getFirestore(sandbox as never)).toThrow(TypeError);
  });

  it('rejects non-sandbox admin app targets and deleted apps', async () => {
    const sandbox = initializeSandbox();
    const app = initializeApp({ sandbox }, 'fs-brand-disposable');
    await deleteApp(app);
    expect(() => getFirestore(app)).toThrow(/already been deleted/);

    const nonSandboxApp = { [ADMIN_APP_TARGET]: 'prod', sandbox: {} } as never;
    expect(() => getFirestore(nonSandboxApp)).toThrow(/sandbox apps/);
  });

  it('continues accepting valid PyricAdminApp, default app, and SandboxContext handles', async () => {
    const sandbox = initializeSandbox();
    const app = initializeApp({ sandbox });
    const defaultDb = getFirestore();
    const appDb = getFirestore(app);
    expect(defaultDb).toBe(appDb);

    await appDb.doc('docs/doc-1').set({ status: 'ok' });
    const snap = await appDb.doc('docs/doc-1').get();
    expect(snap.data()).toEqual({ status: 'ok' });

    const ctxDb = getFirestore(sandbox.withAuth({ uid: 'u1' }));
    const ctxSnap = await ctxDb.doc('docs/doc-1').get();
    expect(ctxSnap.data()).toEqual({ status: 'ok' });
  });
});
