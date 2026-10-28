/**
 * Every CLI writer that carries Storage bytes inline in one JSON document
 * refuses a total past the named inline limit, before it encodes or writes:
 * the in-process `storage.json`, a browser `--persist` state file, a fixture
 * export, and a fork through the `sandbox` tool.
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeSandbox, type LocalSandbox } from 'pyric/sandbox';
import { BRANCH_STORE_RELATIVE } from 'pyric/sandbox/branches/store';
import { InlineStorageLimitError, setInlineStorageLimitForTesting } from 'pyric/sandbox/internal';
import { ref as storageRef, uploadBytes } from 'pyric/storage';
import { getAdminStorageSandbox } from 'pyric/storage/internal';

import { STORAGE_SIDECAR_RELATIVE, saveStorageSidecar } from '../../src/bridge/server/storage-sidecar.js';
import { buildFixture } from '../../src/bridge/surface/fixture.js';
import { createSurfaceContext, renderSurface } from '../../src/bridge/surface/index.js';
import { createStateStore } from '../../src/serve/state-store.js';

let projectDir: string;
let restoreLimit: (() => void) | undefined;
let nextStorageDb = 1;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'pyric-inline-limit-cli-'));
});

afterEach(() => {
  restoreLimit?.();
  restoreLimit = undefined;
  rmSync(projectDir, { recursive: true, force: true });
});

/** A sandbox holding two Storage objects of 6 and 5 bytes. */
async function sandboxWithObjects(): Promise<LocalSandbox> {
  const sandbox = initializeSandbox();
  const storage = getAdminStorageSandbox(sandbox, { dbName: `pyric-inline-limit-cli:${nextStorageDb++}` });
  await uploadBytes(storageRef(storage, 'a/one.bin'), new Uint8Array([1, 2, 3, 4, 5, 6]));
  await uploadBytes(storageRef(storage, 'b/two.bin'), new Uint8Array([7, 8, 9, 10, 11]));
  return sandbox;
}

/** A browser state file's Storage section: one inline object of `size` bytes. */
function inlineStorageSection(size: number): unknown[] {
  return [{
    dataBase64: Buffer.alloc(size, 7).toString('base64'),
    blobType: 'application/octet-stream',
    metadata: {
      bucket: 'pyric-default',
      fullPath: 'a/one.bin',
      name: 'one.bin',
      size,
      contentType: 'application/octet-stream',
      timeCreated: '2026-01-01T00:00:00.000Z',
      updated: '2026-01-01T00:00:00.000Z',
      generation: '1',
      metageneration: '1',
      customMetadata: {},
    },
  }];
}

describe('the in-process storage sidecar', () => {
  it('writes while the total fits', async () => {
    const sandbox = await sandboxWithObjects();
    restoreLimit = setInlineStorageLimitForTesting(11);
    await saveStorageSidecar(getAdminStorageSandbox(sandbox), projectDir);
    expect(existsSync(join(projectDir, STORAGE_SIDECAR_RELATIVE))).toBe(true);
  });

  it('refuses by name past the limit and writes nothing', async () => {
    const sandbox = await sandboxWithObjects();
    restoreLimit = setInlineStorageLimitForTesting(10);
    const refusal = saveStorageSidecar(getAdminStorageSandbox(sandbox), projectDir);
    await expect(refusal).rejects.toBeInstanceOf(InlineStorageLimitError);
    await expect(saveStorageSidecar(getAdminStorageSandbox(sandbox), projectDir)).rejects.toThrow(
      'The in-process storage file `.pyric/state/storage.json`',
    );
    expect(existsSync(join(projectDir, STORAGE_SIDECAR_RELATIVE))).toBe(false);
  });
});

describe('a fixture export', () => {
  it('refuses by name past the limit', async () => {
    const sandbox = await sandboxWithObjects();
    restoreLimit = setInlineStorageLimitForTesting(10);
    await expect(buildFixture(sandbox)).rejects.toBeInstanceOf(InlineStorageLimitError);
  });
});

describe('a browser --persist state file', () => {
  it('refuses a Storage section past the limit and leaves the file as it was', () => {
    const store = createStateStore(projectDir);
    store.writeSection('firestore', { version: 1, savedAt: 1, firestore: {} });
    const before = readFileSync(store.path, 'utf8');
    restoreLimit = setInlineStorageLimitForTesting(10);
    store.writeSection('storage', inlineStorageSection(10));
    const written = readFileSync(store.path, 'utf8');
    expect(() => store.writeSection('storage', inlineStorageSection(11))).toThrow(InlineStorageLimitError);
    expect(() => store.writeSection('storage', inlineStorageSection(11))).toThrow('`pyric sandbox --hosted`');
    expect(readFileSync(store.path, 'utf8')).toBe(written);
    expect(written).not.toBe(before);
  });

  it('refuses a section write that would rewrite a file already past the limit', () => {
    const store = createStateStore(projectDir);
    store.writeSection('storage', inlineStorageSection(11));
    restoreLimit = setInlineStorageLimitForTesting(10);
    expect(() => store.writeSection('firestore', { version: 1, savedAt: 2, firestore: {} })).toThrow(InlineStorageLimitError);
  });
});

describe('a fork through the sandbox tool', () => {
  it('fails naming the limit and leaves no branch directory', async () => {
    const sandbox = await sandboxWithObjects();
    const ctx = createSurfaceContext(sandbox, projectDir);
    const tool = renderSurface(undefined).tools.find((candidate) => candidate.name === 'sandbox');
    if (!tool) throw new Error('no rendered sandbox tool');
    restoreLimit = setInlineStorageLimitForTesting(10);
    const outcome = await tool.execute({ method: 'fork', args: { branch: 'large' } }, ctx).then(
      (result) => ({ result, error: undefined as unknown }),
      (error: unknown) => ({ result: undefined, error }),
    );
    const reported = outcome.error instanceof Error ? outcome.error.message : JSON.stringify(outcome.result);
    expect(outcome.result?.ok).not.toBe(true);
    expect(reported).toContain('MAX_INLINE_STORAGE_BYTES');
    const store = join(projectDir, BRANCH_STORE_RELATIVE);
    expect(existsSync(store) ? readdirSync(store) : []).toEqual([]);
  });
});
