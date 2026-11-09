import { describe, expect, it } from 'bun:test';
import type { ObservedSessionDataSnapshot } from '@pyric/cli/vite/internal/supplied-rows';
import {
  createObservedStorageHandle,
  createReadOnlyStorageApi,
  observedObjectOf,
  selectActiveStorageBucket,
  summarizeObservedStorageBuckets,
} from '../../src/shell/observed-storage-mirror.js';

function makeSnapshot(
  overrides: Partial<ObservedSessionDataSnapshot> = {},
): ObservedSessionDataSnapshot {
  return {
    revision: 1,
    updatedAt: 1000,
    projectId: 'demo-project',
    firestore: {},
    rtdb: {},
    defaultRtdbInstance: null,
    stats: {
      firestoreDocs: 0,
      rtdbInstances: 0,
      byteEstimate: 0,
      truncated: false,
      droppedCount: 0,
    },
    ...overrides,
  };
}

describe('summarizeObservedStorageBuckets & selectActiveStorageBucket', () => {
  it('returns empty summaries and empty active bucket when no Storage traffic has been observed (never fabricating .firebasestorage.app)', () => {
    const summaries = summarizeObservedStorageBuckets(makeSnapshot(), 'fallback-proj');
    expect(summaries).toEqual([]);
    expect(selectActiveStorageBucket(summaries, null)).toBe('');
  });

  it('orders default bucket first (including legacy .appspot.com), tracks counts + deletedCount, and honors user selection', () => {
    const snapshot = makeSnapshot({
      storage: {
        'archive-bucket': {
          prefixes: ['exports'],
          deleted: ['exports/old.json'],
          objects: {
            'exports/run-1.json': {
              bucket: 'archive-bucket',
              fullPath: 'exports/run-1.json',
              name: 'run-1.json',
            },
          },
        },
        'demo-project.appspot.com': {
          prefixes: [],
          objects: {
            'items/cover.png': {
              bucket: 'demo-project.appspot.com',
              fullPath: 'items/cover.png',
              name: 'cover.png',
            },
            'items/thumb.png': {
              bucket: 'demo-project.appspot.com',
              fullPath: 'items/thumb.png',
              name: 'thumb.png',
            },
          },
        },
      },
    });
    const summaries = summarizeObservedStorageBuckets(snapshot);
    expect(summaries.map((s) => s.bucket)).toEqual([
      'demo-project.appspot.com',
      'archive-bucket',
    ]);
    expect(summaries[0]?.isDefault).toBe(true);
    expect(summaries[0]?.objectCount).toBe(2);
    expect(summaries[1]?.prefixCount).toBe(1);
    expect(summaries[1]?.deletedCount).toBe(1);
    expect(selectActiveStorageBucket(summaries, null)).toBe('demo-project.appspot.com');
    expect(selectActiveStorageBucket(summaries, 'archive-bucket')).toBe('archive-bucket');
    expect(selectActiveStorageBucket(summaries, 'unknown-bucket')).toBe('demo-project.appspot.com');
  });
});

describe('createReadOnlyStorageApi', () => {
  const catalog = {
    prefixes: ['empty-folder', 'workspaces/ws-1/drafts'],
    objects: {
      'workspaces/ws-1/items/item-1.png': {
        bucket: 'demo-project.firebasestorage.app',
        fullPath: 'workspaces/ws-1/items/item-1.png',
        name: 'item-1.png',
        size: 1024,
        contentType: 'image/png',
        updated: '2026-01-02T00:00:00.000Z',
        customMetadata: {
          owner: 'u1',
          firebaseStorageDownloadTokens: '[REDACTED]',
        },
      },
      'readme.txt': {
        bucket: 'demo-project.firebasestorage.app',
        fullPath: 'readme.txt',
        name: 'readme.txt',
      },
    },
  };

  const api = createReadOnlyStorageApi(() => ({
    bucket: 'demo-project.firebasestorage.app',
    catalog,
  }));
  const handle = createObservedStorageHandle('demo-project.firebasestorage.app', 3);

  it('synthesizes folder hierarchy and direct items at any prefix level', async () => {
    const rootListing = await api.listAll(api.ref(handle, ''));
    expect(rootListing.prefixes.map((p) => p.fullPath)).toEqual(['empty-folder', 'workspaces']);
    expect(rootListing.items.map((i) => i.fullPath)).toEqual(['readme.txt']);

    const wsListing = await api.listAll(api.ref(handle, 'workspaces/ws-1'));
    expect(wsListing.prefixes.map((p) => p.fullPath)).toEqual([
      'workspaces/ws-1/drafts',
      'workspaces/ws-1/items',
    ]);
    expect(wsListing.items).toEqual([]);

    const itemsListing = await api.listAll(api.ref(handle, 'workspaces/ws-1/items'));
    expect(itemsListing.prefixes).toEqual([]);
    expect(itemsListing.items.map((i) => i.fullPath)).toEqual([
      'workspaces/ws-1/items/item-1.png',
    ]);
  });

  it('returns observed metadata, reports NaN size for list-only objects, and throws storage/object-not-found for unobserved objects', async () => {
    const md = await api.getMetadata(api.ref(handle, 'workspaces/ws-1/items/item-1.png'));
    expect(md.bucket).toBe('demo-project.firebasestorage.app');
    expect(md.size).toBe(1024);
    expect(md.contentType).toBe('image/png');
    expect(md.customMetadata).toEqual({
      owner: 'u1',
      firebaseStorageDownloadTokens: '[REDACTED]',
    });

    expect(observedObjectOf(catalog, 'readme.txt')?.size).toBeUndefined();
    const listOnlyMd = await api.getMetadata(api.ref(handle, 'readme.txt'));
    expect(Number.isNaN(listOnlyMd.size)).toBe(true);

    await expect(api.getMetadata(api.ref(handle, 'missing.png'))).rejects.toMatchObject({
      code: 'storage/object-not-found',
    });
  });

  it('refuses getBlob, uploadBytes, uploadBytesResumable, and deleteObject with PYRIC_LIVE_REFUSED', async () => {
    const itemRef = api.ref(handle, 'readme.txt');
    await expect(api.getBlob(itemRef)).rejects.toMatchObject({ code: 'PYRIC_LIVE_REFUSED' });
    await expect(api.uploadBytes(itemRef, new Uint8Array([1]))).rejects.toMatchObject({
      code: 'PYRIC_LIVE_REFUSED',
    });
    expect(() => api.uploadBytesResumable(itemRef, new Uint8Array([1]))).toThrow();
    await expect(api.deleteObject(itemRef)).rejects.toMatchObject({ code: 'PYRIC_LIVE_REFUSED' });
  });
});
