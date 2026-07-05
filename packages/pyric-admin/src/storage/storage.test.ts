/**
 * Tests for `pyric-admin/storage`.
 *
 * Coverage:
 *   - Prod dispatch  → handing a {@link ADMIN_APP_TARGET}: 'prod' app
 *     reaches `firebase-admin/storage`'s `getStorage`. Mocked to stay
 *     hermetic (no GCP credentials, no network).
 *   - Sandbox backend → save/download round-trip, exists/delete,
 *     getSignedUrl shape, multi-bucket isolation, reset clears state.
 */

import { describe, it, expect, mock } from 'bun:test';

import { initializeSandbox } from 'pyric/sandbox';

import {
  ADMIN_APP_TARGET,
  type PyricAdminApp,
  type ProdAdminApp,
  type SandboxAdminApp,
} from '../app/index.js';
import { getStorage } from './index.js';

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Construct a sandbox-shaped `PyricAdminApp` directly. We bypass
 * `initializeApp` so the tests don't accidentally depend on app-level
 * state — the storage backend reads `app.sandbox` and the
 * `ADMIN_APP_TARGET` brand, and that's the only surface that matters
 * here.
 */
function sandboxAdminApp(): SandboxAdminApp {
  const sandbox = initializeSandbox();
  return {
    [ADMIN_APP_TARGET]: 'sandbox',
    sandbox,
  };
}

/** Minimal prod-shaped `PyricAdminApp` — opaque `adminApp` is enough
 *  to verify the dispatch reaches `firebase-admin/storage`. */
function prodAdminApp(): ProdAdminApp {
  return {
    [ADMIN_APP_TARGET]: 'prod',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    adminApp: { name: '[DEFAULT]', options: { projectId: 'test-project' } } as any,
  };
}

// ── Prod dispatch ─────────────────────────────────────────────────────

describe('pyric-admin/storage — prod dispatch', () => {
  it('dispatches to firebase-admin/storage when the app is prod-branded', async () => {
    // Mock firebase-admin/storage so the test stays hermetic. Bun's
    // `mock.module` applies to subsequent imports — re-import the
    // module under test dynamically so it picks up the mock.
    const sentinel = { __sentinel: 'prod-storage-handle' };
    const getStorageMock = mock(() => sentinel);

    mock.module('firebase-admin/storage', () => ({
      getStorage: getStorageMock,
    }));

    const { getStorage: getStorageUnderTest } = await import(
      `./index.js?prod-dispatch=${Date.now()}`
    );

    const app = prodAdminApp();
    const out = getStorageUnderTest(app);

    expect(out).toBe(sentinel);
    expect(getStorageMock).toHaveBeenCalledTimes(1);
    expect(getStorageMock).toHaveBeenCalledWith(app.adminApp);
  });
});

// ── Sandbox backend ───────────────────────────────────────────────────

