/**
 * Phase 3 + Phase 4b tests for `pyric-admin/database`.
 *
 * Two paths exercised:
 *
 *   1. Sandbox app (`ADMIN_APP_TARGET === 'sandbox'`) → in-memory RTDB
 *      backend defined in this package. Tests cover the load-bearing
 *      data-plane subset: set/get roundtrip, update merges, push key
 *      uniqueness, remove deletes, child returns a sub-ref, reset
 *      clears state.
 *
 *   2. Prod app (`ADMIN_APP_TARGET === 'prod'`) → dispatch to
 *      `firebase-admin/database`. The module is mocked so the test
 *      stays hermetic — no real GCP credentials, no network. Asserting
 *      the returned identity (and call shape) proves dispatch happened.
 */

import { describe, it, expect, mock } from 'bun:test';

import { initializeSandbox } from 'pyric/sandbox';
import type { Sandbox } from 'pyric/sandbox';

import { ADMIN_APP_TARGET, type PyricAdminApp } from '../app/index.js';

import { getDatabase } from './index.js';

// ── Helpers ───────────────────────────────────────────────────────────

/** Build a sandbox-flavored `PyricAdminApp` over a real `Sandbox`. We
 *  bypass `initializeApp` so tests don't need to construct credentials
 *  for the prod branch — `initializeApp` is exercised by the app tests. */
function sandboxApp(sandbox: Sandbox): PyricAdminApp {
  return {
    [ADMIN_APP_TARGET]: 'sandbox',
    sandbox,
  };
}

// ── Sandbox-backend tests ─────────────────────────────────────────────

describe('pyric-admin/database — sandbox backend (Phase 4b)', () => {
  it('returns a Database handle for a sandbox app', () => {
    const sandbox = initializeSandbox();
    const db = getDatabase(sandboxApp(sandbox));
    expect(db).toBeDefined();
    expect(typeof db.ref).toBe('function');
  });

  it('set + get roundtrips the written value', async () => {
    const sandbox = initializeSandbox();
    const db = getDatabase(sandboxApp(sandbox));
    const ref = db.ref('/greetings/hello');
    await ref.set({ text: 'hi' });
    const snap = await ref.get();
    expect(snap.exists()).toBe(true);
    expect(snap.val()).toEqual({ text: 'hi' });
    expect(snap.key).toBe('hello');
  });

  it('get on an absent path returns a snapshot where exists() is false', async () => {
    const sandbox = initializeSandbox();
    const db = getDatabase(sandboxApp(sandbox));
    const snap = await db.ref('/nope').get();
    expect(snap.exists()).toBe(false);
    expect(snap.val()).toBeNull();
  });

  it('update merges children (does not replace the whole object)', async () => {
    const sandbox = initializeSandbox();
    const db = getDatabase(sandboxApp(sandbox));
    const ref = db.ref('/user');
    await ref.set({ name: 'Ada', age: 36 });
    await ref.update({ age: 37, city: 'London' });
    const snap = await ref.get();
    expect(snap.val()).toEqual({ name: 'Ada', age: 37, city: 'London' });
  });

  it('update with a null value removes the corresponding child', async () => {
    const sandbox = initializeSandbox();
    const db = getDatabase(sandboxApp(sandbox));
    const ref = db.ref('/user');
    await ref.set({ name: 'Ada', age: 36 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await ref.update({ age: null } as any);
    const snap = await ref.get();
    expect(snap.val()).toEqual({ name: 'Ada' });
  });

  it('push generates a 20-char, lex-sortable key and writes the value', async () => {
    const sandbox = initializeSandbox();
    const db = getDatabase(sandboxApp(sandbox));
    const listRef = db.ref('/posts');

    const r1 = listRef.push({ title: 'first' });
    const r2 = listRef.push({ title: 'second' });

    expect(r1.key).toBeTypeOf('string');
    expect(r1.key!.length).toBe(20);
    expect(r2.key).toBeTypeOf('string');
    expect(r2.key!.length).toBe(20);
    // Keys must be distinct.
    expect(r1.key).not.toBe(r2.key);
    // And lex-sortable in mint order — that's the whole point of the
    // push-id format.
    expect(r1.key! < r2.key!).toBe(true);

    // Values landed at the minted paths.
    const snap1 = await r1.get();
    expect(snap1.val()).toEqual({ title: 'first' });
    const snap2 = await r2.get();
    expect(snap2.val()).toEqual({ title: 'second' });
  });

  it('push without a value mints a key but does not write', async () => {
    const sandbox = initializeSandbox();
    const db = getDatabase(sandboxApp(sandbox));
    const listRef = db.ref('/items');
    const r = listRef.push();
    expect(r.key).toBeTypeOf('string');
    // Path is empty — get() should report no value.
    const snap = await r.get();
    expect(snap.exists()).toBe(false);
  });

  it('remove deletes the subtree', async () => {
    const sandbox = initializeSandbox();
    const db = getDatabase(sandboxApp(sandbox));
    const ref = db.ref('/temp');
    await ref.set({ a: 1, b: 2 });
    await ref.remove();
    const snap = await ref.get();
    expect(snap.exists()).toBe(false);
  });

  it('child returns a sub-ref at the joined path', async () => {
    const sandbox = initializeSandbox();
    const db = getDatabase(sandboxApp(sandbox));
    const userRef = db.ref('/users/alice');
    const nameRef = userRef.child('profile/name');
    expect(nameRef.key).toBe('name');
    await nameRef.set('Alice');
    const snap = await db.ref('/users/alice/profile/name').get();
    expect(snap.val()).toBe('Alice');
  });

  it('sandbox.reset() clears the database state', async () => {
    const sandbox = initializeSandbox();
    const db = getDatabase(sandboxApp(sandbox));
    await db.ref('/k').set('v');
    expect((await db.ref('/k').get()).val()).toBe('v');

    sandbox.reset();

    const snap = await db.ref('/k').get();
    expect(snap.exists()).toBe(false);
    expect(snap.val()).toBeNull();
  });

  it('successive getDatabase calls on the same sandbox share data', async () => {
    const sandbox = initializeSandbox();
    const app = sandboxApp(sandbox);
    const db1 = getDatabase(app);
    const db2 = getDatabase(app);
    await db1.ref('/shared').set(42);
    const snap = await db2.ref('/shared').get();
    expect(snap.val()).toBe(42);
  });

  it('snapshot forEach iterates children', async () => {
    const sandbox = initializeSandbox();
    const db = getDatabase(sandboxApp(sandbox));
    await db.ref('/letters').set({ a: 1, b: 2, c: 3 });
    const snap = await db.ref('/letters').get();
    const seen: Array<{ key: string | null; val: unknown }> = [];
    snap.forEach((child) => {
      seen.push({ key: child.key, val: child.val() });
    });
    expect(seen).toHaveLength(3);
    expect(seen).toContainEqual({ key: 'a', val: 1 });
    expect(seen).toContainEqual({ key: 'b', val: 2 });
    expect(seen).toContainEqual({ key: 'c', val: 3 });
  });

  it('listeners (on/off) and transactions throw "not implemented"', async () => {
    const sandbox = initializeSandbox();
    const db = getDatabase(sandboxApp(sandbox));
    const ref = db.ref('/x');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => (ref as any).on('value', () => {})).toThrow(/not implemented/);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => (ref as any).transaction(() => 1)).toThrow(/not implemented/);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => (ref as any).onDisconnect()).toThrow(/not implemented/);
  });
});

