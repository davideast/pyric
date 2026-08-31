/**
 * Slice 5 — reference + basic operations.
 *
 * Covers:
 *   - StorageReference shape (fullPath, name, parent chain, root,
 *     bucket, toString) — survey Section 3
 *   - `ref(storage, path?)` and `ref(parent, path)` overloads with
 *     path normalization (leading/trailing slashes, doubles)
 *   - `uploadBytes` accepts Blob / Uint8Array / ArrayBuffer; emits
 *     `UploadResult` with populated metadata
 *   - `uploadString` for raw / base64 / data_url formats
 *   - `getBytes` / `getBlob` / `getDownloadURL` round-trips, maxDownloadSizeBytes cap,
 *     object-not-found, invalid-root-operation
 *   - `deleteObject` removes both stores
 */
import 'fake-indexeddb/auto';
import { describe, it, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  getStorageSandbox,
  ref,
  uploadBytes,
  uploadString,
  getBytes,
  getBlob,
  getDownloadURL,
  deleteObject,
} from '../../src/storage/index.js';

const OPEN_RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} {
      allow read, write: if true;
    }
  }
}`;

function uniqueDbName(label: string): string {
  return `pyric-storage-test-${label}-${Math.random().toString(36).slice(2, 10)}`;
}

function freshStorage(label: string) {
  const sandbox = initializeSandbox({});
  return getStorageSandbox(sandbox, { dbName: uniqueDbName(label), rules: OPEN_RULES });
}

describe('StorageReference', () => {
  it('root reference has empty fullPath, null parent, and equal root', () => {
    const storage = freshStorage('root');
    const root = ref(storage);
    expect(root.fullPath).toBe('');
    expect(root.name).toBe('');
    expect(root.parent).toBeNull();
    expect(root.root).toBe(root);
    expect(root.bucket).toBe('pyric-default');
  });

  it('ref(storage, path) populates fullPath and name from the last segment', () => {
    const storage = freshStorage('basic');
    const r = ref(storage, 'sessions/s1.json');
    expect(r.fullPath).toBe('sessions/s1.json');
    expect(r.name).toBe('s1.json');
    expect(r.parent?.fullPath).toBe('sessions');
    expect(r.root.fullPath).toBe('');
  });

  it('normalizes leading/trailing/double slashes', () => {
    const storage = freshStorage('normalize');
    expect(ref(storage, '/sessions/s1.json').fullPath).toBe('sessions/s1.json');
    expect(ref(storage, 'sessions/s1.json/').fullPath).toBe('sessions/s1.json');
    expect(ref(storage, 'sessions//s1.json').fullPath).toBe('sessions/s1.json');
    expect(ref(storage, '///').fullPath).toBe('');
  });

  it('ref(parent, child) joins relative to the parent', () => {
    const storage = freshStorage('relative');
    const sessions = ref(storage, 'sessions');
    const r = ref(sessions, 's1.json');
    expect(r.fullPath).toBe('sessions/s1.json');
  });

  it('ref(parent, child) rejects a structural parent with an unbranded storage handle', () => {
    const fakeParent = { fullPath: 'sessions', storage: {} };
    expect(() => ref(fakeParent as never, 's1.json')).toThrow(
      /not a FirebaseStorage handle/,
    );
  });

  it('parent traversal walks back to root', () => {
    const storage = freshStorage('parent-chain');
    const r = ref(storage, 'a/b/c/d.json');
    expect(r.parent?.fullPath).toBe('a/b/c');
    expect(r.parent?.parent?.fullPath).toBe('a/b');
    expect(r.parent?.parent?.parent?.fullPath).toBe('a');
    expect(r.parent?.parent?.parent?.parent?.fullPath).toBe('');
    expect(r.parent?.parent?.parent?.parent?.parent).toBeNull();
  });

  it('toString returns gs://bucket/path', () => {
    const storage = freshStorage('tostring');
    const r = ref(storage, 'sessions/s1.json');
    expect(r.toString()).toBe('gs://pyric-default/sessions/s1.json');
  });
});

describe('uploadBytes', () => {
  it('accepts a Blob and round-trips through getBlob', async () => {
    const storage = freshStorage('upload-blob');
    const r = ref(storage, 'sessions/s1.json');
    const payload = new Blob([JSON.stringify({ s: 1 })], { type: 'application/json' });
    const result = await uploadBytes(r, payload);
    expect(result.ref).toBe(r);
    expect(result.metadata.fullPath).toBe('sessions/s1.json');
    // Compare to `payload.type` rather than a literal — Bun's Blob
    // normalizes `application/json` to `application/json;charset=utf-8`
    // for text bodies, and what we record on metadata is whatever
    // the runtime's Blob reports (matches the JS SDK's pass-through
    // behavior).
    expect(result.metadata.contentType).toBe(payload.type);
    expect(result.metadata.size).toBe(payload.size);
    const read = await getBlob(r);
    expect(await read.text()).toBe('{"s":1}');
  });

  it('accepts a Uint8Array', async () => {
    const storage = freshStorage('upload-u8');
    const r = ref(storage, 'sessions/s1.bin');
    const bytes = new TextEncoder().encode('hello');
    await uploadBytes(r, bytes);
    const buf = await getBytes(r);
    expect(new TextDecoder().decode(new Uint8Array(buf))).toBe('hello');
  });

  it('accepts an ArrayBuffer', async () => {
    const storage = freshStorage('upload-ab');
    const r = ref(storage, 'sessions/s1.bin');
    const bytes = new TextEncoder().encode('arraybuf').buffer;
    await uploadBytes(r, bytes);
    const buf = await getBytes(r);
    expect(new TextDecoder().decode(new Uint8Array(buf))).toBe('arraybuf');
  });

  it("metadata.contentType overrides the Blob's intrinsic type", async () => {
    const storage = freshStorage('upload-content-type');
    const r = ref(storage, 'sessions/s1.json');
    const payload = new Blob(['{}'], { type: 'text/plain' });
    const result = await uploadBytes(r, payload, { contentType: 'application/json' });
    expect(result.metadata.contentType).toBe('application/json');
  });

  it('falls back to application/octet-stream when no type is supplied', async () => {
    const storage = freshStorage('upload-default-ct');
    const r = ref(storage, 'sessions/s1.bin');
    const bytes = new Uint8Array([0, 1, 2]);
    const result = await uploadBytes(r, bytes);
    expect(result.metadata.contentType).toBe('application/octet-stream');
  });

  it('round-trips customMetadata', async () => {
    const storage = freshStorage('upload-custom-md');
    const r = ref(storage, 'sessions/s1.json');
    await uploadBytes(r, new Blob(['{}']), {
      contentType: 'application/json',
      customMetadata: { sessionId: 'abc', tag: 'archive' },
    });
    const blob = await getBlob(r);
    expect(await blob.text()).toBe('{}');
  });

  it('throws on root reference', async () => {
    const storage = freshStorage('upload-root');
    const root = ref(storage);
    await expect(uploadBytes(root, new Blob(['x']))).rejects.toThrow(
      /invalid-root-operation/,
    );
  });
});

describe('uploadString', () => {
  it('raw format encodes UTF-8 and defaults contentType to text/plain', async () => {
    const storage = freshStorage('upstr-raw');
    const r = ref(storage, 'notes/s1.txt');
    const result = await uploadString(r, 'café');
    expect(result.metadata.contentType).toBe('text/plain;charset=utf-8');
    const blob = await getBlob(r);
    expect(await blob.text()).toBe('café');
  });

  it('base64 format decodes payload bytes', async () => {
    const storage = freshStorage('upstr-b64');
    const r = ref(storage, 'notes/s1.bin');
    // "hello" in base64
    await uploadString(r, 'aGVsbG8=', 'base64');
    const buf = await getBytes(r);
    expect(new TextDecoder().decode(new Uint8Array(buf))).toBe('hello');
  });

  it('data_url format infers contentType from the prefix', async () => {
    const storage = freshStorage('upstr-data-url');
    const r = ref(storage, 'notes/inline.json');
    const result = await uploadString(
      r,
      'data:application/json;base64,eyJzIjoxfQ==',
      'data_url',
    );
    expect(result.metadata.contentType).toBe('application/json');
    const blob = await getBlob(r);
    expect(await blob.text()).toBe('{"s":1}');
  });

  it('caller metadata.contentType beats data_url inference', async () => {
    const storage = freshStorage('upstr-data-url-override');
    const r = ref(storage, 'notes/inline.bin');
    const result = await uploadString(
      r,
      'data:application/json;base64,eyJzIjoxfQ==',
      'data_url',
      { contentType: 'application/octet-stream' },
    );
    expect(result.metadata.contentType).toBe('application/octet-stream');
  });

  it('throws storage/invalid-format on malformed data_url', async () => {
    const storage = freshStorage('upstr-bad-data-url');
    const r = ref(storage, 'notes/x.bin');
    // ST-B1/ST-B3: was a plain TypeError ("data_url format requires…");
    // now a StorageError carrying `.code === 'storage/invalid-format'`.
    await expect(uploadString(r, 'not-a-data-url', 'data_url')).rejects.toThrow(
      /storage\/invalid-format/,
    );
  });
});

describe('getBytes / getBlob', () => {
  it('throws storage/object-not-found for missing paths', async () => {
    const storage = freshStorage('not-found');
    const r = ref(storage, 'sessions/missing.json');
    await expect(getBytes(r)).rejects.toThrow(/object-not-found/);
    await expect(getBlob(r)).rejects.toThrow(/object-not-found/);
  });

  it('honors maxDownloadSizeBytes when the blob is too large', async () => {
    const storage = freshStorage('size-cap');
    const r = ref(storage, 'big.bin');
    await uploadBytes(r, new Uint8Array(1024));
    // Upstream truncates; does not throw (COMPAT #55).
    const truncated = await getBytes(r, 512);
    expect(truncated.byteLength).toBe(512);
    // Just under the cap → full object.
    const ok = await getBytes(r, 2048);
    expect(ok.byteLength).toBe(1024);
  });

  it('throws invalid-root-operation on root reads', async () => {
    const storage = freshStorage('root-read');
    const root = ref(storage);
    await expect(getBytes(root)).rejects.toThrow(/invalid-root-operation/);
    await expect(getDownloadURL(root)).rejects.toThrow(/invalid-root-operation/);
  });
});

describe('getDownloadURL', () => {
  it('returns a URL that fetches the uploaded bytes', async () => {
    const storage = freshStorage('download-url');
    const r = ref(storage, 'avatars/ada.txt');
    await uploadBytes(r, new Blob(['avatar-bytes'], { type: 'text/plain' }));

    const url = await getDownloadURL(r);
    try {
      expect(await (await fetch(url)).text()).toBe('avatar-bytes');
    } finally {
      URL.revokeObjectURL(url);
    }
  });
});

describe('deleteObject', () => {
  it('removes both blob and metadata', async () => {
    const storage = freshStorage('delete');
    const r = ref(storage, 'sessions/s1.json');
    await uploadBytes(r, new Blob(['x']));
    await deleteObject(r);
    await expect(getBlob(r)).rejects.toThrow(/object-not-found/);
  });

  it('is a no-op on missing paths (does not throw)', async () => {
    const storage = freshStorage('delete-missing');
    const r = ref(storage, 'sessions/never.json');
    await deleteObject(r); // should resolve without error
  });

  it('throws invalid-root-operation on root', async () => {
    const storage = freshStorage('delete-root');
    const root = ref(storage);
    await expect(deleteObject(root)).rejects.toThrow(/invalid-root-operation/);
  });
});
