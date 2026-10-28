/**
 * The named ceiling on Storage bytes one inline document carries, and the
 * refusal every inline writer raises past it.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FirebaseError } from '../../../src/sandbox/internal/firebase-error.js';
import {
  InlineStorageLimitError,
  MAX_INLINE_STORAGE_BYTES,
  assertInlineStorageFits,
  base64DecodedLength,
  inlineStorageLimit,
  setInlineStorageLimitForTesting,
} from '../../../src/sandbox/internal/inline-storage-limit.js';
import * as internal from '../../../src/sandbox/internal/index.js';
import { captureFullState, initializeSandbox, type LocalSandbox } from '../../../src/sandbox/index.js';
import { fork } from '../../../src/sandbox/branches/index.js';
import { BRANCH_STORE_RELATIVE, saveBranch } from '../../../src/sandbox/branches/store.js';
import { deleteObject, ref as storageRef, uploadBytes } from '../../../src/storage/index.js';
import { getAdminStorageSandbox } from '../../../src/storage/internal.js';

let restoreLimit: (() => void) | undefined;
afterEach(() => {
  restoreLimit?.();
  restoreLimit = undefined;
});

let nextStorageDb = 1;

/** A sandbox holding two Storage objects of 6 and 5 bytes. */
async function sandboxWithObjects(): Promise<LocalSandbox> {
  const sandbox = initializeSandbox();
  const storage = getAdminStorageSandbox(sandbox, { dbName: `pyric-inline-limit:${nextStorageDb++}` });
  await uploadBytes(storageRef(storage, 'a/one.bin'), new Uint8Array([1, 2, 3, 4, 5, 6]));
  await uploadBytes(storageRef(storage, 'b/two.bin'), new Uint8Array([7, 8, 9, 10, 11]));
  return sandbox;
}

/** Every base64 boundary case: empty, each padding remainder, and unpadded forms. */
const BASE64_CASES: Array<[string, number]> = [
  ['', 0],
  ['AQ==', 1],
  ['AQI=', 2],
  ['AQID', 3],
  ['AQIDBA==', 4],
  ['AQ', 1],
  ['AQI', 2],
  ['AQIDBAU', 5],
];

describe('MAX_INLINE_STORAGE_BYTES', () => {
  it('is the engine string length less a 32 MiB reserve, read as base64', () => {
    expect(MAX_INLINE_STORAGE_BYTES).toBe(Math.floor((2 ** 29 - 24 - 32 * 1024 * 1024) / 4) * 3);
    expect(MAX_INLINE_STORAGE_BYTES).toBe(377_487_342);
    expect(inlineStorageLimit()).toBe(MAX_INLINE_STORAGE_BYTES);
  });

  it('is exported from the shared sandbox foundation', () => {
    expect(internal.MAX_INLINE_STORAGE_BYTES).toBe(MAX_INLINE_STORAGE_BYTES);
    expect(internal.InlineStorageLimitError).toBe(InlineStorageLimitError);
    expect(internal.assertInlineStorageFits).toBe(assertInlineStorageFits);
  });

  it('is lowered by the test seam and restored by the function it returns', () => {
    const restore = setInlineStorageLimitForTesting(10);
    expect(inlineStorageLimit()).toBe(10);
    restore();
    expect(inlineStorageLimit()).toBe(MAX_INLINE_STORAGE_BYTES);
    expect(() => setInlineStorageLimitForTesting(-1)).toThrow(RangeError);
  });
});