// ── Prod-dispatch test ───────────────────────────────────────────────

describe('pyric-admin/database — prod dispatch (Phase 3)', () => {
  it('dispatches to firebase-admin/database when handed a prod app', async () => {
    // Mock firebase-admin/database so we can prove the prod branch reaches
    // it without needing real credentials. Re-import the module under
    // test after the mock so it binds to the mocked exports.
    const sentinel = { __sentinel: 'prod-database-handle' };
    const getDatabaseMock = mock(() => sentinel);
    const getDatabaseWithUrlMock = mock(() => sentinel);

    mock.module('firebase-admin/database', () => ({
      getDatabase: getDatabaseMock,
      getDatabaseWithUrl: getDatabaseWithUrlMock,
    }));

    const { getDatabase: getDatabaseUnderTest } = await import(
      `./index.js?prod-no-url=${Date.now()}`
    );

    const fakeAdminApp = { name: '[DEFAULT]', options: { projectId: 'test' } };
    const app = {
      [ADMIN_APP_TARGET]: 'prod' as const,
      adminApp: fakeAdminApp,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any as PyricAdminApp;
    const out = getDatabaseUnderTest(app);

    expect(out).toBe(sentinel);
    expect(getDatabaseMock).toHaveBeenCalledTimes(1);
    expect(getDatabaseMock).toHaveBeenCalledWith(fakeAdminApp);
    expect(getDatabaseWithUrlMock).toHaveBeenCalledTimes(0);
  });

  it('dispatches to firebase-admin/database `getDatabaseWithUrl` when a URL is supplied', async () => {
    const sentinel = { __sentinel: 'prod-database-handle-url' };
    const getDatabaseMock = mock(() => sentinel);
    const getDatabaseWithUrlMock = mock(() => sentinel);

    mock.module('firebase-admin/database', () => ({
      getDatabase: getDatabaseMock,
      getDatabaseWithUrl: getDatabaseWithUrlMock,
    }));

    const { getDatabase: getDatabaseUnderTest } = await import(
      `./index.js?prod-with-url=${Date.now()}`
    );

    const fakeAdminApp = { name: '[DEFAULT]', options: { projectId: 'test' } };
    const app = {
      [ADMIN_APP_TARGET]: 'prod' as const,
      adminApp: fakeAdminApp,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any as PyricAdminApp;
    const url = 'https://test-default-rtdb.firebaseio.com';
    const out = getDatabaseUnderTest(app, url);

    expect(out).toBe(sentinel);
    expect(getDatabaseWithUrlMock).toHaveBeenCalledTimes(1);
    // firebase-admin's signature is `getDatabaseWithUrl(url, app)` —
    // assert the order matches.
    expect(getDatabaseWithUrlMock).toHaveBeenCalledWith(url, fakeAdminApp);
    expect(getDatabaseMock).toHaveBeenCalledTimes(0);
  });
});
