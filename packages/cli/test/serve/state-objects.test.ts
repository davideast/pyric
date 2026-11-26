/**
 * Content-addressed Storage object files and SHA-256 state/branch reference
 * conversion (`state-objects.ts` and `state-store.ts`, #910 / ADR 0018).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { holdsBytesInline } from 'pyric/sandbox';
import { setInlineStorageLimitForTesting } from 'pyric/sandbox/internal';
import type { StorageStateRecord } from 'pyric/storage/internal';

import { objectFileIn, StateFileError, type StorageObjectReference } from '../../src/serve/state-file.js';
import {
  inlineStorage,
  referenceStorage,
  resolveProjectObjectFile,
  storageEntryToObjectReferenceState,
  verifiedObjectFile,
  verifyReferencedObjects,
  writeObjectFile,
} from '../../src/serve/state-objects.js';
import { createStateStore } from '../../src/serve/state-store.js';

let projectDir: string;
let restoreLimit: (() => void) | undefined;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'pyric-state-objects-'));
});

afterEach(() => {
  restoreLimit?.();
  restoreLimit = undefined;
  rmSync(projectDir, { recursive: true, force: true });
});

function sampleInlineRecord(path: string, payload: Uint8Array, bucket = 'pyric-default'): StorageStateRecord {
  return {
    dataBase64: Buffer.from(payload).toString('base64'),
    blobType: 'application/octet-stream',
    metadata: {
      bucket,
      fullPath: path,
      name: path.split('/').pop() ?? path,
      size: payload.byteLength,
      contentType: 'application/octet-stream',
      timeCreated: '2026-10-07T00:00:00.000Z',
      updated: '2026-10-07T00:00:00.000Z',
      generation: '1',
      metageneration: '1',
      customMetadata: { origin: 'fixture' },
    },
  };
}

describe('writeObjectFile and verifiedObjectFile', () => {
  it('writes content-addressed files atomically, deduplicates identical bytes, and verifies hash + size', () => {
    const bytes = new Uint8Array([10, 20, 30, 40, 50]);
    const expectedSha = createHash('sha256').update(bytes).digest('hex');

    const first = writeObjectFile(bytes, projectDir);
    const second = writeObjectFile(bytes, projectDir);
    expect(first.sha256).toBe(expectedSha);
    expect(first.size).toBe(5);
    expect(second).toEqual(first);
    expect(existsSync(objectFileIn(projectDir, expectedSha))).toBe(true);

    const refEntry: StorageObjectReference = {
      path: 'docs/blob.bin',
      sha256: expectedSha,
      size: 5,
      blobType: 'application/octet-stream',
      metadata: sampleInlineRecord('docs/blob.bin', bytes).metadata,
    };
    expect(verifiedObjectFile(refEntry, projectDir)).toBe(first.file);
    expect(() => verifyReferencedObjects([refEntry], projectDir)).not.toThrow();
  });

  it('throws StateFileError on missing files, corrupted bytes, or non-hex hashes', () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const written = writeObjectFile(bytes, projectDir);
    const baseMeta = sampleInlineRecord('docs/a.bin', bytes).metadata;

    expect(() =>
      verifiedObjectFile({ path: 'docs/a.bin', sha256: 'bad-hash', size: 4 }, projectDir),
    ).toThrow(StateFileError);

    expect(() =>
      verifiedObjectFile({ path: 'docs/missing.bin', sha256: 'f'.repeat(64), size: 4 }, projectDir),
    ).toThrow('does not exist');

    writeFileSync(written.file, new Uint8Array([9, 9, 9, 9]));
    expect(() =>
      verifiedObjectFile({ path: 'docs/a.bin', sha256: written.sha256, size: 4 }, projectDir),
    ).toThrow('bytes do not match its hash');
    expect(baseMeta.size).toBe(4);
  });
});

describe('referenceStorage, inlineStorage, and storageEntryToObjectReferenceState', () => {
  it('converts inline StorageStateRecords to verified SHA-256 references and round-trips through inlineStorage', () => {
    const payloadA = new Uint8Array(64).fill(7);
    const payloadB = new Uint8Array(32).fill(9);
    const inlineEntries = [
      sampleInlineRecord('media/a.bin', payloadA),
      sampleInlineRecord('media/b.bin', payloadB, 'custom-bucket'),
    ];

    const references = referenceStorage(inlineEntries, projectDir);
    expect(references).toHaveLength(2);
    for (const ref of references) {
      expect('dataBase64' in ref).toBe(false);
      expect(existsSync(objectFileIn(projectDir, ref.sha256))).toBe(true);
    }

    // Re-running referenceStorage over already-referenced entries verifies them in place.
    const verifiedAgain = referenceStorage(references, projectDir);
    expect(verifiedAgain).toEqual(references);

    const roundTripped = inlineStorage(references, projectDir);
    expect(roundTripped).toEqual(inlineEntries);

    const firstRef = references[0];
    const secondRef = references[1];
    if (firstRef === undefined || secondRef === undefined) {
      throw new Error('expected two references');
    }
    const defaultBucketState = storageEntryToObjectReferenceState(firstRef, projectDir);
    expect(holdsBytesInline(defaultBucketState)).toBe(false);
    expect(defaultBucketState.bucket).toBeUndefined();
    expect(defaultBucketState.size).toBe(64);

    const namedBucketState = storageEntryToObjectReferenceState(secondRef, projectDir);
    expect(holdsBytesInline(namedBucketState)).toBe(false);
    expect(namedBucketState.bucket).toBe('custom-bucket');
    expect(namedBucketState.size).toBe(32);
  });
});

describe('createStateStore.objectFile and resolveProjectObjectFile', () => {
  it('resolves content-addressed object files in .pyric/state and .pyric/state/hosted and permits reference entries past the inline limit', () => {
    const store = createStateStore(projectDir);
    const stateRoot = join(projectDir, '.pyric', 'state');
    const hostedRoot = join(stateRoot, 'hosted');

    const payloadState = new Uint8Array(32).fill(3);
    const payloadHosted = new Uint8Array(48).fill(5);
    const writtenState = writeObjectFile(payloadState, stateRoot);
    const writtenHosted = writeObjectFile(payloadHosted, hostedRoot);

    expect(store.objectFile?.(writtenState.sha256)).toBe(writtenState.file);
    expect(store.objectFile?.(writtenHosted.sha256)).toBe(writtenHosted.file);
    expect(store.objectFile?.('not-a-sha256')).toBeUndefined();
    expect(store.objectFile?.('0'.repeat(64))).toBeUndefined();

    expect(
      resolveProjectObjectFile(projectDir, {
        path: 'state/obj.bin',
        sha256: writtenState.sha256,
        size: writtenState.size,
      }),
    ).toBe(writtenState.file);
    expect(
      resolveProjectObjectFile(projectDir, {
        path: 'hosted/obj.bin',
        sha256: writtenHosted.sha256,
        size: writtenHosted.size,
      }),
    ).toBe(writtenHosted.file);

    // Reference entries in state.json carry 0 inline bytes even when their size exceeds inlineStorageLimit().
    restoreLimit = setInlineStorageLimitForTesting(10);
    const referenceSection = referenceStorage(
      [sampleInlineRecord('state/obj.bin', payloadState)],
      stateRoot,
    );
    expect(() => store.writeSection('storage', referenceSection)).not.toThrow();
    const loaded = store.load();
    expect(loaded?.storage).toEqual(referenceSection);
  });
});
