/**
 * A Storage state capture records each object's metadata and bytes as one
 * pair, even when the object is overwritten while the capture runs.
 *
 * The overwrite is placed deterministically: the backend's listing is wrapped
 * so the object is overwritten after the listing is read and before the
 * capture reads the object. Each case runs against the in-memory backend and
 * the IndexedDB backend.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { createSandboxRoot } from '../../src/sandbox/internal/index.js';
import { getAdminStorageSandbox, getStorageService, installStorageBackend } from '../../src/storage/service.js';
import {
  DEFAULT_BUCKET,
  InMemoryStorageBackend,
  openStorageBackend,
  type StorageBackend,
  type StoredMetadata,
} from '../../src/storage/persistence.js';
import { restoreStorageState, snapshotStorageState } from '../../src/storage/sandbox/persistence-state.js';
import { ref, uploadBytes } from '../../src/storage/index.js';

const encoder = new TextEncoder();

function bytesOf(base64: string): number {
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0)).byteLength;
}

const backends: Array<[string, () => Promise<StorageBackend>]> = [
  ['in-memory', async () => new InMemoryStorageBackend(DEFAULT_BUCKET)],
  ['IndexedDB', () => openStorageBackend(`pyric-state-test-${crypto.randomUUID()}`, DEFAULT_BUCKET)],
];

async function storageOn(open: () => Promise<StorageBackend>) {
  const sandbox = createSandboxRoot({ mutations: 100, spans: 100 });
  installStorageBackend(sandbox, await open());
  return getAdminStorageSandbox(sandbox);
}

function metadataFor(fullPath: string, size: number): StoredMetadata {
  return {
    fullPath, name: fullPath, bucket: DEFAULT_BUCKET, generation: '1', metageneration: '1',
    timeCreated: '2026-01-01T00:00:00.000Z', updated: '2026-01-01T00:00:00.000Z', size,
  };
}

describe.each(backends)('snapshotStorageState on the %s backend', (_name, open) => {
  it('pairs an object overwritten during the capture with the bytes of the same write', async () => {
    const storage = await storageOn(open);
    const fileRef = ref(storage, 'narrations/test.timings.json');
    await uploadBytes(fileRef, encoder.encode('x'.repeat(1000)));

    const service = await getStorageService(storage);
    const backend = service.backend;
    const listByPrefix = backend.listByPrefix.bind(backend);
    let overwrites = 0;
    backend.listByPrefix = async (prefix, bucket) => {
      const listing = await listByPrefix(prefix, bucket);
      const firstListing = overwrites === 0;
      if (firstListing) {
        overwrites += 1;
        await uploadBytes(fileRef, encoder.encode('x'.repeat(1003)));
      }
      return listing;
    };

    const records = await snapshotStorageState(storage);

    expect(overwrites).toBe(1);
    expect(records).toHaveLength(1);
    const [record] = records;
    expect(bytesOf(record!.dataBase64)).toBe(1003);
    expect(record!.metadata.size).toBe(1003);
  });

  it('omits an object deleted after the listing was read', async () => {
    const storage = await storageOn(open);
    await uploadBytes(ref(storage, 'kept.txt'), encoder.encode('kept'));
    await uploadBytes(ref(storage, 'gone.txt'), encoder.encode('gone'));

    const service = await getStorageService(storage);
    const backend = service.backend;
    const listByPrefix = backend.listByPrefix.bind(backend);
    backend.listByPrefix = async (prefix, bucket) => {
      const listing = await listByPrefix(prefix, bucket);
      await backend.delete('gone.txt');
      return listing;
    };

    const records = await snapshotStorageState(storage);

    expect(records.map((record) => record.metadata.fullPath)).toEqual(['kept.txt']);
  });

  it('refuses to restore a record whose metadata size differs from its bytes', async () => {
    const storage = await storageOn(open);
    await uploadBytes(ref(storage, 'a.txt'), encoder.encode('abc'));
    const [record] = await snapshotStorageState(storage);
    const skewed = { ...record!, metadata: { ...record!.metadata, size: 4 } };

    await expect(restoreStorageState(storage, [skewed])).rejects.toThrow('Storage metadata does not match its object.');
    const [kept] = await snapshotStorageState(storage);
    expect(kept!.metadata.size).toBe(3);
  });
});

describe.each(backends)('the %s backend', (_name, open) => {
  it('rejects a put whose metadata size differs from the content', async () => {
    const backend = await open();

    await expect(backend.put('a.txt', new Blob(['abc']), metadataFor('a.txt', 2))).rejects.toThrow('Storage metadata does not match its object.');
    expect(await backend.getMetadata('a.txt', DEFAULT_BUCKET)).toBeUndefined();
  });

  it('getObject returns the blob and metadata of the same write', async () => {
    const backend = await open();
    await backend.put('a.txt', new Blob(['abc']), metadataFor('a.txt', 3));

    const object = await backend.getObject('a.txt', DEFAULT_BUCKET);

    expect(await object!.blob.text()).toBe('abc');
    expect(object!.metadata.size).toBe(3);
    expect(await backend.getObject('missing.txt', DEFAULT_BUCKET)).toBeUndefined();
  });
});
