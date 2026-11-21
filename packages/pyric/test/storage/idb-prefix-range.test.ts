/**
 * Regression tests for `#1965`:
 * IndexedDB Storage persistence must list, export, and reset object paths at
 * and above `U+FFFD` (`dir/\uFFFD.txt`, `dir/\uFFFF`, `dir/\uFFFDsub`, and root
 * equivalents) identically to `InMemoryStorageBackend`, without leaking into
 * adjacent prefixes or buckets.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { createSandboxRoot } from '../../src/sandbox/internal/index.js';
import { prefixKeyRange } from '../../src/storage/idb-prefix-range.js';
import {
  DEFAULT_BUCKET,
  openStorageBackend,
  type StorageBackend,
} from '../../src/storage/persistence.js';
import { InMemoryStorageBackend } from '../../src/storage/sandbox/memory-backend.js';
import { getStorageSandbox, listAll, ref, uploadBytes } from '../../src/storage/index.js';
import { installStorageBackend } from '../../src/storage/service.js';
import {
  restoreStorageState,
  snapshotStorageState,
} from '../../src/storage/sandbox/persistence-state.js';

const OPEN_RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} {
      allow read, write: if true;
    }
  }
}`;

const backends: ReadonlyArray<readonly [string, () => Promise<StorageBackend>]> = [
  ['in-memory', async () => new InMemoryStorageBackend(DEFAULT_BUCKET)],
  [
    'IndexedDB',
    () => openStorageBackend(`pyric-1965-${crypto.randomUUID()}`, DEFAULT_BUCKET),
  ],
];

describe('prefixKeyRange UTF-16 boundary math (#1965)', () => {
  it('includes U+FFFD..U+FFFF extensions and excludes adjacent prefix keys', () => {
    const range = prefixKeyRange('bucket/dir/');
    expect(range).toBeDefined();
    if (range === undefined) return;

    expect(range.includes('bucket/dir/')).toBe(true);
    expect(range.includes('bucket/dir/a.txt')).toBe(true);
    expect(range.includes('bucket/dir/\uFFFD.txt')).toBe(true);
    expect(range.includes('bucket/dir/\uFFFE.txt')).toBe(true);
    expect(range.includes('bucket/dir/\uFFFF')).toBe(true);
    expect(range.includes('bucket/dir/\uFFFF\uFFFF.txt')).toBe(true);
    expect(range.includes('bucket/dir/\uFFFDsub/nested.txt')).toBe(true);

    expect(range.includes('bucket/dir')).toBe(false);
    expect(range.includes('bucket/dir0')).toBe(false);
    expect(range.includes('bucket/dir0/other.txt')).toBe(false);
  });

  it('handles prefixes ending in trailing U+FFFF code units and all-U+FFFF prefixes', () => {
    const trailingMax = prefixKeyRange('bucket/dir/\uFFFF');
    expect(trailingMax).toBeDefined();
    if (trailingMax !== undefined) {
      expect(trailingMax.includes('bucket/dir/\uFFFE')).toBe(false);
      expect(trailingMax.includes('bucket/dir/\uFFFF')).toBe(true);
      expect(trailingMax.includes('bucket/dir/\uFFFF/child.txt')).toBe(true);
      expect(trailingMax.includes('bucket/dir/\uFFFF\uFFFF')).toBe(true);
      expect(trailingMax.includes('bucket/dir0')).toBe(false);
    }

    const allMax = prefixKeyRange('\uFFFF\uFFFF');
    expect(allMax).toBeDefined();
    if (allMax !== undefined) {
      expect(allMax.includes('\uFFFF\uFFFE')).toBe(false);
      expect(allMax.includes('\uFFFF\uFFFF')).toBe(true);
      expect(allMax.includes('\uFFFF\uFFFF/x')).toBe(true);
    }

    expect(prefixKeyRange('')).toBeUndefined();
  });
});

describe.each(backends)('U+FFFD..U+FFFF object names on %s backend (#1965)', (_label, open) => {
  it('lists items and prefixes at U+FFFD and U+FFFF under both nested and root prefixes', async () => {
    const sandbox = createSandboxRoot({ mutations: 100, spans: 100 });
    const backend = await open();
    installStorageBackend(sandbox, backend);
    const storage = getStorageSandbox(sandbox, { rules: OPEN_RULES });

    try {
      await uploadBytes(ref(storage, 'dir/a.txt'), new Uint8Array([1]));
      await uploadBytes(ref(storage, 'dir/\uFFFD.txt'), new Uint8Array([2]));
      await uploadBytes(ref(storage, 'dir/\uFFFE.txt'), new Uint8Array([3]));
      await uploadBytes(ref(storage, 'dir/\uFFFF'), new Uint8Array([4]));
      await uploadBytes(ref(storage, 'dir/\uFFFDsub/x.txt'), new Uint8Array([5]));
      await uploadBytes(ref(storage, 'dir/\uFFFFsub/y.txt'), new Uint8Array([6]));
      await uploadBytes(ref(storage, 'dir0/outside.txt'), new Uint8Array([7]));
      await uploadBytes(ref(storage, '\uFFFD-root.txt'), new Uint8Array([8]));
      await uploadBytes(ref(storage, '\uFFFF-root'), new Uint8Array([9]));

      const dirList = await listAll(ref(storage, 'dir'));
      expect(dirList.items.map((item) => item.fullPath)).toEqual([
        'dir/a.txt',
        'dir/\uFFFD.txt',
        'dir/\uFFFE.txt',
        'dir/\uFFFF',
      ]);
      expect(dirList.prefixes.map((prefix) => prefix.fullPath)).toEqual([
        'dir/\uFFFDsub',
        'dir/\uFFFFsub',
      ]);

      const rootList = await listAll(ref(storage));
      expect(rootList.items.map((item) => item.fullPath)).toEqual([
        '\uFFFD-root.txt',
        '\uFFFF-root',
      ]);
      expect(rootList.prefixes.map((prefix) => prefix.fullPath)).toEqual([
        'dir',
        'dir0',
      ]);

      const exactMaxPrefix = await backend.listByPrefix('dir/\uFFFF', DEFAULT_BUCKET);
      expect(exactMaxPrefix.map((entry) => entry.fullPath)).toEqual([
        'dir/\uFFFF',
        'dir/\uFFFFsub/y.txt',
      ]);
    } finally {
      backend.close();
    }
  });

  it('exports via snapshotStorageState and clears via reset(bucket) without dropping U+FFFD..U+FFFF or touching sibling buckets', async () => {
    const sandbox = createSandboxRoot({ mutations: 100, spans: 100 });
    const backend = await open();
    installStorageBackend(sandbox, backend);
    const storage = getStorageSandbox(sandbox, { rules: OPEN_RULES });

    try {
      await uploadBytes(ref(storage, '\uFFFD.txt'), new Uint8Array([10, 11]));
      await uploadBytes(ref(storage, '\uFFFF'), new Uint8Array([12, 13]));
      await uploadBytes(ref(storage, 'dir/\uFFFD.txt'), new Uint8Array([14]));
      await uploadBytes(ref(storage, 'dir/\uFFFF'), new Uint8Array([15]));

      const siblingBucket = `${DEFAULT_BUCKET}0`;
      await backend.put(
        'keep.txt',
        new Blob(['kept']),
        {
          fullPath: 'keep.txt',
          name: 'keep.txt',
          bucket: siblingBucket,
          generation: '1',
          metageneration: '1',
          timeCreated: '2026-01-01T00:00:00.000Z',
          updated: '2026-01-01T00:00:00.000Z',
          size: 4,
          contentType: 'text/plain',
        },
      );

      const exported = await snapshotStorageState(storage);
      expect(exported.map((record) => record.metadata.fullPath)).toEqual([
        'dir/\uFFFD.txt',
        'dir/\uFFFF',
        '\uFFFD.txt',
        '\uFFFF',
      ]);

      await backend.reset(DEFAULT_BUCKET);
      expect(await backend.listByPrefix('', DEFAULT_BUCKET)).toEqual([]);
      expect(await backend.getBlob('\uFFFF', DEFAULT_BUCKET)).toBeUndefined();
      expect(await backend.getMetadata('\uFFFF', DEFAULT_BUCKET)).toBeUndefined();

      // Sibling bucket `${DEFAULT_BUCKET}0` ('/' + 1 === '0') must remain intact.
      const siblingMeta = await backend.getMetadata('keep.txt', siblingBucket);
      expect(siblingMeta?.fullPath).toBe('keep.txt');

      await restoreStorageState(storage, exported);
      const reExported = await snapshotStorageState(storage);
      expect(reExported.map((record) => record.metadata.fullPath)).toEqual([
        'dir/\uFFFD.txt',
        'dir/\uFFFF',
        '\uFFFD.txt',
        '\uFFFF',
      ]);
    } finally {
      backend.close();
    }
  });
});
