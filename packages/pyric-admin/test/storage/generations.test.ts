/**
 * Object generations on both arms (issue #1160): each `File.save` and
 * `File.copy` onto one name under a fixed host clock gets a new, larger
 * generation, as production gives every object version its own.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { deleteApp, getApps } from '../../src/app/index.js';
import { getStorage, type File } from '../../src/storage/index.js';
import { STORAGE_ARMS } from './arms.ts';

afterEach(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app)));
});

const FIXED_AT = Date.UTC(2030, 0, 1);

async function generationOf(file: File): Promise<bigint> {
  const [metadata] = await file.getMetadata();
  return BigInt(metadata.generation);
}

describe.each(STORAGE_ARMS)('object generations, %s', (_arm, open) => {
  it('increase with each save and copy onto one name under a fixed clock', async () => {
    const bucket = getStorage(open({ fixedClockAt: FIXED_AT })).bucket();
    const file = bucket.file('media/clip.txt');
    await file.save('first');
    const first = await generationOf(file);
    await file.save('second');
    const second = await generationOf(file);
    await bucket.file('media/source.txt').save('third');
    await bucket.file('media/source.txt').copy(file);
    const third = await generationOf(file);
    expect(second).toBeGreaterThan(first);
    expect(third).toBeGreaterThan(second);
  });
});
