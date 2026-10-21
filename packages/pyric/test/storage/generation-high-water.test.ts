/**
 * Generation high-water marks kept by the backend (issue #1160).
 *
 * The backend issues each write's generation inside the write's own
 * transaction, above both the generation stored at the path and the highest
 * generation ever stored there, a mark that survives deletes, resets, reopens
 * and restores. So two sandboxes sharing one store, or a reopened store
 * restored to an earlier snapshot, never repeat a generation.
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
import { getStorageSandbox, ref, uploadBytes, type FirebaseStorage } from '../../src/storage/index.js';
import { resetStorageState, restoreStorageState, snapshotStorageState } from '../../src/storage/internal.js';

const OPEN_RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} {
      allow read, write: if true;
    }
  }
}`;

const FIXED_AT = Date.UTC(2030, 0, 1);
const PATH = 'media/clip.bin';
const BUCKET = 'pyric-default';

const uniqueName = (): string => `pyric-storage-high-water-${Math.random().toString(36).slice(2, 10)}`;

/** A fresh sandbox on the store `dbName`, its clock fixed. */
function frozenStorage(dbName: string): FirebaseStorage {
  const sandbox = initializeSandbox({});
  getClock(sandbox).set(FIXED_AT);
  return getStorageSandbox(sandbox, { dbName, rules: OPEN_RULES });
}

async function write(storage: FirebaseStorage, body: string): Promise<bigint> {
  const result = await uploadBytes(ref(storage, PATH), new Blob([body]));
  return BigInt(result.metadata.generation);
}

describe('generations across sandboxes and reopens on IndexedDB', () => {
  it('differ for two sandboxes on one store writing one path concurrently', async () => {
    const dbName = uniqueName();
    const [a, b] = [frozenStorage(dbName), frozenStorage(dbName)];
    const generations = await Promise.all([write(a, 'a'), write(b, 'b'), write(a, 'c'), write(b, 'd')]);
    expect(new Set(generations).size).toBe(4);
  });

  it('stay above every earlier one after a reopen and a restore to an earlier snapshot', async () => {
    const dbName = uniqueName();
    const before = frozenStorage(dbName);
    await write(before, 'a');
    const earlier = await snapshotStorageState(before);
    const later = await write(before, 'b');
    const reopened = frozenStorage(dbName);
    await restoreStorageState(reopened, earlier);
    expect(await write(reopened, 'c')).toBeGreaterThan(later);
  });

  it('stay above every earlier one after a reset', async () => {
    const storage = frozenStorage(uniqueName());
    const first = await write(storage, 'a');
    await resetStorageState(storage);
    expect(await write(frozenStorage(uniqueName()), 'x')).toBe(BigInt(FIXED_AT * 1000));
    expect(await write(storage, 'b')).toBeGreaterThan(first);
  });
});

describe('a version-1 IndexedDB store', () => {
  async function versionOneStore(dbName: string, generation: string): Promise<void> {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(dbName, 1);
      request.addEventListener('upgradeneeded', () => {
        request.result.createObjectStore('blobs');
        request.result.createObjectStore('metadata');
      });
      request.addEventListener('success', () => resolve(request.result));
      request.addEventListener('error', () => reject(request.error));
    });
    const key = `${BUCKET}/${PATH}`;
    const tx = db.transaction(['blobs', 'metadata'], 'readwrite');
    tx.objectStore('blobs').put(new Blob(['old']), key);
    tx.objectStore('metadata').put({ ...metadataFor(generation, 3) }, key);
    await new Promise<void>((resolve, reject) => {
      tx.addEventListener('complete', () => resolve());
      tx.addEventListener('error', () => reject(tx.error));
    });
    db.close();
  }

  it('upgrades in place, keeps its objects, and issues above their generations', async () => {
    const dbName = uniqueName();
    const stored = String(FIXED_AT * 1000 + 7);
    await versionOneStore(dbName, stored);
    const backend = await openStorageBackend(dbName, BUCKET);
    expect(backend).toBeInstanceOf((await import('../../src/storage/persistence.js')).IndexedDbStorageBackend);
    expect(await (await backend.getBlob(PATH, BUCKET))?.text()).toBe('old');
    backend.close();
    expect(await write(frozenStorage(dbName), 'new')).toBe(BigInt(stored) + 1n);
  });
});

function metadataFor(generation: string, size: number): StoredMetadata {
  return {
    fullPath: PATH, name: 'clip.bin', bucket: BUCKET, generation, metageneration: '1',
    timeCreated: '2030-01-01T00:00:00.000Z', updated: '2030-01-01T00:00:00.000Z', size,
    contentType: 'application/octet-stream',
  };
}

const BACKENDS: Array<[string, () => Promise<StorageBackend>]> = [
  ['in-memory', async () => new InMemoryStorageBackend(BUCKET)],
  ['IndexedDB', () => openStorageBackend(uniqueName(), BUCKET)],
  ['scoped', async () => new ScopedStorageBackend(await openStorageBackend(uniqueName(), BUCKET), BUCKET)],
];

describe.each(BACKENDS)('the generation issuer, %s backend', (_name, open) => {
  const issueAbove = (floor: string | undefined): string => String(BigInt(floor ?? '0') + 1n);

  it('is given the stored generation and issues the one the write stores', async () => {
    const backend = await open();
    await backend.put(PATH, new Blob(['a']), metadataFor('5', 1));
    const metadata = metadataFor('0', 1);
    await backend.put(PATH, new Blob(['b']), metadata, issueAbove);
    expect(metadata.generation).toBe('6');
    expect((await backend.getMetadata(PATH, BUCKET))?.generation).toBe('6');
  });

  it('is given the highest generation ever stored at the path, after a delete and a reset', async () => {
    const backend = await open();
    await backend.put(PATH, new Blob(['a']), metadataFor('9', 1));
    await backend.delete(PATH, BUCKET);
    const afterDelete = metadataFor('0', 1);
    await backend.put(PATH, new Blob(['b']), afterDelete, issueAbove);
    expect(afterDelete.generation).toBe('10');
    await backend.reset(BUCKET);
    const afterReset = metadataFor('0', 1);
    await backend.put(PATH, new Blob(['c']), afterReset, issueAbove);
    expect(afterReset.generation).toBe('11');
  });

  it('does not lower the mark when an earlier version is restored', async () => {
    const backend = await open();
    await backend.put(PATH, new Blob(['a']), metadataFor('3', 1));
    await backend.put(PATH, new Blob(['b']), metadataFor('8', 1));
    await backend.put(PATH, new Blob(['a']), metadataFor('3', 1));
    const next = metadataFor('0', 1);
    await backend.put(PATH, new Blob(['c']), next, issueAbove);
    expect(next.generation).toBe('9');
  });

  it('issues distinct generations for concurrent writes', async () => {
    const backend = await open();
    const writes = [metadataFor('0', 1), metadataFor('0', 1), metadataFor('0', 1)];
    await Promise.all(writes.map((metadata) => backend.put(PATH, new Blob(['x']), metadata, issueAbove)));
    expect(writes.map((metadata) => metadata.generation).sort()).toEqual(['1', '2', '3']);
  });
});
