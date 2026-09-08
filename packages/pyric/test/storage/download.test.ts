/**
 * `getDownloadURL` returns a `data:` URI carrying the object's own bytes.
 *
 * The shape is the contract consumers hold: a `data:<contentType>;base64,`
 * prefix, a payload that decodes back to the exact bytes uploaded, and a URL
 * that `fetch` resolves in any context. An empty object is the edge worth
 * pinning: its payload is the empty string after the comma, not a truncated
 * URI.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  getDownloadURL,
  getStorageSandbox,
  ref,
  uploadBytes,
} from '../../src/storage/index.js';

const OPEN_RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} {
      allow read, write: if true;
    }
  }
}`;

function freshStorage(label: string) {
  const sandbox = initializeSandbox({});
  return getStorageSandbox(sandbox, {
    dbName: `pyric-storage-download-${label}-${Math.random().toString(36).slice(2, 10)}`,
    rules: OPEN_RULES,
  });
}

describe('getDownloadURL data URIs', () => {
  it('carries the declared content type and the object bytes', async () => {
    const fileRef = ref(freshStorage('content-type'), 'docs/hello.txt');
    await uploadBytes(fileRef, new TextEncoder().encode('hello'), { contentType: 'text/plain' });

    const url = await getDownloadURL(fileRef);

    expect(url.startsWith('data:text/plain')).toBe(true);
    expect(url).toContain(';base64,');
    expect(await (await fetch(url)).text()).toBe('hello');
  });

  it('falls back to application/octet-stream when the object has no content type', async () => {
    const fileRef = ref(freshStorage('no-content-type'), 'blobs/raw');
    await uploadBytes(fileRef, new Uint8Array([0, 1, 2, 255]));

    const url = await getDownloadURL(fileRef);

    expect(url.startsWith('data:application/octet-stream;base64,')).toBe(true);
    expect(new Uint8Array(await (await fetch(url)).arrayBuffer())).toEqual(
      new Uint8Array([0, 1, 2, 255]),
    );
  });

  it('encodes an empty object as an empty base64 payload', async () => {
    const fileRef = ref(freshStorage('empty'), 'docs/empty.txt');
    await uploadBytes(fileRef, new Uint8Array([]), { contentType: 'text/plain' });

    const url = await getDownloadURL(fileRef);

    expect(url.endsWith(';base64,')).toBe(true);
    expect(await (await fetch(url)).text()).toBe('');
  });

  it('round-trips bytes that are not valid UTF-8', async () => {
    const payload = new Uint8Array([0xff, 0xfe, 0x00, 0x80, 0x7f]);
    const fileRef = ref(freshStorage('binary'), 'blobs/binary.bin');
    await uploadBytes(fileRef, payload, { contentType: 'application/octet-stream' });

    const url = await getDownloadURL(fileRef);

    expect(new Uint8Array(await (await fetch(url)).arrayBuffer())).toEqual(payload);
  });
});
