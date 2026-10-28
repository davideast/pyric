/**
 * Generation-checked backend writes (issue #1160, review of #1163).
 *
 * A rollback deletes or restores an object only while it is still the version
 * the rolled-back write made. `deleteIfGeneration` and `replaceIfGeneration`
 * check and write in one transaction, so a write that lands in between is never
 * removed, and `put` returns the object it replaced from that same transaction,
 * so the rollback restores what was really there.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { getClock } from 'pyric/sandbox/internal';
import {
  InMemoryStorageBackend,
  openStorageBackend,
  ScopedStorageBackend,
  type StorageBackend,
  type StoredMetadata,
} from '../../src/storage/persistence.js';
import { getBytes, getStorageSandbox, ref, type FirebaseStorage } from '../../src/storage/index.js';
import { getStorageService, uploadObjectReplacing } from '../../src/storage/internal.js';

const PATH = 'media/clip.bin';
const BUCKET = 'pyric-default';

function metadataFor(generation: string, size: number): StoredMetadata {
  return {
    fullPath: PATH, name: 'clip.bin', bucket: BUCKET, generation, metageneration: '1',
    timeCreated: '2030-01-01T00:00:00.000Z', updated: '2030-01-01T00:00:00.000Z', size,
    contentType: 'application/octet-stream',
  };
}

function bytes(...values: number[]): Blob {
  return new Blob([new Uint8Array(values)], { type: 'application/octet-stream' });
}

async function bytesAt(backend: StorageBackend): Promise<number[] | undefined> {
  const object = await backend.getObject(PATH, BUCKET);
  if (object === undefined) return undefined;
  return [...new Uint8Array(await object.blob.arrayBuffer())];
}

const uniqueName = (): string => `pyric-storage-conditional-${Math.random().toString(36).slice(2, 10)}`;

const BACKENDS: Array<[string, () => Promise<StorageBackend>]> = [
  ['in-memory', async () => new InMemoryStorageBackend(BUCKET)],
  ['IndexedDB', () => openStorageBackend(uniqueName(), BUCKET)],
  ['scoped', async () => new ScopedStorageBackend(await openStorageBackend(uniqueName(), BUCKET), BUCKET)],
];

describe.each(BACKENDS)('generation-checked writes, %s backend', (_name, open) => {
  it('put resolves to undefined on an empty path and to the replaced object on an overwrite', async () => {
    const backend = await open();
    expect(await backend.put(PATH, bytes(1, 1), metadataFor('1', 2))).toBeUndefined();
    const replaced = await backend.put(PATH, bytes(2, 2, 2), metadataFor('2', 3));
    expect(replaced?.metadata.generation).toBe('1');
    expect([...new Uint8Array(await replaced!.blob.arrayBuffer())]).toEqual([1, 1]);
  });

  it('deleteIfGeneration deletes only the generation it names', async () => {
    const backend = await open();
    await backend.put(PATH, bytes(1), metadataFor('1', 1));
    expect(await backend.deleteIfGeneration(PATH, '2', BUCKET)).toBe(false);
    expect(await bytesAt(backend)).toEqual([1]);
    expect(await backend.deleteIfGeneration(PATH, '1', BUCKET)).toBe(true);
    expect(await bytesAt(backend)).toBeUndefined();
    expect(await backend.deleteIfGeneration(PATH, '1', BUCKET)).toBe(false);
  });

  it('replaceIfGeneration puts the prior object back only over the generation it names', async () => {
    const backend = await open();
    await backend.put(PATH, bytes(1), metadataFor('1', 1));
    const prior = await backend.put(PATH, bytes(2, 2), metadataFor('2', 2));
    expect(await backend.replaceIfGeneration(PATH, '1', prior, BUCKET)).toBe(false);
    expect(await bytesAt(backend)).toEqual([2, 2]);
    expect(await backend.replaceIfGeneration(PATH, '2', prior, BUCKET)).toBe(true);
    expect(await bytesAt(backend)).toEqual([1]);
    expect((await backend.getMetadata(PATH, BUCKET))?.generation).toBe('1');
  });

  it('replaceIfGeneration with no prior object leaves the path empty', async () => {
    const backend = await open();
    await backend.put(PATH, bytes(1), metadataFor('1', 1));
    expect(await backend.replaceIfGeneration(PATH, '1', undefined, BUCKET)).toBe(true);
    expect(await bytesAt(backend)).toBeUndefined();
  });

  it('refuses to put a prior object back at another bucket or path', async () => {
    const backend = await open();
    await backend.put(PATH, bytes(1), metadataFor('1', 1));
    const elsewhere = { blob: bytes(2), metadata: { ...metadataFor('0', 1), fullPath: 'media/other.bin' } };
    await expect(backend.replaceIfGeneration(PATH, '1', elsewhere, BUCKET)).rejects.toThrow('its own bucket and path');
    expect(await bytesAt(backend)).toEqual([1]);
  });

  it('keeps a write issued while a delete is checking', async () => {
    const backend = await open();
    await backend.put(PATH, bytes(1), metadataFor('1', 1));
    const deleting = backend.deleteIfGeneration(PATH, '1', BUCKET);
    const writing = backend.put(PATH, bytes(5, 5), metadataFor('2', 2));
    await Promise.all([deleting, writing]);
    expect(await bytesAt(backend)).toEqual([5, 5]);
  });

  it('does not delete a write issued before the delete', async () => {
    const backend = await open();
    await backend.put(PATH, bytes(3), metadataFor('3', 1));
    const writing = backend.put(PATH, bytes(4, 4), metadataFor('4', 2));
    const deleting = backend.deleteIfGeneration(PATH, '3', BUCKET);
    await writing;
    expect(await deleting).toBe(false);
    expect(await bytesAt(backend)).toEqual([4, 4]);
  });

  it('gives concurrent writes the objects they each replaced', async () => {
    const backend = await open();
    await backend.put(PATH, bytes(1), metadataFor('1', 1));
    const [first, second] = await Promise.all([
      backend.put(PATH, bytes(2), metadataFor('2', 1)),
      backend.put(PATH, bytes(3), metadataFor('3', 1)),
    ]);
    expect(first?.metadata.generation).toBe('1');
    expect(second?.metadata.generation).toBe('2');
  });

  it('keeps a write issued while a restore is checking', async () => {
    const backend = await open();
    await backend.put(PATH, bytes(1), metadataFor('1', 1));
    const prior = await backend.put(PATH, bytes(2), metadataFor('2', 1));
    const restoring = backend.replaceIfGeneration(PATH, '2', prior, BUCKET);
    const writing = backend.put(PATH, bytes(5, 5), metadataFor('3', 2));
    await Promise.all([restoring, writing]);
    expect(await bytesAt(backend)).toEqual([5, 5]);
  });
});

const OPEN_RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} {
      allow read, write: if true;
    }
  }
}`;

function frozenStorage(): FirebaseStorage {
  const sandbox = initializeSandbox({});
  getClock(sandbox).set(Date.UTC(2030, 0, 1));
  return getStorageSandbox(sandbox, { dbName: uniqueName(), rules: OPEN_RULES });
}

describe('rolling back an upload under a frozen sandbox clock', () => {
  it('does not delete a later upload to the same path', async () => {
    const storage = frozenStorage();
    const target = ref(storage, PATH);
    const cancelled = await uploadObjectReplacing(target, new Uint8Array([1, 1]), undefined);
    await uploadObjectReplacing(target, new Uint8Array([5, 5]), undefined);
    const service = await getStorageService(storage);
    const rolledBack = await service.backend.deleteIfGeneration(PATH, cancelled.result.metadata.generation);
    expect(rolledBack).toBe(false);
    expect([...new Uint8Array(await getBytes(target))]).toEqual([5, 5]);
  });

  it('restores the object the upload replaced', async () => {
    const storage = frozenStorage();
    const target = ref(storage, PATH);
    await uploadObjectReplacing(target, new Uint8Array([1, 1]), undefined);
    const cancelled = await uploadObjectReplacing(target, new Uint8Array([2, 2]), undefined);
    expect(cancelled.replaced).toBeDefined();
    const service = await getStorageService(storage);
    const rolledBack = await service.backend.replaceIfGeneration(PATH, cancelled.result.metadata.generation, cancelled.replaced);
    expect(rolledBack).toBe(true);
    expect([...new Uint8Array(await getBytes(target))]).toEqual([1, 1]);
  });
});
