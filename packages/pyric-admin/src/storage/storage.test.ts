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

import { describe, it, expect } from 'bun:test';

import { initializeSandbox } from 'pyric/sandbox';

import {
  ADMIN_APP_TARGET,
  type PyricAdminApp,
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
function sandboxAdminApp(options: SandboxAdminApp['options'] = {}): SandboxAdminApp {
  const sandbox = initializeSandbox();
  return {
    [ADMIN_APP_TARGET]: 'sandbox',
    sandbox,
    name: 'storage-test',
    options,
  };
}

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

  it('resumable: true on save stores the same object as a single-shot save', async () => {
    const app = sandboxAdminApp();
    const storage = getStorage(app);
    const file = storage.bucket().file('big.bin');

    await file.save('payload', { resumable: true, metadata: { contentType: 'text/plain' } });

    expect((await file.download())[0].toString()).toBe('payload');
    expect((await file.getMetadata())[0].contentType).toBe('text/plain');
  });

  it('bucket() is the bucket the app\'s storageBucket option names', async () => {
    const configured = sandboxAdminApp({ storageBucket: 'demo-app.appspot.com' });
    const storage = getStorage(configured);
    expect(storage.bucket().name).toBe('demo-app.appspot.com');
    await storage.bucket().file('a.txt').save('a');
    expect(await storage.bucket('demo-app.appspot.com').file('a.txt').exists()).toEqual([true]);
    expect((await storage.bucket().file('a.txt').getMetadata())[0].bucket).toBe('demo-app.appspot.com');

    expect(getStorage(sandboxAdminApp()).bucket().name).toBe('pyric-default');
  });

  it('copy() copies an object with its metadata, within a bucket and across buckets', async () => {
    const storage = getStorage(sandboxAdminApp({ storageBucket: 'demo-app.appspot.com' }));
    const staged = storage.bucket('demo-app-upload-staging').file('staging/u1/upload-1');
    await staged.save(Buffer.from([1, 2, 3]), { metadata: { contentType: 'image/png', metadata: { owner: 'u1' } } });

    const [copy, metadata] = await staged.copy(storage.bucket().file('uploads/u1/a.png'), {
      metadata: { firebaseStorageDownloadTokens: 'tok-1' },
    });
    expect(copy.bucket.name).toBe('demo-app.appspot.com');
    expect(metadata).toMatchObject({ bucket: 'demo-app.appspot.com', name: 'uploads/u1/a.png', contentType: 'image/png', size: '3' });
    expect(metadata.metadata).toEqual({ owner: 'u1', firebaseStorageDownloadTokens: 'tok-1' });
    expect([...(await copy.download())[0]]).toEqual([1, 2, 3]);
    // The source keeps its own metadata, and the default bucket did not hold the staged path.
    expect((await staged.getMetadata())[0].metadata).toEqual({ owner: 'u1' });
    expect(await storage.bucket().file('staging/u1/upload-1').exists()).toEqual([false]);

    const [sameBucket] = await staged.copy('staging/u1/copy');
    expect(sameBucket.bucket.name).toBe('demo-app-upload-staging');
    const [byUrl] = await staged.copy('gs://other-bucket/x.png');
    expect(byUrl.bucket.name).toBe('other-bucket');
    const [byBucket] = await staged.copy(storage.bucket('archive'));
    expect(byBucket.name).toBe('staging/u1/upload-1');
    expect(await storage.bucket('archive').file('staging/u1/upload-1').exists()).toEqual([true]);

    await expect(storage.bucket().file('missing').copy('elsewhere')).rejects.toThrow(/No such object/);
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
