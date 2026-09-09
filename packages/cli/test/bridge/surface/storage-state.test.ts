/**
 * Reading a bucket out and writing it back: the walk every part of the surface
 * that saves or replaces sandbox state shares.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { getAdminStorageSandbox } from 'pyric/storage/internal';
import { ref as storageRef, uploadBytes } from 'pyric/storage';

import {
  exportStorage,
  listStoredPaths,
  restoreStorage,
  toCustomMetadata,
} from '../../../src/bridge/surface/storage-state.js';

const BYTES = Uint8Array.from(Buffer.from('report body', 'utf8'));

/** A bucket holding two objects, one of them under a prefix. */
async function seededBucket() {
  const storage = getAdminStorageSandbox(initializeSandbox());
  await uploadBytes(storageRef(storage, 'top.txt'), BYTES, {
    contentType: 'text/plain',
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
    const records = await exportStorage(await seededBucket());
    const target = getAdminStorageSandbox(initializeSandbox());
    expect(await restoreStorage(target, records)).toBe(2);

    const restored = await exportStorage(target);
    expect(restored).toEqual(records);
    const top = restored.find((record) => record.path === 'top.txt');
    expect(top?.contentType).toBe('text/plain');
    expect(top?.metadata).toEqual({ author: 'alice' });
  });
});

describe('toCustomMetadata', () => {
  it('keeps the string entries and reports none when there are none', () => {
    expect(toCustomMetadata({ author: 'alice', size: 12 })).toEqual({ author: 'alice' });
    expect(toCustomMetadata({ size: 12 })).toBeNull();
    expect(toCustomMetadata({})).toBeNull();
  });
});
