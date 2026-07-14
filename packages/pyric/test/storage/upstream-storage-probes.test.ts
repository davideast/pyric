/**
 * Upstream-mined modular Storage probes (series PR 2).
 *
 * Sourced from firebase-js-sdk `packages/storage` (reference.ts slice,
 * string.test.ts percent-decode) against claimed COMPAT rows:
 *   S1. `maxDownloadSize` truncates (does not throw) — #55 / #56 / #60
 *   S2. overwrite last-write-wins — #35 promotion
 *   S3. `data_url` percent-decode + malformed encoding — #43
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  getBlob,
  getBytes,
  getMetadata,
  getStorageSandbox,
  ref,
  uploadBytes,
  uploadString,
} from '../../src/storage/index.js';

function uniqueDbName(label: string): string {
  return `pyric-storage-upstream-${label}-${Math.random().toString(36).slice(2, 10)}`;
}

function freshStorage(label: string) {
  const sandbox = initializeSandbox({});
  return getStorageSandbox(sandbox, { dbName: uniqueDbName(label) });
}

describe('S1 maxDownloadSize truncates (upstream storage probes)', () => {
  it('getBytes / getBlob return a truncated prefix when the object exceeds the cap', async () => {
    const storage = freshStorage('s1-truncate');
    const r = ref(storage, 'cap/three.bin');
    await uploadBytes(r, new Uint8Array([1, 2, 3]));

    const bytes = new Uint8Array(await getBytes(r, 2));
    expect(Array.from(bytes)).toEqual([1, 2]);

    const blob = await getBlob(r, 2);
    expect(blob.size).toBe(2);
    expect(Array.from(new Uint8Array(await blob.arrayBuffer()))).toEqual([1, 2]);
  });

  it('just-under-cap reads return the full object', async () => {
    const storage = freshStorage('s1-under');
    const r = ref(storage, 'cap/under.bin');
    await uploadBytes(r, new Uint8Array([9, 8, 7]));
    const buf = await getBytes(r, 3);
    expect(buf.byteLength).toBe(3);
  });
});

describe('S2 overwrite last-write-wins (upstream storage probes)', () => {
  it('second uploadBytes at the same path replaces bytes and metadata', async () => {
    const storage = freshStorage('s2-overwrite');
    const r = ref(storage, 'obj/same.bin');

    await uploadBytes(r, new Uint8Array([1, 1, 1]), { contentType: 'application/octet-stream' });
    await uploadBytes(r, new TextEncoder().encode('B'), { contentType: 'text/plain' });

    const buf = new TextDecoder().decode(new Uint8Array(await getBytes(r)));
    expect(buf).toBe('B');
    const md = await getMetadata(r);
    expect(md.contentType).toBe('text/plain');
    expect(md.size).toBe(1);
  });
});

describe('S3 data_url percent-decode (upstream storage probes)', () => {
  it('non-base64 data_url percent-decodes the body', async () => {
    const storage = freshStorage('s3-percent');
    const r = ref(storage, 'notes/space.txt');
    await uploadString(r, 'data:,a%20data', 'data_url');
    const text = new TextDecoder().decode(new Uint8Array(await getBytes(r)));
    expect(text).toBe('a data');
  });

  it('malformed percent-encoding throws storage/invalid-format', async () => {
    const storage = freshStorage('s3-bad-percent');
    const r = ref(storage, 'notes/bad.txt');
    await expect(uploadString(r, 'data:,%%0', 'data_url')).rejects.toMatchObject({
      code: 'storage/invalid-format',
    });
  });
});
