/**
 * Reading a bucket out and writing it back: the walk every part of the surface
 * that saves or replaces sandbox state shares.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { getAdminStorageSandbox, getStorageService } from 'pyric/storage/internal';
import { getMetadata, ref as storageRef, uploadBytes } from 'pyric/storage';

import {
  FIXTURE_EXPORT_DOCUMENT,
  exportStorage,
  listStoredPaths,
  restoreStorage,
  toCustomMetadata,
} from '../../../src/bridge/surface/storage-state.js';

const BYTES = Uint8Array.from(Buffer.from('report body', 'utf8'));

let nextBucket = 0;

/**
 * A storage handle on its own bucket. Storage durability is keyed by database
 * name rather than by sandbox, so two sandboxes in one process share a bucket
 * unless each names its own; a test that counts objects has to.
 */
function isolatedBucket() {
  nextBucket += 1;
  return getAdminStorageSandbox(initializeSandbox(), {
    dbName: `pyric-storage-state-test:${nextBucket}`,
  });
}

/** A bucket holding two objects, one of them under a prefix. */
async function seededBucket() {
  const storage = isolatedBucket();
  await uploadBytes(storageRef(storage, 'top.txt'), BYTES, {
    contentType: 'text/plain',
    cacheControl: 'public, max-age=3600',
    contentDisposition: 'inline; filename="top.txt"',
    contentEncoding: 'gzip',
    contentLanguage: 'en-US',
    customMetadata: { author: 'alice' },
  });
  await uploadBytes(storageRef(storage, 'nested/deeper/report.txt'), BYTES, {
    contentType: 'text/plain',
  });
  return storage;
}

describe('listStoredPaths', () => {
  it('descends into every prefix, and sorts what it finds', async () => {
    expect(await listStoredPaths(await seededBucket())).toEqual([
      'nested/deeper/report.txt',
      'top.txt',
    ]);
  });
});

describe('exportStorage / restoreStorage', () => {
  it('carries the bytes, the content type, and the custom metadata across buckets', async () => {
    const records = await exportStorage(await seededBucket(), FIXTURE_EXPORT_DOCUMENT);
    const target = isolatedBucket();
    expect(await restoreStorage(target, records)).toBe(2);

    const restored = await exportStorage(target, FIXTURE_EXPORT_DOCUMENT);
    expect(restored).toEqual(records);
    const top = restored.find((record) => record.path === 'top.txt');
    expect(top?.contentType).toBe('text/plain');
    expect(top?.cacheControl).toBe('public, max-age=3600');
    expect(top?.contentDisposition).toBe('inline; filename="top.txt"');
    expect(top?.contentEncoding).toBe('gzip');
    expect(top?.contentLanguage).toBe('en-US');
    expect(top?.metadata).toEqual({ author: 'alice' });

    const topMeta = await getMetadata(storageRef(target, 'top.txt'));
    expect(topMeta.cacheControl).toBe('public, max-age=3600');
    expect(topMeta.contentDisposition).toBe('inline; filename="top.txt"');
    expect(topMeta.contentEncoding).toBe('gzip');
    expect(topMeta.contentLanguage).toBe('en-US');
  });

  it('pairs each record with the metadata of the write its bytes came from', async () => {
    const storage = isolatedBucket();
    await uploadBytes(storageRef(storage, 'race.txt'), Uint8Array.from([1, 1, 1]), {
      contentType: 'text/plain',
      customMetadata: { write: 'first' },
    });
    // An overwrite with new bytes, content type, and custom metadata completes
    // at the export's first read of the object, before or after its metadata,
    // whichever the export reads first.
    const backend = (await getStorageService(storage)).backend;
    const readMetadata = backend.getMetadata.bind(backend);
    const readObject = backend.getObject.bind(backend);
    let armed = true;
    const overwrite = async (): Promise<void> => {
      if (!armed) return;
      armed = false;
      const stored = await readMetadata('race.txt');
      if (stored === undefined) throw new Error('race.txt was not stored');
      await backend.put('race.txt', new Blob([Uint8Array.from([2, 2, 2, 2])], { type: 'application/json' }), {
        ...stored,
        size: 4,
        contentType: 'application/json',
        customMetadata: { write: 'second' },
        generation: String(Number(stored.generation) + 1),
      });
    };
    backend.getMetadata = async (path, bucket) => {
      const stored = await readMetadata(path, bucket);
      if (path === 'race.txt') await overwrite();
      return stored;
    };
    backend.getObject = async (path, bucket) => {
      if (path === 'race.txt') await overwrite();
      return readObject(path, bucket);
    };

    const [record] = await exportStorage(storage, FIXTURE_EXPORT_DOCUMENT);
    const bytes = [...Buffer.from(record?.contentBase64 ?? '', 'base64')];
    const write = bytes[0] === 2 ? 'second' : 'first';
    expect(record?.metadata).toEqual({ write });
    expect(record?.contentType).toBe(write === 'second' ? 'application/json' : 'text/plain');
  });
});

describe('toCustomMetadata', () => {
  it('keeps the string entries and reports none when there are none', () => {
    expect(toCustomMetadata({ author: 'alice', size: 12 })).toEqual({ author: 'alice' });
    expect(toCustomMetadata({ size: 12 })).toBeNull();
    expect(toCustomMetadata({})).toBeNull();
  });
});
