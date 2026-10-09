import 'fake-indexeddb/auto';
import { describe, it, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { getStorageSandbox, ref, uploadBytes, getBytes, getMetadata } from '../../src/storage/index.js';
import { copyObject, getAdminStorageSandbox, uploadObject } from '../../src/storage/internal.js';

function sandboxWithStorage() {
  const sandbox = initializeSandbox();
  getStorageSandbox(sandbox, { dbName: `pyric-storage-copy-${Math.random().toString(36).slice(2, 10)}` });
  return sandbox;
}

describe('copyObject (admin plane)', () => {
  it('copies bytes, settable fields, custom metadata and download tokens into another bucket', async () => {
    const sandbox = sandboxWithStorage();
    const staging = getAdminStorageSandbox(sandbox, { bucket: 'staging' });
    const main = getAdminStorageSandbox(sandbox);
    await uploadObject(ref(staging, 'in/a.png'), new Uint8Array([1, 2, 3]), {
      contentType: 'image/png',
      customMetadata: { uid: 'u1', drop: 'x' },
    }, { downloadTokens: 'old' });

    const copied = await copyObject(ref(staging, 'in/a.png'), ref(main, 'out/a.png'), {
      customMetadata: { drop: null },
      downloadTokens: 'tok-1',
    });
    expect(copied).toMatchObject({ bucket: 'pyric-default', fullPath: 'out/a.png', contentType: 'image/png', size: 3 });
    expect(copied.customMetadata).toEqual({ uid: 'u1' });
    expect([...new Uint8Array(await getBytes(ref(main, 'out/a.png')))]).toEqual([1, 2, 3]);
    // The source is unchanged, and each bucket holds only its own path.
    expect((await getMetadata(ref(staging, 'in/a.png'))).customMetadata).toEqual({ uid: 'u1', drop: 'x' });
    await expect(getMetadata(ref(main, 'in/a.png'))).rejects.toThrow(/object-not-found/);
    await expect(getMetadata(ref(staging, 'out/a.png'))).rejects.toThrow(/object-not-found/);
  });

  it('refuses the client plane and a missing source', async () => {
    const sandbox = sandboxWithStorage();
    const admin = getAdminStorageSandbox(sandbox);
    const client = getStorageSandbox(sandbox);
    await expect(copyObject(ref(admin, 'missing'), ref(admin, 'copy'))).rejects.toThrow(/object-not-found/);
    await uploadBytes(ref(admin, 'a.txt'), new Uint8Array([1]));
    await expect(copyObject(ref(client, 'a.txt'), ref(client, 'b.txt'))).rejects.toThrow(/unauthorized/);
  });
});
