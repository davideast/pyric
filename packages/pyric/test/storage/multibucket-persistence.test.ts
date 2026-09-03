/**
 * Regression test suite for Finding 4 (P2):
 * Cloud Storage Multi-Bucket Persistence Isolation & Composite Keying.
 *
 * Captures the defect scenario from `tmp/findings-evidence/prove-findings.test.ts`:
 * Prior to the fix, persistence layers (IdbStorageBackend and InMemoryStorageBackend)
 * keyed objects solely by `fullPath: string` without bucket qualification, causing
 * objects in different buckets with identical paths to overwrite each other.
 *
 * With composite keying (`${bucket}/${fullPath}`) and bucket-scoped backends:
 * - Distinct buckets maintain completely isolated object namespaces.
 * - Same-path files in different buckets preserve both blobs and metadata independently.
 * - Mutations (put, updateMetadata, delete, listByPrefix) are strictly isolated per bucket.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  openStorageBackend,
  toStorageKey,
  parseStorageKey,
  InMemoryStorageBackend,
  type StoredMetadata,
} from '../../src/storage/persistence.js';
import {
  getStorageSandbox,
  targetOf,
} from '../../src/storage/service.js';
import { ref } from '../../src/storage/reference.js';
import { uploadBytes } from '../../src/storage/upload.js';
import { getBlob, getBytes, deleteObject } from '../../src/storage/download.js';
import { getMetadata, updateMetadata } from '../../src/storage/metadata.js';
import { listAll } from '../../src/storage/list.js';

const OPEN_RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} {
      allow read, write: if true;
    }
  }
}`;

function uniqueDbName(label: string): string {
  return `pyric-multibucket-test-${label}-${Math.random().toString(36).slice(2, 10)}`;
}

function makeStoredMetadata(bucket: string, fullPath: string, overrides: Partial<StoredMetadata> = {}): StoredMetadata {
  const name = fullPath.split('/').pop() ?? fullPath;
  return {
    fullPath,
    name,
    bucket,
    generation: '1',
    metageneration: '1',
    timeCreated: new Date().toISOString(),
    updated: new Date().toISOString(),
    size: 10,
    contentType: 'text/plain',
    ...overrides,
  };
}

describe('Multi-Bucket Persistence Layer (Finding 4 Regression)', () => {
  it('toStorageKey and parseStorageKey round-trip correctly', () => {
    const key = toStorageKey('my-bucket', 'documents/2026/report.pdf');
    expect(key).toBe('my-bucket/documents/2026/report.pdf');
    const parsed = parseStorageKey(key);
    expect(parsed).toEqual({
      bucket: 'my-bucket',
      path: 'documents/2026/report.pdf',
    });
    expect(parseStorageKey('invalid-no-slash')).toBeNull();
  });

  it('preserves objects with identical paths across distinct buckets independently (IDB)', async () => {
    const dbName = uniqueDbName('idb-isolation');
    const backend = await openStorageBackend(dbName);

    const blobA = new Blob(['Content for Bucket A']);
    const blobB = new Blob(['Content for Bucket B (different content)']);

    // Write to bucket-a
    await backend.put(
      'documents/report.pdf',
      blobA,
      makeStoredMetadata('bucket-a', 'documents/report.pdf', {
        generation: '101',
        size: blobA.size,
        customMetadata: { org: 'team-a' },
      }),
    );

    // Verify bucket-a object exists
    const metaA1 = await backend.getMetadata('documents/report.pdf', 'bucket-a');
    expect(metaA1).toBeDefined();
    expect(metaA1?.bucket).toBe('bucket-a');
    expect(metaA1?.generation).toBe('101');
    expect(metaA1?.customMetadata?.org).toBe('team-a');

    // Write to bucket-b with the SAME relative path
    await backend.put(
      'documents/report.pdf',
      blobB,
      makeStoredMetadata('bucket-b', 'documents/report.pdf', {
        generation: '202',
        size: blobB.size,
        customMetadata: { org: 'team-b' },
      }),
    );

    // CRITICAL: Bucket A metadata and content must NOT have been overwritten by Bucket B!
    const metaA2 = await backend.getMetadata('documents/report.pdf', 'bucket-a');
    const metaB = await backend.getMetadata('documents/report.pdf', 'bucket-b');

    expect(metaA2?.bucket).toBe('bucket-a');
    expect(metaA2?.generation).toBe('101');
    expect(metaA2?.customMetadata?.org).toBe('team-a');

    expect(metaB?.bucket).toBe('bucket-b');
    expect(metaB?.generation).toBe('202');
    expect(metaB?.customMetadata?.org).toBe('team-b');

    // Blobs must also be independent
    const retrievedBlobA = await backend.getBlob('documents/report.pdf', 'bucket-a');
    const retrievedBlobB = await backend.getBlob('documents/report.pdf', 'bucket-b');

    expect(await retrievedBlobA?.text()).toBe('Content for Bucket A');
    expect(await retrievedBlobB?.text()).toBe('Content for Bucket B (different content)');

    backend.close();
  });

  it('preserves objects with identical paths across distinct buckets independently (InMemory)', async () => {
    const backend = new InMemoryStorageBackend();

    const blobA = new Blob(['Memory A']);
    const blobB = new Blob(['Memory B']);

    await backend.put('file.txt', blobA, makeStoredMetadata('bucket-alpha', 'file.txt', { size: blobA.size }));
    await backend.put('file.txt', blobB, makeStoredMetadata('bucket-beta', 'file.txt', { size: blobB.size }));

    const metaAlpha = await backend.getMetadata('file.txt', 'bucket-alpha');
    const metaBeta = await backend.getMetadata('file.txt', 'bucket-beta');
    expect(metaAlpha?.bucket).toBe('bucket-alpha');
    expect(metaBeta?.bucket).toBe('bucket-beta');

    const contentAlpha = await (await backend.getBlob('file.txt', 'bucket-alpha'))?.text();
    const contentBeta = await (await backend.getBlob('file.txt', 'bucket-beta'))?.text();
    expect(contentAlpha).toBe('Memory A');
    expect(contentBeta).toBe('Memory B');
  });

  it('updateMetadata in one bucket does not mutate metadata in another bucket', async () => {
    const dbName = uniqueDbName('idb-update-meta');
    const backend = await openStorageBackend(dbName);

    await backend.put(
      'data.json',
      new Blob(['{}']),
      makeStoredMetadata('bucket-1', 'data.json', { customMetadata: { status: 'draft' } }),
    );
    await backend.put(
      'data.json',
      new Blob(['{}']),
      makeStoredMetadata('bucket-2', 'data.json', { customMetadata: { status: 'published' } }),
    );

    // Update only bucket-1 metadata
    await backend.putMetadata(
      'data.json',
      makeStoredMetadata('bucket-1', 'data.json', {
        metageneration: '2',
        customMetadata: { status: 'archived' },
      }),
      'bucket-1',
    );

    const meta1 = await backend.getMetadata('data.json', 'bucket-1');
    const meta2 = await backend.getMetadata('data.json', 'bucket-2');

    expect(meta1?.customMetadata?.status).toBe('archived');
    expect(meta2?.customMetadata?.status).toBe('published');

    backend.close();
  });

  it('delete in one bucket does not delete the same path in another bucket', async () => {
    const dbName = uniqueDbName('idb-delete');
    const backend = await openStorageBackend(dbName);

    await backend.put('shared/path.txt', new Blob(['A']), makeStoredMetadata('bucket-a', 'shared/path.txt'));
    await backend.put('shared/path.txt', new Blob(['B']), makeStoredMetadata('bucket-b', 'shared/path.txt'));

    // Delete only from bucket-a
    await backend.delete('shared/path.txt', 'bucket-a');

    expect(await backend.getBlob('shared/path.txt', 'bucket-a')).toBeUndefined();
    expect(await backend.getMetadata('shared/path.txt', 'bucket-a')).toBeUndefined();

    // Bucket B must still exist
    const blobB = await backend.getBlob('shared/path.txt', 'bucket-b');
    const metaB = await backend.getMetadata('shared/path.txt', 'bucket-b');
    expect(blobB).toBeDefined();
    expect(await blobB!.text()).toBe('B');
    expect(metaB?.bucket).toBe('bucket-b');

    backend.close();
  });

  it('listByPrefix isolates results to the queried bucket', async () => {
    const dbName = uniqueDbName('idb-list-prefix');
    const backend = await openStorageBackend(dbName);

    await backend.put('photos/cat.jpg', new Blob([]), makeStoredMetadata('bucket-pets', 'photos/cat.jpg'));
    await backend.put('photos/dog.jpg', new Blob([]), makeStoredMetadata('bucket-pets', 'photos/dog.jpg'));
    await backend.put('photos/car.jpg', new Blob([]), makeStoredMetadata('bucket-vehicles', 'photos/car.jpg'));
    await backend.put('photos/truck.jpg', new Blob([]), makeStoredMetadata('bucket-vehicles', 'photos/truck.jpg'));

    const petPhotos = await backend.listByPrefix('photos/', 'bucket-pets');
    expect(petPhotos.map((m) => m.fullPath).sort()).toEqual(['photos/cat.jpg', 'photos/dog.jpg']);
    expect(petPhotos.every((m) => m.bucket === 'bucket-pets')).toBe(true);

    const vehiclePhotos = await backend.listByPrefix('photos/', 'bucket-vehicles');
    expect(vehiclePhotos.map((m) => m.fullPath).sort()).toEqual(['photos/car.jpg', 'photos/truck.jpg']);
    expect(vehiclePhotos.every((m) => m.bucket === 'bucket-vehicles')).toBe(true);

    backend.close();
  });

  it('reset(bucket) clears only the specified bucket', async () => {
    const dbName = uniqueDbName('idb-reset-bucket');
    const backend = await openStorageBackend(dbName);

    await backend.put('file.txt', new Blob(['A']), makeStoredMetadata('bucket-a', 'file.txt'));
    await backend.put('file.txt', new Blob(['B']), makeStoredMetadata('bucket-b', 'file.txt'));

    // Reset only bucket-a
    await backend.reset('bucket-a');

    expect(await backend.getMetadata('file.txt', 'bucket-a')).toBeUndefined();
    expect(await backend.getBlob('file.txt', 'bucket-a')).toBeUndefined();

    // Bucket B is unaffected
    expect(await backend.getMetadata('file.txt', 'bucket-b')).toBeDefined();
    expect(await (await backend.getBlob('file.txt', 'bucket-b'))?.text()).toBe('B');

    backend.close();
  });
});

describe('High-Level Storage SDK Multi-Bucket Isolation', () => {
  it('uploadBytes, getBlob, getBytes preserve independent data per bucket handle', async () => {
    const sandbox = initializeSandbox({});
    const dbName = uniqueDbName('sdk-isolation');

    // Create two handles for distinct buckets on the same sandbox
    const storageA = getStorageSandbox(sandbox, { bucket: 'assets-a', dbName, rules: OPEN_RULES });
    const storageB = getStorageSandbox(sandbox, { bucket: 'assets-b' });

    expect(targetOf(storageA).bucket).toBe('assets-a');
    expect(targetOf(storageB).bucket).toBe('assets-b');

    const refA = ref(storageA, 'avatar.png');
    const refB = ref(storageB, 'avatar.png');

    expect(refA.toString()).toBe('gs://assets-a/avatar.png');
    expect(refB.toString()).toBe('gs://assets-b/avatar.png');

    const payloadA = new Uint8Array([1, 2, 3, 4]);
    const payloadB = new Uint8Array([9, 8, 7, 6, 5]);

    await uploadBytes(refA, payloadA, { contentType: 'image/png', customMetadata: { from: 'A' } });
    await uploadBytes(refB, payloadB, { contentType: 'image/png', customMetadata: { from: 'B' } });

    // Verify metadata independence
    const metaA = await getMetadata(refA);
    const metaB = await getMetadata(refB);

    expect(metaA.bucket).toBe('assets-a');
    expect(metaA.size).toBe(4);
    expect(metaA.customMetadata?.from).toBe('A');

    expect(metaB.bucket).toBe('assets-b');
    expect(metaB.size).toBe(5);
    expect(metaB.customMetadata?.from).toBe('B');

    // Verify blob & byte content independence
    const bytesA = new Uint8Array(await getBytes(refA));
    const bytesB = new Uint8Array(await getBytes(refB));

    expect(Array.from(bytesA)).toEqual([1, 2, 3, 4]);
    expect(Array.from(bytesB)).toEqual([9, 8, 7, 6, 5]);

    const blobA = await getBlob(refA);
    const blobB = await getBlob(refB);
    expect(blobA.size).toBe(4);
    expect(blobB.size).toBe(5);
  });

  it('updateMetadata on one bucket handle does not alter metadata on another', async () => {
    const sandbox = initializeSandbox({});
    const dbName = uniqueDbName('sdk-update-meta');

    const storageA = getStorageSandbox(sandbox, { bucket: 'prod-bucket', dbName, rules: OPEN_RULES });
    const storageB = getStorageSandbox(sandbox, { bucket: 'staging-bucket' });

    const refA = ref(storageA, 'config.json');
    const refB = ref(storageB, 'config.json');

    await uploadBytes(refA, new Blob(['{}']), { customMetadata: { version: '1.0' } });
    await uploadBytes(refB, new Blob(['{}']), { customMetadata: { version: '2.0-beta' } });

    await updateMetadata(refB, { customMetadata: { version: '2.0-rc1' } });

    const readA = await getMetadata(refA);
    const readB = await getMetadata(refB);

    expect(readA.customMetadata?.version).toBe('1.0');
    expect(readB.customMetadata?.version).toBe('2.0-rc1');
  });

  it('deleteObject on one bucket reference leaves other bucket references intact', async () => {
    const sandbox = initializeSandbox({});
    const dbName = uniqueDbName('sdk-delete');

    const storageA = getStorageSandbox(sandbox, { bucket: 'tenant-1', dbName, rules: OPEN_RULES });
    const storageB = getStorageSandbox(sandbox, { bucket: 'tenant-2' });

    const refA = ref(storageA, 'secret.key');
    const refB = ref(storageB, 'secret.key');

    await uploadBytes(refA, new Blob(['KEY_1']));
    await uploadBytes(refB, new Blob(['KEY_2']));

    await deleteObject(refA);

    // Reading refA must fail with object-not-found
    let errA: unknown;
    try {
      await getBytes(refA);
    } catch (e) {
      errA = e;
    }
    expect(errA).toBeDefined();

    // Reading refB must succeed
    const bytesB = await getBytes(refB);
    expect(new TextDecoder().decode(bytesB)).toBe('KEY_2');
  });

  it('listAll partitions results by bucket reference', async () => {
    const sandbox = initializeSandbox({});
    const dbName = uniqueDbName('sdk-list');

    const storage1 = getStorageSandbox(sandbox, { bucket: 'bucket-one', dbName, rules: OPEN_RULES });
    const storage2 = getStorageSandbox(sandbox, { bucket: 'bucket-two' });

    await uploadBytes(ref(storage1, 'docs/d1.pdf'), new Blob(['1']));
    await uploadBytes(ref(storage1, 'docs/d2.pdf'), new Blob(['2']));
    await uploadBytes(ref(storage1, 'images/i1.png'), new Blob(['3']));

    await uploadBytes(ref(storage2, 'docs/other.pdf'), new Blob(['4']));
    await uploadBytes(ref(storage2, 'files/f1.zip'), new Blob(['5']));

    const list1 = await listAll(ref(storage1));
    const list2 = await listAll(ref(storage2));

    // Prefixes and items for storage1
    expect(list1.prefixes.map((p) => p.fullPath).sort()).toEqual(['docs', 'images']);
    expect(list1.prefixes.every((p) => p.bucket === 'bucket-one')).toBe(true);

    // Prefixes and items for storage2
    expect(list2.prefixes.map((p) => p.fullPath).sort()).toEqual(['docs', 'files']);
    expect(list2.prefixes.every((p) => p.bucket === 'bucket-two')).toBe(true);

    // Scan inside docs/ folder for each bucket
    const docs1 = await listAll(ref(storage1, 'docs'));
    expect(docs1.items.map((i) => i.fullPath).sort()).toEqual(['docs/d1.pdf', 'docs/d2.pdf']);
    expect(docs1.items.every((i) => i.bucket === 'bucket-one')).toBe(true);

    const docs2 = await listAll(ref(storage2, 'docs'));
    expect(docs2.items.map((i) => i.fullPath)).toEqual(['docs/other.pdf']);
    expect(docs2.items[0].bucket).toBe('bucket-two');
  });
});
