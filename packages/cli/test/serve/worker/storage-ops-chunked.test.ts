import 'fake-indexeddb/auto';
import { describe, it, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { getFirestore } from 'pyric/firestore';
import { getStorageSandbox } from 'pyric/storage';

import {
  handleMessage,
  type HostCtx,
  type PortLike,
} from '../../../src/serve/worker/host.js';
import type {
  InboundMessage,
  OutboundMessage,
  ResMessage,
} from '../../../src/serve/worker/protocol.js';
import {
  bytesToBase64,
  base64ToBytes,
  MAX_STORAGE_OBJECT_BYTES,
  MAX_STORAGE_PART_BYTES,
  MAX_STORAGE_PART_B64_LENGTH,
} from '../../../src/serve/worker/protocol.js';
import { OPEN_STORAGE_RULES } from './permissive-services.js';

const SIZE_RESTRICTED_RULES = `
service firebase.storage {
  match /b/{bucket}/o {
    match /limited/{file} {
      allow write: if request.resource.size <= 1024;
      allow read: if true;
    }
  }
}`;

let dbSeq = 0;
function uniqueDbName(): string {
  return `pyric-storage-chunked-ops-${++dbSeq}-${Math.random().toString(36).slice(2, 8)}`;
}

function makeCtx(rules?: string): HostCtx {
  const sandbox = initializeSandbox();
  getStorageSandbox(sandbox, { dbName: uniqueDbName(), rules: rules ?? OPEN_STORAGE_RULES });
  return { db: getFirestore(sandbox), sandbox, instanceId: 'storage-chunked-ops-test', subs: new Map() };
}

let opSeq = 0;
function op(ctx: HostCtx, payload: Record<string, unknown>): Promise<ResMessage> {
  return new Promise((resolve) => {
    const port: PortLike = {
      postMessage(msg: OutboundMessage) {
        if (msg.t === 'res') resolve(msg);
      },
    };
    void handleMessage(ctx, port, {
      ...payload,
      t: 'op',
      id: `chunked-op-${++opSeq}`,
    } as InboundMessage);
  });
}

async function opOk(ctx: HostCtx, payload: Record<string, unknown>): Promise<unknown> {
  const res = await op(ctx, payload);
  if (!res.ok) throw new Error(`expected ok, got: ${res.error.code} — ${res.error.message}`);
  return res.value;
}

async function opFail(
  ctx: HostCtx,
  payload: Record<string, unknown>,
): Promise<{ code: string; message: string }> {
  const res = await op(ctx, payload);
  if (res.ok) throw new Error(`expected failure, got ok: ${JSON.stringify(res.value)}`);
  return res.error;
}

describe('storage worker ops — chunked transfer protocol (ADR 0015)', () => {
  it('stages chunked parts and finalizes upload into storage', async () => {
    const ctx = makeCtx();
    const part1 = new Uint8Array(1024);
    part1.fill(0xaa);
    const part2 = new Uint8Array(1024);
    part2.fill(0xbb);
    const totalSize = part1.byteLength + part2.byteLength;

    const begin = (await opOk(ctx, {
      method: 'storage.beginUpload',
      path: 'uploads/bundle.bin',
      size: totalSize,
      contentType: 'application/octet-stream',
      metadata: { customMetadata: { staged: 'true' } },
    })) as { uploadId: string };
    expect(typeof begin.uploadId).toBe('string');
    expect(begin.uploadId.length).toBeGreaterThan(0);

    // Object should not exist yet
    const notYet = await opFail(ctx, {
      method: 'storage.getBytes',
      path: 'uploads/bundle.bin',
    });
    expect(notYet.code).toBe('storage/object-not-found');

    await opOk(ctx, {
      method: 'storage.putPart',
      uploadId: begin.uploadId,
      partIndex: 0,
      dataB64: bytesToBase64(part1),
    });

    await opOk(ctx, {
      method: 'storage.putPart',
      uploadId: begin.uploadId,
      partIndex: 1,
      dataB64: bytesToBase64(part2),
    });

    const finished = (await opOk(ctx, {
      method: 'storage.finishUpload',
      uploadId: begin.uploadId,
    })) as { fullPath: string; size: number; contentType: string; customMetadata?: Record<string, string> };
    expect(finished.fullPath).toBe('uploads/bundle.bin');
    expect(finished.size).toBe(totalSize);
    expect(finished.contentType).toBe('application/octet-stream');
    expect(finished.customMetadata).toEqual({ staged: 'true' });

    // Verify whole object read
    const whole = (await opOk(ctx, {
      method: 'storage.getBytes',
      path: 'uploads/bundle.bin',
    })) as { dataB64: string; size: number };
    expect(whole.size).toBe(totalSize);
    const retrieved = base64ToBytes(whole.dataB64);
    expect(retrieved.subarray(0, 1024)).toEqual(part1);
    expect(retrieved.subarray(1024, 2048)).toEqual(part2);
  });

  it('supports ranged getBytes with generation checking', async () => {
    const ctx = makeCtx();
    const data = new Uint8Array(2048);
    for (let i = 0; i < 2048; i++) data[i] = i % 256;

    await opOk(ctx, {
      method: 'storage.putBytes',
      path: 'media/track.bin',
      dataB64: bytesToBase64(data),
      contentType: 'audio/raw',
    });

    const meta = (await opOk(ctx, {
      method: 'storage.getMetadata',
      path: 'media/track.bin',
    })) as { generation: string; size: number };

    // Range read slice [512..1024)
    const range = (await opOk(ctx, {
      method: 'storage.getBytes',
      path: 'media/track.bin',
      offset: 512,
      length: 512,
      expectedGeneration: meta.generation,
    })) as { dataB64: string; size: number; generation: string };
    expect(range.size).toBe(512);
    expect(range.generation).toBe(meta.generation);
    const slice = base64ToBytes(range.dataB64);
    expect(slice).toEqual(data.subarray(512, 1024));

    // Mismatched expectedGeneration fails with storage/object-changed
    const changedErr = await opFail(ctx, {
      method: 'storage.getBytes',
      path: 'media/track.bin',
      offset: 0,
      length: 100,
      expectedGeneration: '999999999',
    });
    expect(changedErr.code).toBe('storage/object-changed');
  });

  it('evaluates security rules at beginUpload against declared size and metadata', async () => {
    const ctx = makeCtx(SIZE_RESTRICTED_RULES);

    // Declared size 512 <= 1024 -> allowed
    const allowed = (await opOk(ctx, {
      method: 'storage.beginUpload',
      path: 'limited/small.dat',
      size: 512,
      contentType: 'application/octet-stream',
    })) as { uploadId: string };
    expect(allowed.uploadId).toBeDefined();

    // Declared size 2048 > 1024 -> denied before any bytes are sent
    const denied = await opFail(ctx, {
      method: 'storage.beginUpload',
      path: 'limited/oversized.dat',
      size: 2048,
      contentType: 'application/octet-stream',
    });
    expect(denied.code).toBe('storage/unauthorized');
  });

  it('rejects beginUpload exceeding MAX_STORAGE_OBJECT_BYTES (512 MiB) with storage/quota-exceeded', async () => {
    const ctx = makeCtx();
    const overLimit = MAX_STORAGE_OBJECT_BYTES + 1;
    const err = await opFail(ctx, {
      method: 'storage.beginUpload',
      path: 'huge/archive.iso',
      size: overLimit,
      contentType: 'application/octet-stream',
    });
    expect(err.code).toBe('storage/quota-exceeded');
  });

  it('rejects beginUpload on root reference with storage/invalid-root-operation', async () => {
    const ctx = makeCtx();
    const err = await opFail(ctx, {
      method: 'storage.beginUpload',
      path: '',
      size: 100,
    });
    expect(err.code).toBe('storage/invalid-root-operation');
  });

  it('rejects putPart exceeding MAX_STORAGE_PART_BYTES (4 MiB)', async () => {
    const ctx = makeCtx();
    const begin = (await opOk(ctx, {
      method: 'storage.beginUpload',
      path: 'check/part-size.bin',
      size: 10 * 1024 * 1024,
    })) as { uploadId: string };

    // Base64 string longer than allowed
    const oversizedB64 = 'A'.repeat(MAX_STORAGE_PART_B64_LENGTH + 4);
    const err = await opFail(ctx, {
      method: 'storage.putPart',
      uploadId: begin.uploadId,
      partIndex: 0,
      dataB64: oversizedB64,
    });
    expect(err.code).toBe('payload-too-large');
  });

  it('rejects finishUpload if staged bytes do not match declared size', async () => {
    const ctx = makeCtx();
    const begin = (await opOk(ctx, {
      method: 'storage.beginUpload',
      path: 'check/mismatch.bin',
      size: 2048,
    })) as { uploadId: string };

    // Only upload 1024 bytes instead of declared 2048
    const part = new Uint8Array(1024);
    await opOk(ctx, {
      method: 'storage.putPart',
      uploadId: begin.uploadId,
      partIndex: 0,
      dataB64: bytesToBase64(part),
    });

    const err = await opFail(ctx, {
      method: 'storage.finishUpload',
      uploadId: begin.uploadId,
    });
    expect(err.code).toBe('storage/invalid-argument');
  });

  it('abortUpload clears staged upload data', async () => {
    const ctx = makeCtx();
    const begin = (await opOk(ctx, {
      method: 'storage.beginUpload',
      path: 'check/aborted.bin',
      size: 1024,
    })) as { uploadId: string };

    await opOk(ctx, {
      method: 'storage.putPart',
      uploadId: begin.uploadId,
      partIndex: 0,
      dataB64: bytesToBase64(new Uint8Array(1024)),
    });

    await opOk(ctx, {
      method: 'storage.abortUpload',
      uploadId: begin.uploadId,
    });

    // finishUpload after abort should fail
    const err = await opFail(ctx, {
      method: 'storage.finishUpload',
      uploadId: begin.uploadId,
    });
    expect(err.code).toBe('storage/object-not-found');
  });

  it('evaluates rules under auth lens and allows admin lens bypass', async () => {
    const OWNER_RULES = `
service firebase.storage {
  match /b/{bucket}/o {
    match /users/{uid}/{file} {
      allow write, read: if request.auth.uid == uid;
    }
  }
}`;
    const ctx = makeCtx(OWNER_RULES);
    const asAlice = { actAs: { mode: 'as', uid: 'alice' } } as const;
    const asBob = { actAs: { mode: 'as', uid: 'bob' } } as const;
    const asAdmin = { actAs: { mode: 'admin' } } as const;

    // Alice begins upload to her own folder -> allowed
    const aliceUpload = (await opOk(ctx, {
      method: 'storage.beginUpload',
      path: 'users/alice/data.bin',
      size: 512,
      ...asAlice,
    })) as { uploadId: string };
    expect(aliceUpload.uploadId).toBeDefined();

    // Bob tries to begin upload to Alice's folder -> denied
    const bobDenied = await opFail(ctx, {
      method: 'storage.beginUpload',
      path: 'users/alice/hack.bin',
      size: 512,
      ...asBob,
    });
    expect(bobDenied.code).toBe('storage/unauthorized');

    // Admin begins upload to Alice's folder -> bypassed
    const adminUpload = (await opOk(ctx, {
      method: 'storage.beginUpload',
      path: 'users/alice/system.bin',
      size: 512,
      ...asAdmin,
    })) as { uploadId: string };
    expect(adminUpload.uploadId).toBeDefined();
  });
});
