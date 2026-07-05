/**
 * Slice 7 — `listAll`.
 *
 * Verifies:
 *   - Direct children land in `items`, sub-folders in `prefixes`
 *   - Folder prefixes deduplicate (many files in one folder → one
 *     prefix entry)
 *   - Items sorted by path (IDB key order)
 *   - Prefixes sorted by path (lexicographic, for determinism)
 *   - listAll on the root scans the entire bucket
 *   - Empty results from an empty bucket / non-matching prefix
 *   - The scanned ref itself is NEVER included
 *   - Sub-folder traversal: listAll(sub) gets sub's children, not
 *     grandchildren-as-items
 */
import 'fake-indexeddb/auto';
import { describe, it, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { getStorageSandbox, ref, uploadBytes, listAll } from '../../src/storage/index.js';

function uniqueDbName(label: string): string {
  return `pyric-storage-test-${label}-${Math.random().toString(36).slice(2, 10)}`;
}

function freshStorage(label: string) {
  const sandbox = initializeSandbox({});
  return getStorageSandbox(sandbox, { dbName: uniqueDbName(label) });
}

describe('listAll', () => {
  it('returns empty arrays on an empty bucket', async () => {
    const storage = freshStorage('list-empty');
    const result = await listAll(ref(storage));
    expect(result.items).toEqual([]);
    expect(result.prefixes).toEqual([]);
    expect(result.nextPageToken).toBeUndefined();
  });

  it('lists direct children of a folder', async () => {
    const storage = freshStorage('list-flat');
    await uploadBytes(ref(storage, 'sessions/s1.json'), new Blob(['{}']));
    await uploadBytes(ref(storage, 'sessions/s2.json'), new Blob(['{}']));
    await uploadBytes(ref(storage, 'sessions/s3.json'), new Blob(['{}']));

    const result = await listAll(ref(storage, 'sessions'));
    expect(result.items.map((r) => r.fullPath)).toEqual([
      'sessions/s1.json',
      'sessions/s2.json',
      'sessions/s3.json',
    ]);
    expect(result.prefixes).toEqual([]);
  });

  it('promotes sub-folders into prefixes (deduplicated)', async () => {
    const storage = freshStorage('list-folders');
    await uploadBytes(ref(storage, 'sessions/2024/s1.json'), new Blob(['{}']));
    await uploadBytes(ref(storage, 'sessions/2024/s2.json'), new Blob(['{}']));
    await uploadBytes(ref(storage, 'sessions/2025/s3.json'), new Blob(['{}']));
    await uploadBytes(ref(storage, 'sessions/inline.json'), new Blob(['{}']));

    const result = await listAll(ref(storage, 'sessions'));
    expect(result.items.map((r) => r.fullPath)).toEqual(['sessions/inline.json']);
    expect(result.prefixes.map((r) => r.fullPath)).toEqual([
      'sessions/2024',
      'sessions/2025',
    ]);
  });

  it('listAll on the root scans the entire bucket', async () => {
    const storage = freshStorage('list-root');
    await uploadBytes(ref(storage, 'a.json'), new Blob(['{}']));
    await uploadBytes(ref(storage, 'sessions/s1.json'), new Blob(['{}']));
    await uploadBytes(ref(storage, 'configs/main.json'), new Blob(['{}']));

    const result = await listAll(ref(storage));
    expect(result.items.map((r) => r.fullPath)).toEqual(['a.json']);
    expect(result.prefixes.map((r) => r.fullPath)).toEqual(['configs', 'sessions']);
  });

  it('does not include the scanned ref itself', async () => {
    // Edge case: a file exists exactly at the scanned prefix name
    // (`sessions` as a leaf, not a folder). listAll(ref('sessions'))
    // should NOT include it — listAll lists children, not self.
    const storage = freshStorage('list-not-self');
    await uploadBytes(ref(storage, 'sessions'), new Blob(['leaf']));
    await uploadBytes(ref(storage, 'sessions/s1.json'), new Blob(['child']));

    const result = await listAll(ref(storage, 'sessions'));
    expect(result.items.map((r) => r.fullPath)).toEqual(['sessions/s1.json']);
    expect(result.prefixes).toEqual([]);
  });

  it('does not recurse into grandchildren as items', async () => {
    const storage = freshStorage('list-non-recursive');
    await uploadBytes(ref(storage, 'a/b/c/deep.json'), new Blob(['{}']));

    const result = await listAll(ref(storage, 'a'));
    expect(result.items).toEqual([]);
    expect(result.prefixes.map((r) => r.fullPath)).toEqual(['a/b']);
  });

  it('returns empty when no descendants match the prefix', async () => {
    const storage = freshStorage('list-no-match');
    await uploadBytes(ref(storage, 'other/x.json'), new Blob(['{}']));

    const result = await listAll(ref(storage, 'sessions'));
    expect(result.items).toEqual([]);
    expect(result.prefixes).toEqual([]);
  });

  it('items expose the StorageReference shape (storage + bucket + name)', async () => {
    const storage = freshStorage('list-shape');
    await uploadBytes(ref(storage, 'sessions/s1.json'), new Blob(['{}']));
    const [item] = (await listAll(ref(storage, 'sessions'))).items;
    expect(item.storage).toBe(storage);
    expect(item.bucket).toBe('pyric-default');
    expect(item.name).toBe('s1.json');
    expect(item.parent?.fullPath).toBe('sessions');
  });
});
