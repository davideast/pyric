/**
 * Capture S's cleanup removes every object under the run prefix and reads the
 * prefix back, even when the sequence threw or a delete failed, and reports a
 * failure as an invariant, not a throw. The bucket is a fake; nothing reaches
 * the network.
 */
import { describe, expect, test } from 'bun:test';
import { runWithStorageCleanup, type RunObjects } from '../../../../src/capture/storage-live/live-capture.ts';

const PREFIX = 'pyric_oracle/run-1';

/** A fake bucket: object paths in a set; `failRemove` names a path whose delete rejects. */
function fakeBucket(initial: string[] = [], failRemove: string | null = null): { objects: RunObjects; paths: Set<string>; calls: string[] } {
  const paths = new Set(initial);
  const calls: string[] = [];
  const objects: RunObjects = {
    async list(prefix) {
      calls.push(`list ${prefix}`);
      return [...paths].filter((path) => path.startsWith(`${prefix}/`));
    },
    async remove(path) {
      calls.push(`remove ${path}`);
      if (path === failRemove) throw new Error('storage/unknown');
      paths.delete(path);
    },
  };
  return { objects, paths, calls };
}

describe('runWithStorageCleanup', () => {
  test('removes what the sequence left under the prefix and reads it back empty', async () => {
    const bucket = fakeBucket();
    const run = await runWithStorageCleanup('fake', bucket.objects, PREFIX, async () => {
      bucket.paths.add(`${PREFIX}/a.bin`);
      bucket.paths.add(`${PREFIX}/nested/x/one.txt`);
      bucket.paths.add('elsewhere/kept.bin');
      return 'done';
    });
    expect(run.result).toBe('done');
    expect(run.invariants).toEqual({ runPrefixEmpty: true, accountsDeleted: true });
    expect(run.failures).toEqual([]);
    expect([...bucket.paths]).toEqual(['elsewhere/kept.bin']);
    expect(bucket.calls.at(-1)).toBe(`list ${PREFIX}`);
  });

  test('refuses a prefix that already holds objects, before the sequence runs', async () => {
    const bucket = fakeBucket([`${PREFIX}/stale.bin`]);
    let ran = false;
    await expect(runWithStorageCleanup('fake', bucket.objects, PREFIX, async () => { ran = true; })).rejects.toThrow(/already holds 1 objects/);
    expect(ran).toBe(false);
    expect(bucket.paths.has(`${PREFIX}/stale.bin`)).toBe(true);
  });

  test('keeps the sequence error and still cleans up when the sequence throws', async () => {
    const bucket = fakeBucket();
    const run = await runWithStorageCleanup('fake', bucket.objects, PREFIX, async () => {
      bucket.paths.add(`${PREFIX}/half.bin`);
      throw new Error('sequence failed');
    });
    expect(run.error?.message).toBe('sequence failed');
    expect(run.invariants.runPrefixEmpty).toBe(true);
    expect(bucket.paths.size).toBe(0);
  });

  test('a failed delete is an invariant failure, and the other objects are still removed', async () => {
    const bucket = fakeBucket([], `${PREFIX}/stuck.bin`);
    const run = await runWithStorageCleanup('fake', bucket.objects, PREFIX, async () => {
      for (const name of ['a.bin', 'stuck.bin', 'z.bin']) bucket.paths.add(`${PREFIX}/${name}`);
    });
    expect(run.invariants).toEqual({ runPrefixEmpty: false, accountsDeleted: true });
    expect(run.failures).toEqual([`remove ${PREFIX}/stuck.bin: storage/unknown`]);
    expect([...bucket.paths]).toEqual([`${PREFIX}/stuck.bin`]);
  });

  test('stops writers before listing, deletes the accounts after the objects, and a failed shutdown is an invariant failure', async () => {
    const bucket = fakeBucket();
    const order: string[] = [];
    const run = await runWithStorageCleanup('fake', bucket.objects, PREFIX, async () => {
      bucket.paths.add(`${PREFIX}/a.bin`);
    }, {
      quiesce: async () => { order.push(`quiesce after ${bucket.calls.length} calls`); },
      shutdown: async () => {
        order.push(`shutdown with ${bucket.paths.size} objects left`);
        throw new Error('delete account failed');
      },
    });
    expect(order).toEqual(['quiesce after 1 calls', 'shutdown with 0 objects left']);
    expect(run.invariants).toEqual({ runPrefixEmpty: true, accountsDeleted: false });
    expect(run.failures).toEqual(['shutdown: delete account failed']);
  });
});
