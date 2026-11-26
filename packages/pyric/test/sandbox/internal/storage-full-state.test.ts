/**
 * SHA-256 Storage byte-reference retention across `storage-full-state`,
 * `fork`, `diff`, `promote`, and `saveBranch`/`loadBranch` (#910 / ADR 0018).
 */
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  InlineStorageLimitError,
  SHA256_HEX_PATTERN,
  isSha256Hex,
  setInlineStorageLimitForTesting,
} from '../../../src/sandbox/internal/inline-storage-limit.js';
import {
  applyStorageObjects,
  captureStorageObjects,
  holdsBytesByReference,
  holdsBytesInline,
  inlineStorageBytes,
  toStorageObjectReference,
  type StorageObjectState,
} from '../../../src/sandbox/internal/storage-full-state.js';
import { captureFullState, initializeSandbox } from '../../../src/sandbox/index.js';
import { diff, discard, fork, promote } from '../../../src/sandbox/branches/index.js';
import {
  branchDirectory,
  loadBranch,
  saveBranch,
} from '../../../src/sandbox/branches/store.js';
import {
  deleteObject,
  getMetadata,
  listAll,
  ref as storageRef,
  updateMetadata,
  uploadBytes,
} from '../../../src/storage/index.js';
import { getAdminStorageSandbox } from '../../../src/storage/internal.js';

const LARGE_OBJECT_SHA256 = 'a'.repeat(64);
const NAMED_BUCKET_SHA256 = 'b'.repeat(64);
const LARGE_OBJECT_BYTES = 524_288_000; // 500 MiB (> MAX_INLINE_STORAGE_BYTES)

let restoreLimit: (() => void) | undefined;
let tempDir: string | undefined;

