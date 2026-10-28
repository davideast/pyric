/**
 * Object generations (issue #1160).
 *
 * Production gives every version of an object its own generation, a numeric
 * string at microsecond magnitude that increases with each write
 * (`storage-upload-then-getmetadata.json` observed `'1779067804587568'`). Two
 * writes to one path in the same millisecond, or under a fixed sandbox clock,
 * must still get distinct, increasing generations, including after the object
 * is deleted, after a state restore, and after the store is reopened.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect } from 'bun:test';
import { initializeSandbox, type Sandbox } from 'pyric/sandbox';
import { getClock } from 'pyric/sandbox/internal';
import {
  deleteObject,
  getStorageSandbox,
  ref,
  uploadBytes,
  type FirebaseStorage,
} from '../../src/storage/index.js';
import { restoreStorageState, snapshotStorageState } from '../../src/storage/internal.js';

const OPEN_RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} {
      allow read, write: if true;
    }
  }
}`;

const FIXED_AT = Date.UTC(2030, 0, 1);

function uniqueDbName(label: string): string {
  return `pyric-storage-generation-${label}-${Math.random().toString(36).slice(2, 10)}`;
}

function openStorage(dbName: string): { sandbox: Sandbox; storage: FirebaseStorage } {
  const sandbox = initializeSandbox({});
  const storage = getStorageSandbox(sandbox, { dbName, rules: OPEN_RULES });
  return { sandbox, storage };
}

function fixedClockStorage(label: string): { sandbox: Sandbox; storage: FirebaseStorage } {
  const opened = openStorage(uniqueDbName(label));
  getClock(opened.sandbox).set(FIXED_AT);
  return opened;
}

async function write(storage: FirebaseStorage, path: string, body: string): Promise<string> {
  const result = await uploadBytes(ref(storage, path), new Blob([body]));
  return result.metadata.generation;
}

function expectStrictlyIncreasing(generations: readonly string[]): void {
  for (let i = 1; i < generations.length; i++) {
    expect(BigInt(generations[i]!)).toBeGreaterThan(BigInt(generations[i - 1]!));
  }
}

describe('object generations', () => {
  it('are numeric strings at the microsecond magnitude production uses', async () => {
    const { storage } = fixedClockStorage('shape');
    const generation = await write(storage, 'shape.txt', 'a');
    expect(generation).toMatch(/^[1-9][0-9]*$/);
    expect(generation).toBe(String(FIXED_AT * 1000));
  });

  it('differ and increase for overwrites under a fixed clock', async () => {
    const { storage } = fixedClockStorage('fixed');
    const generations: string[] = [];
    for (let i = 0; i < 5; i++) generations.push(await write(storage, 'fixed.txt', `v${i}`));
    expect(new Set(generations).size).toBe(5);
    expectStrictlyIncreasing(generations);
  });

  it('differ and increase for writes in the same wall-clock millisecond', async () => {
    const { storage } = openStorage(uniqueDbName('wall'));
    const generations: string[] = [];
    for (let i = 0; i < 20; i++) generations.push(await write(storage, 'wall.txt', `v${i}`));
    expect(new Set(generations).size).toBe(20);
    expectStrictlyIncreasing(generations);
  });

  it('differ for concurrent writes to one path', async () => {
    const { storage } = fixedClockStorage('concurrent');
    const generations = await Promise.all(
      Array.from({ length: 5 }, (_, i) => write(storage, 'concurrent.txt', `v${i}`)),
    );
    expect(new Set(generations).size).toBe(5);
  });

  it('are not reissued when a deleted object is written again', async () => {
    const { storage } = fixedClockStorage('delete');
    const first = await write(storage, 'gone.txt', 'a');
    await deleteObject(ref(storage, 'gone.txt'));
    const second = await write(storage, 'gone.txt', 'b');
    expect(BigInt(second)).toBeGreaterThan(BigInt(first));
  });

  it('are not reissued after the state is restored to an earlier version', async () => {
    const { storage } = fixedClockStorage('restore');
    await write(storage, 'restored.txt', 'a');
    const earlier = await snapshotStorageState(storage);
    const later = await write(storage, 'restored.txt', 'b');
    await restoreStorageState(storage, earlier);
    const next = await write(storage, 'restored.txt', 'c');
    expect(BigInt(next)).toBeGreaterThan(BigInt(later));
  });

  it('are not reissued after the store is reopened under the same fixed clock', async () => {
    const dbName = uniqueDbName('reopen');
    const before = openStorage(dbName);
    getClock(before.sandbox).set(FIXED_AT);
    const first = await write(before.storage, 'reopened.txt', 'a');
    const after = openStorage(dbName);
    getClock(after.sandbox).set(FIXED_AT);
    const second = await write(after.storage, 'reopened.txt', 'b');
    expect(BigInt(second)).toBeGreaterThan(BigInt(first));
  });

  it('let different objects written in one clock tick share the clock generation', async () => {
    const { storage } = fixedClockStorage('paths');
    const first = await write(storage, 'one.txt', 'a');
    const second = await write(storage, 'two.txt', 'b');
    expect(first).toBe(String(FIXED_AT * 1000));
    expect(second).toBe(first);
  });

  it('start each new version at metageneration 1', async () => {
    const { storage } = fixedClockStorage('metageneration');
    await write(storage, 'meta.txt', 'a');
    const result = await uploadBytes(ref(storage, 'meta.txt'), new Blob(['b']));
    expect(result.metadata.metageneration).toBe('1');
  });
});
