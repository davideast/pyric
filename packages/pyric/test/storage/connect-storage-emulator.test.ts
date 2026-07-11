/**
 * `pyric/storage` — `connectStorageEmulator` honest no-op.
 *
 * Before this change, `connectStorageEmulator` was not exported from
 * `pyric/storage` at all — importing it from an app bundled under
 * pyric would fail at import time, crashing before the app ever ran a
 * read or write. This test asserts it is now importable and is a
 * no-op on a sandbox handle: the sandbox already IS a local emulator,
 * so pointing it at another emulator host is accepted but does
 * nothing observable.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { getStorageSandbox } from '../../src/storage/service.js';
import { connectStorageEmulator, ref, uploadString, getBlob } from '../../src/storage/index.js';

function uniqueDbName(label: string): string {
  return `pyric-storage-test-${label}-${Math.random().toString(36).slice(2, 10)}`;
}

describe('connectStorageEmulator', () => {
  it('is a no-op on a sandbox handle — does not throw', () => {
    const sandbox = initializeSandbox({});
    const storage = getStorageSandbox(sandbox, { dbName: uniqueDbName('emulator-noop') });
    expect(() => connectStorageEmulator(storage, 'localhost', 9199)).not.toThrow();
  });

  it('uploads/reads still work after connectStorageEmulator is called', async () => {
    const sandbox = initializeSandbox({});
    const storage = getStorageSandbox(sandbox, { dbName: uniqueDbName('emulator-still-works') });
    connectStorageEmulator(storage, 'localhost', 9199);
    const r = ref(storage, 'notes/n1.txt');
    await uploadString(r, 'hello');
    const blob = await getBlob(r);
    const text = await blob.text();
    expect(text).toBe('hello');
  });
});
