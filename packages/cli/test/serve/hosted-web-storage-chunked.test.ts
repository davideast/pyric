import 'fake-indexeddb/auto';
import { createHash } from 'node:crypto';
import { describe, it, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { getFirestore } from 'pyric/firestore';
import { getStorageSandbox } from 'pyric/storage';

import { handleMessage, type HostCtx, type PortLike } from '../../src/serve/worker/host.js';
import type { InboundMessage, OutboundMessage } from '../../src/serve/worker/protocol.js';
import {
  MAX_STORAGE_OBJECT_BYTES,
  MAX_STORAGE_PART_BYTES,
} from '../../src/serve/worker/protocol.js';
import {
  getStorage,
  ref,
  uploadBytes,
  getBytes,
  getBlob,
  type ClientPort,
} from '../../src/serve/worker/client/storage.js';
import { wirePort } from '../../src/serve/worker/client/core.js';

const OPEN_RULES = `
service firebase.storage {
  match /{allPaths=**} {
    allow read, write: if true;
  }
}`;

let dbSeq = 0;
function makeWorkerCtx(): HostCtx {
  const sandbox = initializeSandbox();
  getStorageSandbox(sandbox, {
    dbName: `hosted-web-storage-chunked-${++dbSeq}-${Math.random().toString(36).slice(2, 8)}`,
    rules: OPEN_RULES,
  });
  return {
    db: getFirestore(sandbox),
    sandbox,
    instanceId: 'web-chunked-storage-test',
    subs: new Map(),
  };
}

function createClientBridgePort(ctx: HostCtx, onOp?: (op: Record<string, unknown>) => void): ClientPort {
  let clientPort: ClientPort;
  const hostPort: PortLike = {
    postMessage(msg: unknown) {
      queueMicrotask(() => {
        clientPort.onmessage?.(new MessageEvent('message', { data: msg }));
      });
    },
  };

  clientPort = {
    onmessage: null,
    start() {},
    close() {},
    postMessage(msg: unknown) {
      const inbound = msg as InboundMessage;
      if (inbound.t === 'op' && onOp) {
        onOp(inbound as unknown as Record<string, unknown>);
      }
      void handleMessage(ctx, hostPort, inbound);
    },
  };

  wirePort(clientPort);
  return clientPort;
}

function sha256(buf: Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex');
}

describe('hosted Web SDK pyric/storage chunked transfer (Slice B.5)', () => {
  it('uploads and downloads a 16 MiB payload via chunks over the worker port', async () => {
    const opsSeen: string[] = [];
    const ctx = makeWorkerCtx();
    const port = createClientBridgePort(ctx, (op) => {
      opsSeen.push(op.method as string);
    });

    const storage = getStorage({ __kind: 'client-db', port });
    const fileRef = ref(storage, 'videos/intro.mp4');

    // 16 MiB of pseudo-random binary data
    const size = 16 * 1024 * 1024;
    const payload = new Uint8Array(size);
    for (let i = 0; i < size; i += 4) {
      const val = (i * 1664525 + 1013904223) >>> 0;
      payload[i] = val & 0xff;
      payload[i + 1] = (val >>> 8) & 0xff;
      payload[i + 2] = (val >>> 16) & 0xff;
      payload[i + 3] = (val >>> 24) & 0xff;
    }
    const expectedHash = sha256(payload);

    // uploadBytes should transparently chunk into 4 MiB parts
    const uploadResult = await uploadBytes(fileRef, payload, { contentType: 'video/mp4' });
    expect(uploadResult.metadata.size).toBe(size);

    expect(opsSeen).toContain('storage.beginUpload');
    expect(opsSeen).toContain('storage.putPart');
    expect(opsSeen).toContain('storage.finishUpload');
    const putParts = opsSeen.filter((m) => m === 'storage.putPart');
    expect(putParts.length).toBe(4);

    // getBytes should transparently range-read and reassemble
    const downloadedBuf = await getBytes(fileRef);
    const downloaded = new Uint8Array(downloadedBuf);
    expect(downloaded.byteLength).toBe(size);
    expect(sha256(downloaded)).toBe(expectedHash);

    // getBlob should also reassemble
    const blob = await getBlob(fileRef);
    expect(blob.size).toBe(size);
    expect(blob.type).toBe('video/mp4');
    const blobBytes = new Uint8Array(await blob.arrayBuffer());
    expect(sha256(blobBytes)).toBe(expectedHash);
  });

  it('keeps single-shot storage.putBytes for small payloads (<= 4 MiB)', async () => {
    const opsSeen: string[] = [];
    const ctx = makeWorkerCtx();
    const port = createClientBridgePort(ctx, (op) => {
      opsSeen.push(op.method as string);
    });

    const storage = getStorage({ __kind: 'client-db', port });
    const fileRef = ref(storage, 'notes/small.txt');
    const payload = new TextEncoder().encode('short note');

    await uploadBytes(fileRef, payload, { contentType: 'text/plain' });
    expect(opsSeen).toContain('storage.putBytes');
    expect(opsSeen).not.toContain('storage.beginUpload');

    const readBack = await getBytes(fileRef);
    expect(new TextDecoder().decode(readBack)).toBe('short note');
  });

  it('rejects client-side if uploadBytes exceeds MAX_STORAGE_OBJECT_BYTES', async () => {
    const ctx = makeWorkerCtx();
    const port = createClientBridgePort(ctx);
    const storage = getStorage({ __kind: 'client-db', port });
    const fileRef = ref(storage, 'huge/fail.bin');

    const fakeHuge = {
      buffer: new ArrayBuffer(0),
      byteOffset: 0,
      byteLength: MAX_STORAGE_OBJECT_BYTES + 1,
    } as unknown as Uint8Array;

    await expect(uploadBytes(fileRef, fakeHuge)).rejects.toThrow(/512 MiB/);
  });
});
