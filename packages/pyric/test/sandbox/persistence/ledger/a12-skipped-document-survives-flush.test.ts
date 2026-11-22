/**
 * Ledger A12 (#1383): a Firestore document skipped as unreadable during
 * persistence restore must not be silently dropped when its bucket is later
 * flushed for a sibling document write or delete.
 */
import { describe, expect, it } from 'bun:test';
import { getInternalEnv } from '../../../../src/sandbox/internal/sandbox-impl.js';
import { attachPersistence } from '../../../../src/sandbox/persistence/index.js';
import { createMemoryBackend, initializeSandbox } from '../../../../src/sandbox/index.js';
import {
  checksumDocs,
  pathToBucketId,
  serializeToBuckets,
  type BucketRecord,
} from '../../../../src/sandbox/persistence/chunk-format.js';

function findSiblingPathInBucket(targetBucketId: string, prefix: string): string {
  for (let i = 0; i < 10_000; i += 1) {
    const candidate = `${prefix}/doc-${i}`;
    if (pathToBucketId(candidate) === targetBucketId) return candidate;
  }
  throw new Error(`Could not find path in bucket ${targetBucketId}`);
}

function findPathInDifferentBucket(excludedBucketId: string, prefix: string): string {
  for (let i = 0; i < 10_000; i += 1) {
    const candidate = `${prefix}/doc-${i}`;
    if (pathToBucketId(candidate) !== excludedBucketId) return candidate;
  }
  throw new Error(`Could not find path outside bucket ${excludedBucketId}`);
}

