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
import {
  deleteObject,
  getStorageSandbox,
  list,
  listAll,
  ref,
  StorageError,
  uploadBytes,
} from '../../src/storage/index.js';

const OPEN_RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} {
      allow read, write: if true;
    }
  }
}`;

function uniqueDbName(label: string): string {
  return `pyric-storage-test-${label}-${Math.random().toString(36).slice(2, 10)}`;
}

function freshStorage(label: string) {
  const sandbox = initializeSandbox({});
  return getStorageSandbox(sandbox, { dbName: uniqueDbName(label), rules: OPEN_RULES });
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

async function captureStorageError(fn: () => Promise<unknown>): Promise<StorageError> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof StorageError) {
      return err;
    }
    throw new Error(`Expected StorageError, got ${String(err)}`);
  }
  throw new Error('Expected operation to reject with StorageError');
}

describe('list (paginated)', () => {
  it('paginates mixed items and rolled-up prefixes in UTF-8 delimiter order without trailing empty page', async () => {
    const storage = freshStorage('list-paginated-mixed');
    const uploads = [
      'dir/foo/leaf.txt',
      'dir/foo-bar',
      'dir/alpha.txt',
      'dir/beta/one.txt',
      'dir/beta/two.txt',
      'dir/zeta.txt',
    ];
    for (const path of uploads) {
      await uploadBytes(ref(storage, path), new Blob(['x']));
    }
    const dirRef = ref(storage, 'dir');

    // Exact multiple boundary: 5 distinct entries -> pages of 2, 2, 1.
    // Order: 'dir/alpha.txt', 'dir/beta/', 'dir/foo-bar', 'dir/foo/', 'dir/zeta.txt'.
    const page1 = await list(dirRef, { maxResults: 2 });
    expect(page1.items.map((r) => r.name)).toEqual(['alpha.txt']);
    expect(page1.prefixes.map((r) => r.name)).toEqual(['beta']);
    expect(typeof page1.nextPageToken).toBe('string');

    const page2 = await list(dirRef, { maxResults: 2, pageToken: page1.nextPageToken });
    expect(page2.items.map((r) => r.name)).toEqual(['foo-bar']);
    expect(page2.prefixes.map((r) => r.name)).toEqual(['foo']);
    expect(typeof page2.nextPageToken).toBe('string');

    const page3 = await list(dirRef, { maxResults: 2, pageToken: page2.nextPageToken });
    expect(page3.items.map((r) => r.name)).toEqual(['zeta.txt']);
    expect(page3.prefixes).toEqual([]);
    expect(page3.nextPageToken).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(page3, 'nextPageToken')).toBe(false);

    // Exact page size equal to total entry count omits nextPageToken immediately.
    const exactPage = await list(dirRef, { maxResults: 5 });
    expect(exactPage.items.map((r) => r.name)).toEqual(['alpha.txt', 'foo-bar', 'zeta.txt']);
    expect(exactPage.prefixes.map((r) => r.name)).toEqual(['beta', 'foo']);
    expect(Object.prototype.hasOwnProperty.call(exactPage, 'nextPageToken')).toBe(false);

    // Default options (omitted / null / empty pageToken) return up to 1000 entries.
    const defaultPage = await list(dirRef);
    expect(defaultPage.items.length + defaultPage.prefixes.length).toBe(5);
    expect(Object.prototype.hasOwnProperty.call(defaultPage, 'nextPageToken')).toBe(false);

    const nullOptionsPage = await list(dirRef, { maxResults: null, pageToken: null });
    expect(nullOptionsPage.items.length + nullOptionsPage.prefixes.length).toBe(5);
    const emptyTokenPage = await list(dirRef, { maxResults: 1000, pageToken: '' });
    expect(emptyTokenPage.items.length + emptyTokenPage.prefixes.length).toBe(5);
  });

  it('uses a key-based cursor resilient to deletions before the cursor', async () => {
    const storage = freshStorage('list-cursor-delete');
    for (const name of ['a.txt', 'b.txt', 'c.txt', 'd.txt']) {
      await uploadBytes(ref(storage, `items/${name}`), new Blob([name]));
    }
    const itemsRef = ref(storage, 'items');
    const first = await list(itemsRef, { maxResults: 2 });
    expect(first.items.map((r) => r.name)).toEqual(['a.txt', 'b.txt']);
    expect(first.nextPageToken).toBeDefined();

    await deleteObject(ref(storage, 'items/a.txt'));
    await deleteObject(ref(storage, 'items/b.txt'));

    const second = await list(itemsRef, { maxResults: 2, pageToken: first.nextPageToken });
    expect(second.items.map((r) => r.name)).toEqual(['c.txt', 'd.txt']);
    expect(Object.prototype.hasOwnProperty.call(second, 'nextPageToken')).toBe(false);
  });

  it('defaults maxResults to 1000 when more than 1000 objects exist', async () => {
    const storage = freshStorage('list-default-1000');
    const uploads: Array<Promise<unknown>> = [];
    for (let i = 0; i < 1005; i++) {
      const padded = String(i).padStart(4, '0');
      uploads.push(uploadBytes(ref(storage, `many/f-${padded}.txt`), new Blob(['1'])));
    }
    await Promise.all(uploads);

    const manyRef = ref(storage, 'many');
    const first = await list(manyRef);
    expect(first.items).toHaveLength(1000);
    expect(typeof first.nextPageToken).toBe('string');

    const second = await list(manyRef, { pageToken: first.nextPageToken });
    expect(second.items).toHaveLength(5);
    expect(second.items[0]?.name).toBe('f-1000.txt');
    expect(second.items[4]?.name).toBe('f-1004.txt');
    expect(Object.prototype.hasOwnProperty.call(second, 'nextPageToken')).toBe(false);
  });

  it('rejects invalid maxResults and malformed pageToken with storage/invalid-argument', async () => {
    const storage = freshStorage('list-invalid-args');
    const rootRef = ref(storage);

    const badMaxValues: unknown[] = [0, -1, -100, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1001, '5', true, {}];
    for (const badMax of badMaxValues) {
      const err = await captureStorageError(() =>
        list(rootRef, { maxResults: badMax as number }),
      );
      expect(err.code).toBe('storage/invalid-argument');
    }

    const badOptions: unknown[] = ['bad', 42, []];
    for (const badOpt of badOptions) {
      const err = await captureStorageError(() => list(rootRef, badOpt as never));
      expect(err.code).toBe('storage/invalid-argument');
    }

    const badTokens: unknown[] = [
      123,
      {},
      'not valid spaces',
      'bad+char',
      'bad/char',
      'bad=padding',
      'a',
      'e30', // {}
      'eyJ2IjoyLCJhZnRlciI6ImEifQ', // {"v":2,"after":"a"}
      'eyJ2IjoxLCJhZnRlciI6IiJ9', // {"v":1,"after":""}
      'eyJ2IjoxLCJhZnRlciI6MTIzfQ', // {"v":1,"after":123}
      'eyJ2IjoxLCJhZnRlciI6ImEiLCJleHRyYSI6MX0', // extra key
      'bm90LWpzb24', // "not-json"
    ];
    for (const badToken of badTokens) {
      const err = await captureStorageError(() =>
        list(rootRef, { pageToken: badToken as string }),
      );
      expect(err.code).toBe('storage/invalid-argument');
    }
  });

  it('produces identical pageTokens without globalThis.Buffer (browser/worker fallback)', async () => {
    const storage = freshStorage('list-no-buffer');
    for (const name of ['a-item', 'b-item', 'c-item']) {
      await uploadBytes(ref(storage, `fallback/${name}`), new Blob(['ok']));
    }
    const targetRef = ref(storage, 'fallback');
    const withBuffer = await list(targetRef, { maxResults: 1 });
    expect(withBuffer.nextPageToken).toBeDefined();

    const globals = globalThis as { Buffer?: unknown };
    const savedBuffer = globals.Buffer;
    delete globals.Buffer;
    try {
      const withoutBuffer = await list(targetRef, { maxResults: 1 });
      expect(withoutBuffer.nextPageToken).toBe(withBuffer.nextPageToken);
      const second = await list(targetRef, { maxResults: 2, pageToken: withoutBuffer.nextPageToken });
      expect(second.items.map((r) => r.name)).toEqual(['b-item', 'c-item']);
      expect(Object.prototype.hasOwnProperty.call(second, 'nextPageToken')).toBe(false);
    } finally {
      globals.Buffer = savedBuffer;
    }
  });

  it('enforces method: list rules fail-closed before decoding pageToken and isolates named buckets', async () => {
    const sandbox = initializeSandbox({});
    try {
      const listOnlyRules = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /public/{allPaths=**} {
      allow list, write: if true;
      allow get: if false;
    }
    match /private/{allPaths=**} {
      allow write: if true;
      allow list: if request.auth != null;
    }
  }
}`;
      const dbName = uniqueDbName('list-rules-bucket');
      const anonDefault = getStorageSandbox(sandbox.withAuth(null), { dbName, rules: listOnlyRules });
      const authedDefault = getStorageSandbox(sandbox.withAuth({ uid: 'u1' }), { dbName, rules: listOnlyRules });
      const secondaryBucket = getStorageSandbox(sandbox.withAuth({ uid: 'u1' }), {
        dbName,
        bucket: 'archive-bucket',
        rules: listOnlyRules,
      });

      await uploadBytes(ref(anonDefault, 'public/p1.txt'), new Blob(['1']));
      await uploadBytes(ref(anonDefault, 'public/p2.txt'), new Blob(['2']));
      await uploadBytes(ref(anonDefault, 'private/s1.txt'), new Blob(['secret']));
      await uploadBytes(ref(secondaryBucket, 'public/b1.txt'), new Blob(['bucket']));
      await uploadBytes(ref(secondaryBucket, 'public/b2.txt'), new Blob(['bucket']));

      // Unauthorized caller passing a malformed pageToken receives storage/unauthorized (no token oracle).
      const deniedErr = await captureStorageError(() =>
        list(ref(anonDefault, 'private'), { pageToken: 'malformed-token' }),
      );
      expect(deniedErr.code).toBe('storage/unauthorized');

      // Explicit `allow list` grants list even when `allow get` is false.
      const pubPage1 = await list(ref(anonDefault, 'public'), { maxResults: 1 });
      expect(pubPage1.items.map((r) => r.name)).toEqual(['p1.txt']);
      expect(pubPage1.nextPageToken).toBeDefined();

      const privPage = await list(ref(authedDefault, 'private'), { maxResults: 5 });
      expect(privPage.items.map((r) => r.name)).toEqual(['s1.txt']);

      // Named bucket lists only its own objects and keeps bucket identity on returned refs.
      const bucketPage1 = await list(ref(secondaryBucket, 'public'), { maxResults: 1 });
      expect(bucketPage1.items.map((r) => r.name)).toEqual(['b1.txt']);
      expect(bucketPage1.items[0]?.bucket).toBe('archive-bucket');
      const bucketPage2 = await list(ref(secondaryBucket, 'public'), {
        maxResults: 1,
        pageToken: bucketPage1.nextPageToken,
      });
      expect(bucketPage2.items.map((r) => r.name)).toEqual(['b2.txt']);
      expect(bucketPage2.items[0]?.bucket).toBe('archive-bucket');
      expect(Object.prototype.hasOwnProperty.call(bucketPage2, 'nextPageToken')).toBe(false);
    } finally {
      sandbox.dispose();
    }
  });
});