describe('base64DecodedLength', () => {
  it('counts decoded bytes for every padding remainder', () => {
    for (const [encoded, bytes] of BASE64_CASES) expect(base64DecodedLength(encoded)).toBe(bytes);
  });

  it('agrees with Buffer and with atob', () => {
    for (const [encoded, bytes] of BASE64_CASES) {
      expect(Buffer.from(encoded, 'base64').byteLength).toBe(bytes);
      const padded = encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '=');
      expect(atob(padded).length).toBe(bytes);
    }
  });

  it('answers the same without the Node Buffer global', () => {
    const withBuffer = BASE64_CASES.map(([encoded]) => base64DecodedLength(encoded));
    const saved = (globalThis as { Buffer?: unknown }).Buffer;
    delete (globalThis as { Buffer?: unknown }).Buffer;
    try {
      expect(typeof (globalThis as { Buffer?: unknown }).Buffer).toBe('undefined');
      expect(BASE64_CASES.map(([encoded]) => base64DecodedLength(encoded))).toEqual(withBuffer);
      restoreLimit = setInlineStorageLimitForTesting(3);
      expect(() => assertInlineStorageFits(4, { document: 'A document', instead: 'Do less.' })).toThrow(InlineStorageLimitError);
    } finally {
      (globalThis as { Buffer?: unknown }).Buffer = saved;
    }
  });
});

describe('InlineStorageLimitError', () => {
  it('is a FirebaseError naming the limit, the actual size, and what to do instead', () => {
    restoreLimit = setInlineStorageLimitForTesting(10);
    expect(() => assertInlineStorageFits(10, { document: 'A document', instead: 'Do less.' })).not.toThrow();
    let caught: unknown;
    try {
      assertInlineStorageFits(11, { document: 'The test document', instead: 'Use the other document.' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(InlineStorageLimitError);
    expect(caught).toBeInstanceOf(FirebaseError);
    const error = caught as InlineStorageLimitError;
    expect(error.code).toBe('storage/quota-exceeded');
    expect(error.storageBytes).toBe(11);
    expect(error.limitBytes).toBe(10);
    expect(error.message).toContain('11 bytes');
    expect(error.message).toContain('10 bytes');
    expect(error.message).toContain('MAX_INLINE_STORAGE_BYTES');
    expect(error.message).toContain('The test document');
    expect(error.message).toContain('Use the other document.');
  });
});

describe('inline state captures', () => {
  it('capture every object while the total fits', async () => {
    restoreLimit = setInlineStorageLimitForTesting(11);
    const state = await captureFullState(await sandboxWithObjects());
    expect(state.storage.map((object) => object.path)).toEqual(['a/one.bin', 'b/two.bin']);
  });

  it('refuse by name past the limit, before encoding a byte', async () => {
    const sandbox = await sandboxWithObjects();
    restoreLimit = setInlineStorageLimitForTesting(10);
    const refusal = captureFullState(sandbox);
    await expect(refusal).rejects.toBeInstanceOf(InlineStorageLimitError);
    await expect(captureFullState(sandbox)).rejects.toThrow('pyric snapshot');
  });
});

describe('branch files', () => {
  let projectDir: string | undefined;
  afterEach(() => {
    if (projectDir !== undefined) rmSync(projectDir, { recursive: true, force: true });
    projectDir = undefined;
  });

  it('refuse to save a branch whose Storage exceeds the limit, writing no directory', async () => {
    projectDir = mkdtempSync(join(tmpdir(), 'pyric-inline-limit-'));
    const branch = await fork(await captureFullState(await sandboxWithObjects()));
    restoreLimit = setInlineStorageLimitForTesting(10);
    await expect(saveBranch(projectDir, 'large', branch, { base: 'live' })).rejects.toBeInstanceOf(InlineStorageLimitError);
    const store = join(projectDir, BRANCH_STORE_RELATIVE);
    expect(existsSync(store) ? readdirSync(store) : []).toEqual([]);
    branch.sandbox.dispose();
  });

  it('refuse a base state past the limit even when the branch now holds less', async () => {
    projectDir = mkdtempSync(join(tmpdir(), 'pyric-inline-limit-'));
    const branch = await fork(await captureFullState(await sandboxWithObjects()));
    await deleteObject(storageRef(getAdminStorageSandbox(branch.sandbox), 'a/one.bin'));
    restoreLimit = setInlineStorageLimitForTesting(10);
    const refusal = saveBranch(projectDir, 'shrunk', branch, { base: 'live' });
    await expect(refusal).rejects.toThrow("A branch's `storage.json`");
    const store = join(projectDir, BRANCH_STORE_RELATIVE);
    expect(existsSync(store) ? readdirSync(store) : []).toEqual([]);
    branch.sandbox.dispose();
  });
});