describe('pyric-admin/storage — sandbox backend', () => {
  it('round-trips a save/download via the default bucket', async () => {
    const app = sandboxAdminApp();
    const storage = getStorage(app);
    const file = storage.bucket().file('hello.txt');

    await file.save('hello world');
    const [downloaded] = await file.download();

    expect(downloaded.toString('utf8')).toBe('hello world');
  });

  it('round-trips Buffer and Uint8Array payloads', async () => {
    const app = sandboxAdminApp();
    const storage = getStorage(app);

    const bufFile = storage.bucket().file('buf.bin');
    await bufFile.save(Buffer.from([1, 2, 3, 4]));
    const [bufOut] = await bufFile.download();
    expect(Array.from(bufOut)).toEqual([1, 2, 3, 4]);

    const u8File = storage.bucket().file('u8.bin');
    await u8File.save(new Uint8Array([9, 8, 7]));
    const [u8Out] = await u8File.download();
    expect(Array.from(u8Out)).toEqual([9, 8, 7]);
  });

  it('copies bytes on save so callers can mutate their input safely', async () => {
    const app = sandboxAdminApp();
    const storage = getStorage(app);
    const file = storage.bucket().file('mut.bin');

    const payload = Buffer.from([1, 2, 3]);
    await file.save(payload);
    payload[0] = 99;

    const [out] = await file.download();
    expect(Array.from(out)).toEqual([1, 2, 3]);
  });

  it('exists() reports the correct presence before and after save', async () => {
    const app = sandboxAdminApp();
    const storage = getStorage(app);
    const file = storage.bucket().file('exists.txt');

    expect(await file.exists()).toEqual([false]);
    await file.save('ok');
    expect(await file.exists()).toEqual([true]);
  });

  it('download() throws on a missing file with a GCS-shaped error message', async () => {
    const app = sandboxAdminApp();
    const storage = getStorage(app);
    const file = storage.bucket('my-bucket').file('missing.bin');

    await expect(file.download()).rejects.toThrow(/No such object: my-bucket\/missing\.bin/);
  });

  it('delete() removes the file and is idempotent on missing paths', async () => {
    const app = sandboxAdminApp();
    const storage = getStorage(app);
    const file = storage.bucket().file('to-delete.txt');

    await file.save('bye');
    expect(await file.exists()).toEqual([true]);

    await file.delete();
    expect(await file.exists()).toEqual([false]);

    // Idempotent — second delete on a missing file must not throw.
    await file.delete();
    expect(await file.exists()).toEqual([false]);
  });

  it('getSignedUrl returns a stub URL with bucket, path, expires, action', async () => {
    const app = sandboxAdminApp();
    const storage = getStorage(app);
    const file = storage.bucket('signed-bucket').file('doc.pdf');
    await file.save('content');

    const [url] = await file.getSignedUrl({
      action: 'read',
      expires: 1_700_000_000_000,
    });

    expect(url).toBe(
      'pyric-sandbox-storage://signed-bucket/doc.pdf?expires=1700000000000&action=read',
    );
  });

  it('getSignedUrl accepts Date and ISO string forms for expires', async () => {
    const app = sandboxAdminApp();
    const storage = getStorage(app);
    const file = storage.bucket().file('any.txt');

    const ms = 1_700_000_000_000;
    const [fromDate] = await file.getSignedUrl({
      action: 'read',
      expires: new Date(ms),
    });
    expect(fromDate).toContain(`expires=${ms}`);

    const [fromIso] = await file.getSignedUrl({
      action: 'write',
      expires: new Date(ms).toISOString(),
    });
    expect(fromIso).toContain(`expires=${ms}`);
    expect(fromIso).toContain('action=write');
  });

  it('isolates state across distinct bucket names', async () => {
    const app = sandboxAdminApp();
    const storage = getStorage(app);

    await storage.bucket('alpha').file('shared.txt').save('A');
    await storage.bucket('beta').file('shared.txt').save('B');

    const [alphaOut] = await storage.bucket('alpha').file('shared.txt').download();
    const [betaOut] = await storage.bucket('beta').file('shared.txt').download();
    expect(alphaOut.toString('utf8')).toBe('A');
    expect(betaOut.toString('utf8')).toBe('B');

    // Cross-bucket lookup of the same path on a third bucket is empty.
    expect(await storage.bucket('gamma').file('shared.txt').exists()).toEqual([false]);
  });

  it('bucket(name) returns handles bound to the same underlying state across calls', async () => {
    const app = sandboxAdminApp();
    const storage = getStorage(app);

    await storage.bucket('persistent').file('x.txt').save('first');

    // A fresh bucket handle for the same name must see the prior save.
    const secondHandle = storage.bucket('persistent').file('x.txt');
    expect(await secondHandle.exists()).toEqual([true]);
    const [out] = await secondHandle.download();
    expect(out.toString('utf8')).toBe('first');
  });

  it('sandbox.reset() clears every bucket', async () => {
    const app = sandboxAdminApp();
    const storage = getStorage(app);

    await storage.bucket('one').file('a.txt').save('A');
    await storage.bucket('two').file('b.txt').save('B');

    expect(await storage.bucket('one').file('a.txt').exists()).toEqual([true]);
    expect(await storage.bucket('two').file('b.txt').exists()).toEqual([true]);

    app.sandbox.reset();

    expect(await storage.bucket('one').file('a.txt').exists()).toEqual([false]);
    expect(await storage.bucket('two').file('b.txt').exists()).toEqual([false]);
  });

  it('resumable: true on save throws the deferred-feature error', async () => {
    const app = sandboxAdminApp();
    const storage = getStorage(app);
    const file = storage.bucket().file('big.bin');

    await expect(file.save('payload', { resumable: true })).rejects.toThrow(
      /not implemented in pyric-admin\/storage sandbox backend/,
    );
  });

  it('stores contentType and metadata payloads alongside the bytes', async () => {
    // The interface doesn't surface metadata reads yet, but the save
    // path must accept the options without error and the bytes must
    // still round-trip correctly. This guards against future code that
    // breaks the option pass-through silently.
    const app = sandboxAdminApp();
    const storage = getStorage(app);
    const file = storage.bucket().file('meta.json');

    await file.save('{"k":1}', {
      contentType: 'application/json',
      metadata: { custom: 'value' },
    });

    const [out] = await file.download();
    expect(out.toString('utf8')).toBe('{"k":1}');
  });
});

// ── Input validation ──────────────────────────────────────────────────

describe('pyric-admin/storage — input validation', () => {
  it('throws a TypeError when handed an object with no ADMIN_APP_TARGET brand', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => getStorage({} as any)).toThrow(TypeError);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => getStorage({} as any)).toThrow(/PyricAdminApp from `initializeApp`/);
  });
});
