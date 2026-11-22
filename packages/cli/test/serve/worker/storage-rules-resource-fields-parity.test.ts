/**
 * SharedWorker host parity for Storage rules `resource.*` persisted fields and
 * `{ uid }` default `request.auth.token` (#1342).
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { createMemoryBackend, initializeSandbox } from 'pyric/sandbox';
import { getFirestore } from 'pyric/firestore';
import { getStorageSandbox, ref, updateMetadata } from 'pyric/storage';
import {
  computeStorageEtag,
  getAdminStorageSandbox,
  getStorageService,
  replaceStorageRules,
} from 'pyric/storage/internal';

import { handleMessage, type HostCtx, type PortLike } from '../../../src/serve/worker/host.js';
import type { InboundMessage, OutboundMessage, ResMessage } from '../../../src/serve/worker/protocol.js';
import { bytesToBase64 } from '../../../src/serve/worker/protocol.js';
import { OPEN_STORAGE_RULES } from './permissive-services.js';

const SIX_BYTES = new Uint8Array([1, 2, 3, 4, 5, 6]);
const SIX_BYTES_MD5 = 'asHla8ePAxBZvnvoVFIsTA==';
const SIX_BYTES_CRC32C = 'T037qw==';

let seq = 0;

async function makeCtx(): Promise<HostCtx> {
  const sandbox = initializeSandbox();
  getStorageSandbox(sandbox, {
    dbName: `pyric-worker-1342-${++seq}-${Math.random().toString(36).slice(2, 8)}`,
    rules: OPEN_STORAGE_RULES,
  });
  await sandbox.enablePersistence({
    key: `worker-1342-${seq}`,
    injectedBackend: createMemoryBackend(),
  });
  return { db: getFirestore(sandbox), sandbox, instanceId: 'worker-1342', subs: new Map() };
}

function op(ctx: HostCtx, payload: Record<string, unknown>): Promise<ResMessage> {
  return new Promise((resolve) => {
    const port: PortLike = {
      postMessage(msg: OutboundMessage) {
        if (msg.t === 'res') resolve(msg);
      },
    };
    void handleMessage(ctx, port, { ...payload, t: 'op', id: `op-${++seq}` } as InboundMessage);
  });
}

describe('SharedWorker Storage rules resource.* and { uid } token parity (#1342)', () => {
  it('evaluates all seven resource fields and { uid } token across putBytes, chunked finishUpload, and setMetadata', async () => {
    const ctx = await makeCtx();
    const metadata = {
      cacheControl: 'public, max-age=60',
      contentDisposition: 'inline',
      contentEncoding: 'gzip',
      contentLanguage: 'en',
    };

    const single = await op(ctx, {
      method: 'storage.putBytes',
      path: 'single/six.bin',
      dataB64: bytesToBase64(SIX_BYTES),
      contentType: 'application/octet-stream',
      metadata,
    });
    expect(single.ok).toBe(true);

    const begun = await op(ctx, {
      method: 'storage.beginUpload',
      path: 'chunked/six.bin',
      size: SIX_BYTES.byteLength,
      contentType: 'application/octet-stream',
      metadata,
    });
    expect(begun.ok).toBe(true);
    if (!begun.ok) {
      throw new Error('beginUpload failed');
    }
    const uploadId = (begun.value as { uploadId: string }).uploadId;
    await op(ctx, { method: 'storage.putPart', uploadId, partIndex: 0, dataB64: bytesToBase64(SIX_BYTES.subarray(0, 3)) });
    await op(ctx, { method: 'storage.putPart', uploadId, partIndex: 1, dataB64: bytesToBase64(SIX_BYTES.subarray(3)) });
    const finished = await op(ctx, { method: 'storage.finishUpload', uploadId });
    expect(finished.ok).toBe(true);

    await replaceStorageRules(ctx.sandbox, `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{dir}/six.bin {
      allow get: if resource.md5Hash == '${SIX_BYTES_MD5}'
        && resource.crc32c == '${SIX_BYTES_CRC32C}'
        && resource.etag is string
        && resource.etag != ''
        && resource.cacheControl == 'public, max-age=60'
        && resource.contentDisposition == 'inline'
        && resource.contentEncoding == 'gzip'
        && resource.contentLanguage == 'en'
        && request.auth.uid == 'alice'
        && request.auth.token is map
        && request.auth.token.size() == 0
        && request.auth.token.get('admin', false) == false;
    }
  }
}`);

    for (const path of ['single/six.bin', 'chunked/six.bin']) {
      const readRes = await op(ctx, {
        method: 'storage.getBytes',
        path,
        actAs: { mode: 'as', uid: 'alice' },
      });
      expect(readRes.ok).toBe(true);
    }

    // Admin setMetadata advances metageneration while preserving md5Hash/crc32c and refreshing etag.
    const patched = await op(ctx, {
      method: 'storage.setMetadata',
      path: 'single/six.bin',
      actAs: { mode: 'admin' },
      patch: { customMetadata: { updatedBy: 'admin' } },
    });
    expect(patched.ok).toBe(true);

    const afterPatchRead = await op(ctx, {
      method: 'storage.getMetadata',
      path: 'single/six.bin',
      actAs: { mode: 'as', uid: 'alice' },
    });
    expect(afterPatchRead.ok).toBe(true);
    if (afterPatchRead.ok) {
      const meta = afterPatchRead.value as { md5Hash?: string };
      expect(meta.md5Hash).toBe(SIX_BYTES_MD5);
    }

    // Minting downloadTokens on first storage.getDownloadURL bumps metageneration and refreshes etag.
    const adminService = await getStorageService(getAdminStorageSandbox(ctx.sandbox));
    const beforeMint = await adminService.backend.getMetadata('chunked/six.bin');
    expect(beforeMint?.metageneration).toBe('1');

    const minted = await op(ctx, {
      method: 'storage.getDownloadURL',
      path: 'chunked/six.bin',
      actAs: { mode: 'as', uid: 'alice' },
    });
    expect(minted.ok).toBe(true);

    const afterMint = await adminService.backend.getMetadata('chunked/six.bin');
    expect(afterMint?.metageneration).toBe('2');
    expect(afterMint?.etag).not.toBe(beforeMint?.etag);
    expect(afterMint?.etag).toBe(computeStorageEtag(afterMint?.generation ?? '', '2'));
  });

  it('evaluates request.resource md5Hash, crc32c, and etag across putBytes, chunked uploads, and updateMetadata (#3258)', async () => {
    const ctx = await makeCtx();
    await replaceStorageRules(ctx.sandbox, `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /verified/{name} {
      allow create: if request.resource.size == 6
        && request.resource.md5Hash == '${SIX_BYTES_MD5}'
        && request.resource.crc32c == '${SIX_BYTES_CRC32C}'
        && request.resource.etag == null;
      allow update: if request.resource.md5Hash == resource.md5Hash
        && request.resource.crc32c == resource.crc32c
        && request.resource.etag is string
        && request.resource.etag == resource.etag;
    }
  }
}`);

    // Single-frame putBytes with matching bytes succeeds; wrong bytes fail.
    const okSingle = await op(ctx, {
      method: 'storage.putBytes',
      path: 'verified/single.bin',
      dataB64: bytesToBase64(SIX_BYTES),
      contentType: 'application/octet-stream',
    });
    expect(okSingle.ok).toBe(true);

    const badSingle = await op(ctx, {
      method: 'storage.putBytes',
      path: 'verified/bad-single.bin',
      dataB64: bytesToBase64(new Uint8Array([9, 9, 9, 9, 9, 9])),
      contentType: 'application/octet-stream',
    });
    expect(badSingle.ok).toBe(false);

    // Non-digest mismatch (size != 6) still fast-fails at storage.beginUpload.
    const badSizeBegin = await op(ctx, {
      method: 'storage.beginUpload',
      path: 'verified/wrong-size.bin',
      size: 2,
      contentType: 'application/octet-stream',
    });
    expect(badSizeBegin.ok).toBe(false);

    // Digest-guarded chunked upload defers at beginUpload, allows matching bytes at finishUpload, and denies mismatched bytes.
    const begunGood = await op(ctx, {
      method: 'storage.beginUpload',
      path: 'verified/chunked.bin',
      size: SIX_BYTES.byteLength,
      contentType: 'application/octet-stream',
    });
    expect(begunGood.ok).toBe(true);
    if (!begunGood.ok) {
      throw new Error('beginUpload failed');
    }
    const goodUploadId = (begunGood.value as { uploadId: string }).uploadId;
    await op(ctx, { method: 'storage.putPart', uploadId: goodUploadId, partIndex: 0, dataB64: bytesToBase64(SIX_BYTES) });
    const finishedGood = await op(ctx, { method: 'storage.finishUpload', uploadId: goodUploadId });
    expect(finishedGood.ok).toBe(true);

    const begunBad = await op(ctx, {
      method: 'storage.beginUpload',
      path: 'verified/bad-chunked.bin',
      size: SIX_BYTES.byteLength,
      contentType: 'application/octet-stream',
    });
    expect(begunBad.ok).toBe(true);
    if (!begunBad.ok) {
      throw new Error('beginUpload failed');
    }
    const badUploadId = (begunBad.value as { uploadId: string }).uploadId;
    await op(ctx, {
      method: 'storage.putPart',
      uploadId: badUploadId,
      partIndex: 0,
      dataB64: bytesToBase64(new Uint8Array([6, 5, 4, 3, 2, 1])),
    });
    const finishedBad = await op(ctx, { method: 'storage.finishUpload', uploadId: badUploadId });
    expect(finishedBad.ok).toBe(false);

    // Client metadata update carries stored md5Hash, crc32c, and pre-advance etag on request.resource.
    const updated = await updateMetadata(
      ref(getStorageSandbox(ctx.sandbox), 'verified/chunked.bin'),
      { customMetadata: { tag: 'v2' } },
    );
    expect(updated.md5Hash).toBe(SIX_BYTES_MD5);
    expect(updated.customMetadata).toEqual({ tag: 'v2' });
  });
});
