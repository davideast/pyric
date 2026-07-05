/**
 * Slice 6 — `getMetadata` + `updateMetadata`.
 *
 * Covers:
 *   - getMetadata returns the same FullMetadata uploadBytes
 *     produced
 *   - object-not-found / invalid-root-operation preconditions
 *   - updateMetadata replaces settable fields, bumps metageneration,
 *     refreshes `updated`, and leaves server-set fields + blob
 *     content untouched
 *   - undefined-valued patch fields preserve the previous value
 */
import 'fake-indexeddb/auto';
import { describe, it, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  getStorageSandbox,
  ref,
  uploadBytes,
  getBlob,
  getMetadata,
  updateMetadata,
} from '../../src/storage/index.js';

function uniqueDbName(label: string): string {
  return `pyric-storage-test-${label}-${Math.random().toString(36).slice(2, 10)}`;
}

function freshStorage(label: string) {
  const sandbox = initializeSandbox({});
  return getStorageSandbox(sandbox, { dbName: uniqueDbName(label) });
}

describe('getMetadata', () => {
  it('returns the FullMetadata uploadBytes wrote', async () => {
    const storage = freshStorage('get-md');
    const r = ref(storage, 'sessions/s1.json');
    const upload = await uploadBytes(r, new Blob(['{"s":1}']), {
      contentType: 'application/json',
      customMetadata: { sessionId: 'abc' },
    });
    const md = await getMetadata(r);
    expect(md.fullPath).toBe('sessions/s1.json');
    expect(md.name).toBe('s1.json');
    expect(md.bucket).toBe('pyric-default');
    expect(md.contentType).toBe('application/json');
    expect(md.customMetadata).toEqual({ sessionId: 'abc' });
    expect(md.size).toBe(upload.metadata.size);
    expect(md.generation).toBe(upload.metadata.generation);
    expect(md.metageneration).toBe('1');
  });

  it('throws object-not-found for missing paths', async () => {
    const storage = freshStorage('get-md-missing');
    const r = ref(storage, 'sessions/missing.json');
    await expect(getMetadata(r)).rejects.toThrow(/object-not-found/);
  });

  it('throws invalid-root-operation on the root reference', async () => {
    const storage = freshStorage('get-md-root');
    await expect(getMetadata(ref(storage))).rejects.toThrow(/invalid-root-operation/);
  });
});

describe('updateMetadata', () => {
  it('replaces settable fields, bumps metageneration, refreshes updated', async () => {
    const storage = freshStorage('update-md');
    const r = ref(storage, 'sessions/s1.json');
    const upload = await uploadBytes(r, new Blob(['x']), {
      contentType: 'text/plain',
      customMetadata: { tag: 'first' },
    });

    // Pause one millisecond so the new `updated` timestamp is
    // guaranteed-distinct on systems with sub-ms wallclock resolution.
    await new Promise((resolve) => setTimeout(resolve, 1));

    const next = await updateMetadata(r, {
      contentType: 'application/json',
      customMetadata: { tag: 'second' },
    });

    expect(next.contentType).toBe('application/json');
    expect(next.customMetadata).toEqual({ tag: 'second' });
    expect(next.metageneration).toBe('2');
    expect(next.updated).not.toBe(upload.metadata.updated);
    // Server-set fields preserved.
    expect(next.generation).toBe(upload.metadata.generation);
    expect(next.timeCreated).toBe(upload.metadata.timeCreated);
    expect(next.size).toBe(upload.metadata.size);
    expect(next.bucket).toBe(upload.metadata.bucket);
  });

  it('leaves the blob content untouched', async () => {
    const storage = freshStorage('update-md-blob');
    const r = ref(storage, 'sessions/s1.json');
    await uploadBytes(r, new Blob(['original']), { contentType: 'text/plain' });

    await updateMetadata(r, { customMetadata: { changed: 'yes' } });

    const blob = await getBlob(r);
    expect(await blob.text()).toBe('original');
  });

  it('undefined-valued patch fields preserve the previous value', async () => {
    const storage = freshStorage('update-md-undef');
    const r = ref(storage, 'sessions/s1.json');
    await uploadBytes(r, new Blob(['x']), {
      contentType: 'text/plain',
      cacheControl: 'no-cache',
      customMetadata: { tag: 'orig' },
    });

    // contentType is undefined in the patch — should stay 'text/plain'.
    const next = await updateMetadata(r, {
      customMetadata: { tag: 'new' },
    });
    expect(next.contentType).toBe('text/plain');
    expect(next.cacheControl).toBe('no-cache');
    expect(next.customMetadata).toEqual({ tag: 'new' });
  });

  it('throws object-not-found when the path is missing', async () => {
    const storage = freshStorage('update-md-missing');
    const r = ref(storage, 'sessions/never.json');
    await expect(
      updateMetadata(r, { contentType: 'application/json' }),
    ).rejects.toThrow(/object-not-found/);
  });

  it('throws invalid-root-operation on the root reference', async () => {
    const storage = freshStorage('update-md-root');
    await expect(updateMetadata(ref(storage), {})).rejects.toThrow(
      /invalid-root-operation/,
    );
  });
});