describe('ledger A12: skipped restore document survives subsequent bucket flushes', () => {
  it('carries a skipped raw document through sibling updates and sole-document deletes in the same bucket', async () => {
    const goodPath = 'notes/good';
    const bucketId = pathToBucketId(goodPath);
    const badPath = findSiblingPathInBucket(bucketId, 'notes-unreadable');
    const otherBucketPath = findPathInDifferentBucket(bucketId, 'other');
    const rawUnreadableDoc = { __futureMarker: 'unrecognized-v99', payload: [1, 2, 3] };

    const backend = createMemoryBackend();
    const key = 'pyric:ledger-a12';
    const initialRecords = serializeToBuckets(
      { [goodPath]: { title: 'initial' } },
      {},
      0,
    );
    const seededBucket = initialRecords.get(bucketId) as BucketRecord | undefined;
    expect(seededBucket).toBeDefined();
    if (!seededBucket) throw new Error('Expected seeded bucket');
    // Force an unreadable non-object document entry that requireDocumentData rejects on restore.
    (seededBucket.docs as Record<string, unknown>)[badPath] = 'unreadable-raw-record';
    (seededBucket.docs as Record<string, unknown>)[`${badPath}-meta`] = rawUnreadableDoc;
    // Keep only `badPath` as unreadable string so A3/A12 skipInvalidDocuments path triggers cleanly.
    delete (seededBucket.docs as Record<string, unknown>)[`${badPath}-meta`];
    seededBucket.checksum = checksumDocs(seededBucket.docs);
    await backend.putRecords(key, initialRecords);

    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const sandbox = initializeSandbox();
      const persistence = await attachPersistence(sandbox, { key, injectedBackend: backend });

      expect(sandbox.admin.getDocument(goodPath)).toEqual({ title: 'initial' });
      expect(sandbox.admin.getDocument(badPath)).toBeNull();

      // 1. Flushing a different bucket leaves the skipped document's bucket intact.
      sandbox.admin.setDocument(otherBucketPath, { ok: true });
      await persistence.flush();
      const afterOtherBucket = (await backend.getRecord(key, bucketId)) as BucketRecord | null;
      expect(afterOtherBucket?.docs[badPath]).toBe('unreadable-raw-record');

      // 2. Updating a sibling in the SAME bucket preserves the skipped raw document and valid checksum.
      sandbox.admin.setDocument(goodPath, { title: 'updated' });
      await persistence.flush();
      const afterSiblingUpdate = (await backend.getRecord(key, bucketId)) as BucketRecord | null;
      expect(afterSiblingUpdate).not.toBeNull();
      expect(afterSiblingUpdate?.docs[badPath]).toBe('unreadable-raw-record');
      expect(afterSiblingUpdate?.checksum).toBe(checksumDocs(afterSiblingUpdate?.docs ?? {}));

      // 3. Deleting all readable siblings in the SAME bucket keeps the bucket alive for the skipped document.
      sandbox.admin.deleteDocument(goodPath);
      await persistence.flush();
      const afterSiblingDelete = (await backend.getRecord(key, bucketId)) as BucketRecord | null;
      expect(afterSiblingDelete).not.toBeNull();
      expect(afterSiblingDelete?.docs).toEqual({
        [badPath]: 'unreadable-raw-record',
      } as unknown as Record<string, Record<string, unknown>>);
      expect(afterSiblingDelete?.checksum).toBe(checksumDocs(afterSiblingDelete?.docs ?? {}));

      // 4. Re-opening against the same backend still sees the skipped raw document and warns, without corrupting checksums.
      persistence.dispose();
      const reopenedWarnings: string[] = [];
      console.warn = (...args: unknown[]) => {
        reopenedWarnings.push(args.map(String).join(' '));
      };
      const sandbox2 = initializeSandbox();
      const persistence2 = await attachPersistence(sandbox2, { key, injectedBackend: backend });
      expect(reopenedWarnings.some(line => line.includes(badPath))).toBe(true);
      expect(reopenedWarnings.some(line => line.includes('checksum mismatch'))).toBe(false);

      // 5. Explicitly writing a valid document at `badPath` supersedes the retained unreadable record.
      sandbox2.admin.setDocument(badPath, { repaired: true });
      await persistence2.flush();
      const afterRepair = (await backend.getRecord(key, bucketId)) as BucketRecord | null;
      expect(afterRepair?.docs[badPath]).toEqual({ repaired: true });

      persistence2.dispose();
    } finally {
      console.warn = originalWarn;
    }
  });

  it('drops retained skipped documents when explicitly deleted or when sandbox.reset() wipes state', async () => {
    const goodPath = 'notes/good';
    const bucketId = pathToBucketId(goodPath);
    const badPath = findSiblingPathInBucket(bucketId, 'notes-unreadable');

    const backend = createMemoryBackend();
    const key = 'pyric:ledger-a12-reset';
    const initialRecords = serializeToBuckets({ [goodPath]: { title: 'initial' } }, {}, 0);
    const seededBucket = initialRecords.get(bucketId) as BucketRecord;
    (seededBucket.docs as Record<string, unknown>)[badPath] = 'unreadable-raw-record';
    seededBucket.checksum = checksumDocs(seededBucket.docs);
    await backend.putRecords(key, initialRecords);

    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const sandbox = initializeSandbox();
      const persistence = await attachPersistence(sandbox, { key, injectedBackend: backend });
      getInternalEnv(sandbox).execute({
        method: 'delete',
        path: badPath,
        auth: null,
        bypassRules: true,
      });
      await persistence.flush();
      const afterExplicitDelete = (await backend.getRecord(key, bucketId)) as BucketRecord | null;
      expect(afterExplicitDelete?.docs[badPath]).toBeUndefined();
      expect(afterExplicitDelete?.docs[goodPath]).toEqual({ title: 'initial' });

      // Re-seed unreadable doc and verify reset() also clears retained entries.
      (afterExplicitDelete as BucketRecord).docs[badPath] =
        'unreadable-raw-record' as unknown as Record<string, unknown>;
      (afterExplicitDelete as BucketRecord).checksum = checksumDocs(
        (afterExplicitDelete as BucketRecord).docs,
      );
      await backend.putRecords(key, new Map([[bucketId, afterExplicitDelete]]));
      persistence.dispose();

      const sandbox2 = initializeSandbox();
      const persistence2 = await attachPersistence(sandbox2, { key, injectedBackend: backend });
      sandbox2.reset();
      await persistence2.flush();
      expect(await backend.getRecord(key, bucketId)).toBeNull();
      persistence2.dispose();
    } finally {
      console.warn = originalWarn;
    }
  });
});
