/**
 * Ledger A3: the shared restore path keeps every readable document when one
 * document in a bucket is malformed. The malformed document is skipped and
 * reported; restore does not reject and does not drop the readable ones.
 *
 * The bucket checksum is recomputed over the malformed content so the
 * checksum quarantine branch does not hide the per-document behavior.
 */
import { describe, expect, it } from 'bun:test';
import { createMemoryBackend, initializeSandbox } from '../../../../src/sandbox/index.js';
import { checksumDocs, serializeToBuckets } from '../../../../src/sandbox/persistence/chunk-format.js';

async function seedWithMalformedDocument(key: string) {
  const backend = createMemoryBackend();
  const records = serializeToBuckets(
    { 'notes/good': { title: 'kept' }, 'notes/bad': { title: 'replaced' } },
    {},
    0,
  );
  let replaced = false;
  for (const [id, record] of records) {
    const bucket = record as { docs?: Record<string, unknown>; checksum?: number };
    const holdsBad = bucket.docs !== undefined && 'notes/bad' in bucket.docs;
    if (!holdsBad) continue;
    bucket.docs['notes/bad'] = 'not-a-document';
    bucket.checksum = checksumDocs(bucket.docs);
    records.set(id, bucket);
    replaced = true;
  }
  expect(replaced).toBe(true);
  await backend.putRecords(key, records);
  return backend;
}

describe('ledger A3: restore keeps readable documents beside a malformed one', () => {
  it('restores the readable document, skips the malformed one, and does not reject', async () => {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
    try {
      const backend = await seedWithMalformedDocument('pyric:ledger-a3');
      const sandbox = initializeSandbox();
      await sandbox.enablePersistence({ key: 'pyric:ledger-a3', injectedBackend: backend });
      expect(sandbox.admin.getDocument('notes/good')).toEqual({ title: 'kept' });
      expect(sandbox.admin.getDocument('notes/bad')).toBeNull();
      expect(warnings.some((line) => line.includes('notes/bad'))).toBe(true);
    } finally {
      console.warn = original;
    }
  });
});