afterEach(() => {
  restoreLimit?.();
  restoreLimit = undefined;
  if (tempDir !== undefined) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

function largeReferenceObject(overrides: Partial<StorageObjectState> = {}): StorageObjectState {
  return {
    path: 'videos/keynote.mp4',
    sha256: LARGE_OBJECT_SHA256,
    size: LARGE_OBJECT_BYTES,
    contentType: 'video/mp4',
    customMetadata: { speaker: 'alice' },
    blobType: 'video/mp4',
    metadata: {
      bucket: 'pyric-default',
      name: 'keynote.mp4',
      size: LARGE_OBJECT_BYTES,
      timeCreated: '2026-10-07T00:00:00.000Z',
      updated: '2026-10-07T00:00:00.000Z',
      generation: '5',
      metageneration: '1',
    },
    ...overrides,
  } as StorageObjectState;
}

describe('SHA-256 Storage reference helpers', () => {
  it('validates canonical lowercase 64-char SHA-256 digests', () => {
    expect(SHA256_HEX_PATTERN.test(LARGE_OBJECT_SHA256)).toBe(true);
    expect(isSha256Hex(LARGE_OBJECT_SHA256)).toBe(true);
    expect(isSha256Hex('A'.repeat(64))).toBe(false);
    expect(isSha256Hex('deadbeef')).toBe(false);
    expect(isSha256Hex(123)).toBe(false);
  });

  it('converts inline StorageObjectState entries to SHA-256 references', async () => {
    const inlineObject: StorageObjectState = {
      bucket: 'pyric-default',
      path: 'docs/readme.txt',
      contentBase64: Buffer.from('hello world', 'utf8').toString('base64'),
      contentType: 'text/plain',
      customMetadata: { env: 'dev' },
      blobType: 'text/plain',
      metadata: {
        bucket: 'pyric-default',
        name: 'readme.txt',
        size: 11,
        timeCreated: '2026-10-07T00:00:00.000Z',
        updated: '2026-10-07T00:00:00.000Z',
        generation: '1',
        metageneration: '1',
      },
    };
    const converted = await toStorageObjectReference(inlineObject);
    expect(holdsBytesByReference(converted)).toBe(true);
    expect(holdsBytesInline(converted)).toBe(false);
    expect(converted.bucket).toBeUndefined();
    expect(converted.sha256).toBe(
      'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9',
    );
    expect(converted.size).toBe(11);
    expect(inlineStorageBytes([converted])).toBe(0);
  });

  it('rejects malformed SHA-256 hashes and missing metadata on applyStorageObjects', async () => {
    const sandbox = initializeSandbox();
    try {
      const missingMeta: StorageObjectState = {
        path: 'broken/no-meta.bin',
        sha256: LARGE_OBJECT_SHA256,
        size: 4,
        customMetadata: {},
      };
      await expect(applyStorageObjects(sandbox, [missingMeta])).rejects.toThrow(
        'reference without its metadata',
      );

      const badHash = largeReferenceObject({ sha256: 'not-a-sha256' } as Partial<StorageObjectState>);
      await expect(applyStorageObjects(sandbox, [badHash])).rejects.toThrow(
        'invalid SHA-256 reference',
      );
    } finally {
      sandbox.dispose();
    }
  });
});

describe('fork, diff, promote, and branch persistence with SHA-256 Storage references', () => {
  it('forks a 500 MiB reference-backed state across default and named buckets with zero inline bytes', async () => {
    restoreLimit = setInlineStorageLimitForTesting(16);
    const source = initializeSandbox();
    const baseState = await captureFullState(source);
    source.dispose();

    const namedBucketObject: StorageObjectState = {
      bucket: 'media-assets',
      path: 'clips/intro.webm',
      sha256: NAMED_BUCKET_SHA256,
      size: LARGE_OBJECT_BYTES,
      contentType: 'video/webm',
      customMetadata: { track: 'opening' },
      blobType: 'video/webm',
      metadata: {
        bucket: 'media-assets',
        name: 'intro.webm',
        size: LARGE_OBJECT_BYTES,
        timeCreated: '2026-10-07T00:00:00.000Z',
        updated: '2026-10-07T00:00:00.000Z',
        generation: '2',
        metageneration: '1',
      },
    };
    baseState.storage = [largeReferenceObject(), namedBucketObject];

    const branch = await fork(baseState);
    try {
      const defaultStorage = getAdminStorageSandbox(branch.sandbox);
      const defaultMeta = await getMetadata(storageRef(defaultStorage, 'videos/keynote.mp4'));
      expect(defaultMeta.size).toBe(LARGE_OBJECT_BYTES);
      expect(defaultMeta.contentType).toBe('video/mp4');
      expect(defaultMeta.customMetadata).toEqual({ speaker: 'alice' });
      expect(defaultMeta.generation).toBe('5');

      const listed = await listAll(storageRef(defaultStorage, 'videos'));
      expect(listed.items.map((item) => item.fullPath)).toEqual(['videos/keynote.mp4']);

      const namedStorage = getAdminStorageSandbox(branch.sandbox, { bucket: 'media-assets' });
      const namedMeta = await getMetadata(storageRef(namedStorage, 'clips/intro.webm'));
      expect(namedMeta.size).toBe(LARGE_OBJECT_BYTES);
      expect(namedMeta.bucket).toBe('media-assets');

      const capturedInlineMode = await captureStorageObjects(branch.sandbox, 'inline');
      expect(capturedInlineMode).toHaveLength(2);
      expect(inlineStorageBytes(capturedInlineMode)).toBe(0);
      for (const entry of capturedInlineMode) {
        expect(holdsBytesByReference(entry)).toBe(true);
      }

      const capturedRefMode = await captureStorageObjects(branch.sandbox, 'reference');
      expect(capturedRefMode).toHaveLength(2);
      expect(await diff(branch, baseState)).toEqual([]);
    } finally {
      discard(branch);
    }
  });

  it('round-trips a 500 MiB SHA-256 reference through saveBranch and loadBranch without inline base64', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'pyric-branch-ref-'));
    restoreLimit = setInlineStorageLimitForTesting(16);

    const source = initializeSandbox();
    const baseState = await captureFullState(source);
    source.dispose();
    baseState.storage = [largeReferenceObject()];

    const branch = await fork(baseState);
    try {
      await saveBranch(tempDir, 'experiment', branch, { base: 'live' });
    } finally {
      discard(branch);
    }

    const dir = branchDirectory(tempDir, 'experiment');
    const savedStorageJson = JSON.parse(
      readFileSync(join(dir, 'state', 'storage.json'), 'utf8'),
    ) as StorageObjectState[];
    expect(savedStorageJson).toHaveLength(1);
    const firstSaved = savedStorageJson[0];
    if (firstSaved === undefined) throw new Error('expected saved storage entry');
    expect(holdsBytesByReference(firstSaved)).toBe(true);
    expect('contentBase64' in firstSaved).toBe(false);

    const reloaded = await loadBranch(tempDir, 'experiment');
    if (reloaded === null) throw new Error('expected branch to reload');
    try {
      const meta = await getMetadata(
        storageRef(getAdminStorageSandbox(reloaded.branch.sandbox), 'videos/keynote.mp4'),
      );
      expect(meta.size).toBe(LARGE_OBJECT_BYTES);
      expect(await diff(reloaded.branch, baseState)).toEqual([]);
    } finally {
      discard(reloaded.branch);
    }
  });

  it('preserves SHA-256 reference across updateMetadata, supports deleteObject + promote, and enforces inline limit on new uploads', async () => {
    const live = initializeSandbox();
    const liveStorage = getAdminStorageSandbox(live, { dbName: 'pyric-ref-promote-live' });
    await uploadBytes(storageRef(liveStorage, 'obsolete/remove-me.bin'), new Uint8Array([1, 2, 3]));
    const liveState = await captureFullState(live);

    const inheritedState = structuredClone(liveState);
    inheritedState.storage.push(largeReferenceObject());

    const branch = await fork(inheritedState);
    try {
      const branchStorage = getAdminStorageSandbox(branch.sandbox);
      await updateMetadata(storageRef(branchStorage, 'videos/keynote.mp4'), {
        customMetadata: { speaker: 'bob' },
      });
      const patched = await captureStorageObjects(branch.sandbox, 'inline');
      const keynote = patched.find((entry) => entry.path === 'videos/keynote.mp4');
      if (keynote === undefined) throw new Error('expected keynote entry');
      expect(holdsBytesByReference(keynote)).toBe(true);
      expect(keynote.customMetadata).toEqual({ speaker: 'bob' });

      // Overwriting an inherited reference issues a generation strictly above '5'
      // and captures inline bytes subject to `inlineStorageLimit()`.
      await uploadBytes(
        storageRef(branchStorage, 'videos/keynote.mp4'),
        new Uint8Array([9, 8, 7, 6, 5]),
      );
      const overwrittenMeta = await getMetadata(storageRef(branchStorage, 'videos/keynote.mp4'));
      expect(Number(overwrittenMeta.generation)).toBeGreaterThan(5);

      restoreLimit = setInlineStorageLimitForTesting(4);
      await expect(captureStorageObjects(branch.sandbox, 'inline')).rejects.toBeInstanceOf(
        InlineStorageLimitError,
      );
      restoreLimit();
      restoreLimit = undefined;
    } finally {
      discard(branch);
    }

    // Deleting a sibling object while leaving an inherited 500 MiB reference untouched
    // promotes the deletion cleanly onto `live`.
    const deleteBranch = await fork(inheritedState);
    try {
      const branchStorage = getAdminStorageSandbox(deleteBranch.sandbox);
      await deleteObject(storageRef(branchStorage, 'obsolete/remove-me.bin'));
      restoreLimit = setInlineStorageLimitForTesting(16);
      await promote(deleteBranch, live);
      const remaining = await listAll(storageRef(liveStorage, 'obsolete'));
      expect(remaining.items).toEqual([]);
    } finally {
      discard(deleteBranch);
      live.dispose();
    }
  });
});
