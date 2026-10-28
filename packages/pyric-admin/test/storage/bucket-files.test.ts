/**
 * `Bucket.getFiles` and `Bucket.deleteFiles` on both arms: the in-process
 * sandbox, and a remote handle on a SharedWorker host, which lists through the
 * host's `storage.listAll` op. The Node host runs the same remote arm; the app
 * scenario `test/apps/admin-storage-delete-prefix` drives it from a
 * firebase-admin backend under `pyric sandbox --hosted`.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { deleteApp, getApps } from '../../src/app/index.js';
import { getStorage, type Bucket } from '../../src/storage/index.js';
import { STORAGE_ARMS } from './arms.ts';

afterEach(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app)));
});

const UNDER = ['users/123/avatar.png', 'users/123/docs/a.txt', 'users/123/docs/b.txt'];
const OUTSIDE = ['users/1234/avatar.png', 'users/124/avatar.png', 'public/logo.png'];

async function seeded(bucket: Bucket): Promise<Bucket> {
  for (const name of [...UNDER, ...OUTSIDE]) await bucket.file(name).save(name);
  return bucket;
}

async function namesIn(bucket: Bucket, prefix?: string): Promise<string[]> {
  const [files] = await bucket.getFiles(prefix === undefined ? {} : { prefix });
  return files.map((file) => file.name);
}

describe.each(STORAGE_ARMS)('Bucket.getFiles and deleteFiles, %s', (_arm, open) => {
  it('getFiles({ prefix }) lists the files under it in name order, as handles that read', async () => {
    const bucket = await seeded(getStorage(open()).bucket());
    const [files, nextQuery, apiResponse] = await bucket.getFiles({ prefix: 'users/123/' });
    expect(files.map((file) => file.name)).toEqual(UNDER);
    expect(files.every((file) => file.bucket.name === bucket.name)).toBe(true);
    expect((await files[0]!.download())[0].toString()).toBe(UNDER[0]);
    expect(nextQuery).toEqual({ prefix: 'users/123/' });
    expect(apiResponse).toEqual({ kind: 'storage#objects' });
  });

  it('a prefix matches the start of a name, not a folder', async () => {
    const bucket = await seeded(getStorage(open()).bucket());
    expect(await namesIn(bucket, 'users/123')).toEqual([...UNDER, 'users/1234/avatar.png']);
    expect(await namesIn(bucket)).toEqual([...OUTSIDE, ...UNDER].sort());
    expect(await namesIn(bucket, 'nothing/')).toEqual([]);
  });

  it('a delimiter rolls subfolders up into apiResponse.prefixes', async () => {
    const bucket = await seeded(getStorage(open()).bucket());
    const [files, , apiResponse] = await bucket.getFiles({ prefix: 'users/123/', delimiter: '/' });
    expect(files.map((file) => file.name)).toEqual(['users/123/avatar.png']);
    expect(apiResponse.prefixes).toEqual(['users/123/docs/']);
  });

  it('maxResults gives one page and the next query resumes after it', async () => {
    const bucket = await seeded(getStorage(open()).bucket());
    const [first, nextQuery] = await bucket.getFiles({ prefix: 'users/', maxResults: 4 });
    expect(nextQuery).not.toBeNull();
    const [second, last] = await bucket.getFiles(nextQuery!);
    expect([...first, ...second].map((file) => file.name)).toEqual([...UNDER, ...OUTSIDE.filter((name) => name.startsWith('users/'))].sort());
    expect(last).toBeNull();
  });

  it('deleteFiles({ prefix }) deletes the files under it and leaves the others', async () => {
    const bucket = await seeded(getStorage(open()).bucket());
    await bucket.deleteFiles({ prefix: 'users/123/' });
    expect(await namesIn(bucket)).toEqual([...OUTSIDE].sort());
    for (const name of UNDER) expect(await bucket.file(name).exists()).toEqual([false]);
    await bucket.deleteFiles({ prefix: 'users/123/', force: true });
  });

  it('lists and deletes only the bucket it is called on, the default one named by storageBucket', async () => {
    const storage = getStorage(open({ storageBucket: 'demo-app.appspot.com' }));
    await seeded(storage.bucket());
    await storage.bucket('demo-app-archive').file('users/123/kept.txt').save('kept');
    await storage.bucket().deleteFiles({ prefix: 'users/' });
    expect(await namesIn(storage.bucket())).toEqual(['public/logo.png']);
    expect(await namesIn(storage.bucket('demo-app-archive'))).toEqual(['users/123/kept.txt']);
  });

  it('refuses the callback form instead of never calling it', async () => {
    const bucket = getStorage(open()).bucket();
    const callback = (() => {}) as unknown as Parameters<Bucket['getFiles']>[0];
    await expect(bucket.getFiles(callback)).rejects.toThrow(/callback form is not supported/);
    await expect(bucket.deleteFiles(callback)).rejects.toThrow(/callback form is not supported/);
  });
});
