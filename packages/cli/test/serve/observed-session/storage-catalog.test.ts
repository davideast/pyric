import { describe, expect, it } from 'bun:test';
import {
  createObservedStorageCatalog,
  type StorageCatalogDropReason,
} from '../../../src/serve/observed-session/storage-catalog.js';
import { UNREAD_BUCKET } from '../../../src/serve/observed-session/wire.js';

describe('createObservedStorageCatalog', () => {
  it('isolates buckets, preserves downloadUrl tokens and customMetadata verbatim, records delete tombstones, prunes orphan inferred prefixes, and clears tombstones on re-create', () => {
    const drops: StorageCatalogDropReason[] = [];
    const catalog = createObservedStorageCatalog({
      maxBytes: 64 * 1024,
      projectId: () => 'demo-proj',
      onDrop: (reason) => drops.push(reason),
    });

    expect(
      catalog.apply({
        kind: 'upsert',
        bucket: 'demo-proj.appspot.com',
        fullPath: 'workspaces/ws-1/items/item-1.png',
        replaceMetadata: true,
        metadata: {
          size: 512,
          contentType: 'image/png',
          timeCreated: '2026-01-01T00:00:00.000Z',
          updated: '2026-01-01T00:00:00.000Z',
          customMetadata: { ownerUid: 'u-1', apiKey: 'secret-1' },
        },
      }),
    ).toBe(true);

    // UNREAD_BUCKET resolves to the existing appspot bucket instead of fabricating .firebasestorage.app.
    expect(
      catalog.apply({
        kind: 'downloadUrl',
        bucket: UNREAD_BUCKET,
        fullPath: 'workspaces/ws-1/items/item-1.png',
        downloadUrl:
          'https://firebasestorage.googleapis.com/v0/b/demo-proj.appspot.com/o/workspaces%2Fws-1%2Fitems%2Fitem-1.png?alt=media&token=t-1',
      }),
    ).toBe(true);

    expect(
      catalog.apply({
        kind: 'upsert',
        bucket: 'demo-proj-secondary',
        fullPath: 'exports/report.csv',
        replaceMetadata: true,
        metadata: { size: 128, contentType: 'text/csv' },
      }),
    ).toBe(true);

    expect(catalog.defaultBucket()).toBe('demo-proj.appspot.com');
    expect(catalog.bucketCount()).toBe(2);
    expect(catalog.objectCount()).toBe(2);

    let snap = catalog.snapshot();
    expect(snap['demo-proj.firebasestorage.app']).toBeUndefined();
    expect(snap['demo-proj.appspot.com']?.prefixes).toEqual([
      'workspaces',
      'workspaces/ws-1',
      'workspaces/ws-1/items',
    ]);
    expect(snap['demo-proj.appspot.com']?.objects['workspaces/ws-1/items/item-1.png']).toEqual({
      bucket: 'demo-proj.appspot.com',
      fullPath: 'workspaces/ws-1/items/item-1.png',
      name: 'item-1.png',
      size: 512,
      contentType: 'image/png',
      timeCreated: '2026-01-01T00:00:00.000Z',
      updated: '2026-01-01T00:00:00.000Z',
      customMetadata: { ownerUid: 'u-1', apiKey: 'secret-1' },
      downloadUrl:
        'https://firebasestorage.googleapis.com/v0/b/demo-proj.appspot.com/o/workspaces%2Fws-1%2Fitems%2Fitem-1.png?alt=media&token=t-1',
    });

    // Deleting the sole object under inferred prefixes removes orphan inferred prefixes and records a tombstone.
    catalog.apply({
      kind: 'delete',
      bucket: 'demo-proj.appspot.com',
      fullPath: 'workspaces/ws-1/items/item-1.png',
    });
    snap = catalog.snapshot();
    expect(snap['demo-proj.appspot.com']?.objects).toEqual({});
    expect(snap['demo-proj.appspot.com']?.prefixes).toEqual([]);
    expect(snap['demo-proj.appspot.com']?.deleted).toEqual(['workspaces/ws-1/items/item-1.png']);

    // Re-uploading the deleted object clears its tombstone.
    catalog.apply({
      kind: 'upsert',
      bucket: 'demo-proj.appspot.com',
      fullPath: 'workspaces/ws-1/items/item-1.png',
      metadata: { size: 256, contentType: 'image/png' },
    });
    snap = catalog.snapshot();
    expect(snap['demo-proj.appspot.com']?.deleted).toBeUndefined();
    expect(snap['demo-proj.appspot.com']?.objects['workspaces/ws-1/items/item-1.png']?.size).toBe(256);
    expect(drops).toEqual([]);
  });

  it('drops UNREAD_BUCKET ops as unsupported when no bucket has been observed yet', () => {
    const drops: StorageCatalogDropReason[] = [];
    const catalog = createObservedStorageCatalog({
      projectId: () => 'demo-proj',
      onDrop: (reason) => drops.push(reason),
    });

    expect(
      catalog.apply({
        kind: 'delete',
        bucket: UNREAD_BUCKET,
        fullPath: 'items/missing.png',
      }),
    ).toBe(false);
    expect(catalog.bucketCount()).toBe(0);
    expect(drops).toEqual(['unsupported']);
  });

  it('prunes stale objects and absent child folders on complete delimiter and recursive listings', () => {
    const catalog = createObservedStorageCatalog({
      projectId: () => 'demo-proj',
      onDrop: () => {},
    });

    catalog.applyAll([
      {
        kind: 'upsert',
        bucket: 'demo-proj.firebasestorage.app',
        fullPath: 'docs/stale.txt',
        metadata: { size: 10 },
      },
      {
        kind: 'upsert',
        bucket: 'demo-proj.firebasestorage.app',
        fullPath: 'docs/kept.txt',
        metadata: { size: 20, contentType: 'text/plain' },
      },
      {
        kind: 'upsert',
        bucket: 'demo-proj.firebasestorage.app',
        fullPath: 'docs/old-sub/nested.txt',
        metadata: { size: 30 },
      },
      {
        kind: 'upsert',
        bucket: 'demo-proj.firebasestorage.app',
        fullPath: 'other/untouched.txt',
        metadata: { size: 40 },
      },
    ]);

    // Delimiter-scoped complete list of `docs`: `stale.txt` and `docs/old-sub` are absent, so both prune.
    catalog.apply({
      kind: 'list',
      bucket: 'demo-proj.firebasestorage.app',
      prefix: 'docs',
      prefixes: ['docs/active-sub'],
      items: [{ fullPath: 'docs/kept.txt' }],
      complete: true,
    });

    let snap = catalog.snapshot();
    expect(Object.keys(snap['demo-proj.firebasestorage.app']?.objects ?? {}).sort()).toEqual([
      'docs/kept.txt',
      'other/untouched.txt',
    ]);
    expect(snap['demo-proj.firebasestorage.app']?.objects['docs/kept.txt']?.size).toBe(20);
    expect(snap['demo-proj.firebasestorage.app']?.prefixes).toContain('docs/active-sub');

    // Recursive complete root list prunes `other/untouched.txt` as well.
    catalog.apply({
      kind: 'list',
      bucket: 'demo-proj.firebasestorage.app',
      prefix: '',
      prefixes: [],
      items: [{ fullPath: 'docs/kept.txt' }],
      complete: true,
      recursive: true,
    });

    snap = catalog.snapshot();
    expect(Object.keys(snap['demo-proj.firebasestorage.app']?.objects ?? {})).toEqual(['docs/kept.txt']);
  });

  it('evicts least-recently-used objects instead of FIFO when an older object is touched', () => {
    const drops: StorageCatalogDropReason[] = [];
    const catalog = createObservedStorageCatalog({
      maxObjects: 2,
      maxBytes: 16 * 1024,
      projectId: () => 'demo-cap',
      onDrop: (reason) => drops.push(reason),
    });

    catalog.apply({
      kind: 'upsert',
      bucket: 'demo-cap.firebasestorage.app',
      fullPath: 'items/1.png',
      metadata: { size: 10, contentType: 'image/png' },
    });
    catalog.apply({
      kind: 'upsert',
      bucket: 'demo-cap.firebasestorage.app',
      fullPath: 'items/2.png',
      metadata: { size: 20, contentType: 'image/png' },
    });
    // Touch items/1.png via a listing so items/2.png becomes the LRU entry.
    catalog.apply({
      kind: 'list',
      bucket: 'demo-cap.firebasestorage.app',
      prefix: 'items',
      prefixes: [],
      items: [{ fullPath: 'items/1.png' }],
    });
    catalog.apply({
      kind: 'upsert',
      bucket: 'demo-cap.firebasestorage.app',
      fullPath: 'items/3.png',
      metadata: { size: 30, contentType: 'image/png' },
    });

    const snap = catalog.snapshot();
    expect(Object.keys(snap['demo-cap.firebasestorage.app']?.objects ?? {})).toEqual([
      'items/1.png',
      'items/3.png',
    ]);
    expect(catalog.objectCount()).toBe(2);
    expect(drops).toEqual(['truncated']);
  });

  it('preserves existing objects and delete tombstones when an oversized upsert is dropped', () => {
    const drops: StorageCatalogDropReason[] = [];
    const catalog = createObservedStorageCatalog({
      maxBytes: 2048,
      projectId: () => 'demo-cap',
      onDrop: (reason) => drops.push(reason),
    });

    expect(
      catalog.apply({
        kind: 'upsert',
        bucket: 'demo-cap.firebasestorage.app',
        fullPath: 'items/kept.png',
        metadata: { size: 42, contentType: 'image/png', customMetadata: { tag: 'v1' } },
      }),
    ).toBe(true);

    catalog.apply({
      kind: 'delete',
      bucket: 'demo-cap.firebasestorage.app',
      fullPath: 'items/removed.png',
    });

    const oversizedMeta = {
      size: 99,
      contentType: 'image/png',
      customMetadata: {
        a: 'x'.repeat(900),
        b: 'y'.repeat(900),
        c: 'z'.repeat(900),
      },
    };

    // Oversized re-upsert on `items/kept.png` is dropped without deleting `v1`.
    expect(
      catalog.apply({
        kind: 'upsert',
        bucket: 'demo-cap.firebasestorage.app',
        fullPath: 'items/kept.png',
        replaceMetadata: true,
        metadata: oversizedMeta,
      }),
    ).toBe(false);

    // Oversized upsert on tombstoned `items/removed.png` is dropped without clearing its tombstone.
    expect(
      catalog.apply({
        kind: 'upsert',
        bucket: 'demo-cap.firebasestorage.app',
        fullPath: 'items/removed.png',
        replaceMetadata: true,
        metadata: oversizedMeta,
      }),
    ).toBe(false);

    const snap = catalog.snapshot();
    expect(snap['demo-cap.firebasestorage.app']?.objects['items/kept.png']).toMatchObject({
      size: 42,
      contentType: 'image/png',
      customMetadata: { tag: 'v1' },
    });
    expect(snap['demo-cap.firebasestorage.app']?.deleted).toEqual(['items/removed.png']);
    expect(drops).toEqual(['oversized', 'oversized']);
  });
});
