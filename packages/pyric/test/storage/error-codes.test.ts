/**
 * ST-B1 probe — every sandbox error path must surface a
 * `StorageError`-shaped object whose `.code` is the prefixed
 * `storage/<code>` form, matching upstream `firebase/storage`.
 *
 * Pre-fix these paths threw plain `Error`s with the code only in the
 * MESSAGE — so `err.code` was `undefined` and consumer branching
 * (`if (err.code === 'storage/object-not-found')`) silently failed on
 * the sandbox while working against prod. COMPAT row 105 claimed both
 * expose `.code`; these probes make that true.
 *
 * Upstream confirmation:
 *   clones/firebase-js-sdk/packages/storage/src/implementation/error.ts
 *   — `StorageError.code === prependCode(code) === 'storage/<code>'`.
 * Oracle: storage-rules-denied-error-code.json (`storage/unauthorized`),
 *         storage-delete-missing-throws.json (`storage/object-not-found`).
 */
import 'fake-indexeddb/auto';
import { describe, it, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  getStorageSandbox,
  ref,
  uploadBytes,
  uploadString,
  getBytes,
  getBlob,
  deleteObject,
  getMetadata,
  updateMetadata,
} from '../../src/storage/index.js';

function uniqueDbName(label: string): string {
  return `pyric-storage-errcode-${label}-${Math.random().toString(36).slice(2, 10)}`;
}

function freshStorage(label: string, rules?: string) {
  const sandbox = initializeSandbox({});
  return getStorageSandbox(sandbox, { dbName: uniqueDbName(label), rules });
}

/** Run `fn`, return the thrown error, fail if nothing threw. */
async function caught(fn: () => Promise<unknown>): Promise<{ code?: unknown; name?: string }> {
  try {
    await fn();
  } catch (e) {
    return e as { code?: unknown; name?: string };
  }
  throw new Error('expected the operation to throw, but it resolved');
}

const DENY_ALL = `
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} {
      allow read, write: if false;
    }
  }
}`;

describe('ST-B1 — sandbox errors carry .code === storage/<code>', () => {
  it('object-not-found on getBytes/getBlob of a missing object', async () => {
    const storage = freshStorage('not-found-read');
    const r = ref(storage, 'missing/never.bin');
    const e1 = await caught(() => getBytes(r));
    const e2 = await caught(() => getBlob(r));
    expect(e1.code).toBe('storage/object-not-found');
    expect(e2.code).toBe('storage/object-not-found');
  });

  it('object-not-found on getMetadata/updateMetadata of a missing object', async () => {
    const storage = freshStorage('not-found-md');
    const r = ref(storage, 'missing/never.bin');
    expect((await caught(() => getMetadata(r))).code).toBe('storage/object-not-found');
    expect((await caught(() => updateMetadata(r, {}))).code).toBe('storage/object-not-found');
  });

  it('quota-exceeded when the blob exceeds maxDownloadSizeBytes', async () => {
    const storage = freshStorage('quota');
    const r = ref(storage, 'big/file.bin');
    await uploadBytes(r, new Blob(['x'.repeat(1024)]));
    expect((await caught(() => getBytes(r, 16))).code).toBe('storage/quota-exceeded');
  });

  it('invalid-root-operation on a root reference', async () => {
    const storage = freshStorage('root-op');
    const root = ref(storage);
    expect((await caught(() => uploadBytes(root, new Blob(['x'])))).code).toBe(
      'storage/invalid-root-operation',
    );
    expect((await caught(() => getBytes(root))).code).toBe('storage/invalid-root-operation');
    expect((await caught(() => deleteObject(root))).code).toBe('storage/invalid-root-operation');
    expect((await caught(() => getMetadata(root))).code).toBe('storage/invalid-root-operation');
  });

  it('unauthorized when rules deny the operation', async () => {
    const storage = freshStorage('denied', DENY_ALL);
    const r = ref(storage, 'b/pyric-default/o/sessions/s1.json');
    const e = await caught(() =>
      uploadBytes(r, new Blob(['{}']), { contentType: 'application/json' }),
    );
    expect(e.code).toBe('storage/unauthorized');
  });

  it('invalid-format on an unparseable data_url string', async () => {
    const storage = freshStorage('bad-data-url');
    const r = ref(storage, 'x/y.bin');
    const e = await caught(() => uploadString(r, 'not-a-data-url', 'data_url'));
    expect(e.code).toBe('storage/invalid-format');
  });

  it('invalid-format names the bad format on an unknown uploadString format (ST-B3)', async () => {
    const storage = freshStorage('unknown-format');
    const r = ref(storage, 'x/y.bin');
    // A JS caller can pass a format the StringFormat type rules out.
    // Pre-fix this mis-parsed as `data_url`, so the message misleadingly
    // blamed `data_url`. Now the error names the actual bad format.
    const e = await caught(() =>
      uploadString(r, 'hello', 'base64url' as unknown as 'raw'),
    );
    expect(e.code).toBe('storage/invalid-format');
    expect(String((e as Error).message)).toContain('base64url');
    expect(String((e as Error).message)).toContain('unknown uploadString format');
  });

  it('the prefixed code is also embedded in the message (substring probes still match)', async () => {
    const storage = freshStorage('msg');
    const r = ref(storage, 'missing/x.bin');
    const e = await caught(() => getBytes(r));
    expect(String((e as Error).message)).toContain('storage/object-not-found');
    expect((e as Error).name).toBe('StorageError');
  });
});
