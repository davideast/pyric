import 'fake-indexeddb/auto';
import { createHash } from 'node:crypto';
import { describe, it, expect, afterEach } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { getFirestore } from 'pyric/firestore';
import { getStorageSandbox } from 'pyric/storage';

import { createBridge, type Bridge } from '../../src/bridge/server/bridge.js';
import { createConsumerSession } from '../../src/bridge/server/peer.js';
import {
  WORKER_RELAY_CAPABILITY,
  type BridgeMessage,
} from '../../src/bridge/protocol.js';
import {
  createRemoteSandboxCore,
  createRemoteSandboxHandle,
  type RemoteSandbox,
} from '../../src/remote/index.js';
import {
  handleMessage,
  type HostCtx,
  type PortLike,
} from '../../src/serve/worker/host.js';
import type {
  InboundMessage,
  OutboundMessage,
} from '../../src/serve/worker/protocol.js';
import {
  MAX_STORAGE_OBJECT_BYTES,
  MAX_STORAGE_PART_BYTES,
} from '../../src/serve/worker/protocol.js';

import { initializeApp, deleteApp, getApps } from 'pyric-admin/app';
import { getStorage } from 'pyric-admin/storage';

const SERVE_URL = 'http://localhost:5000';

const OPEN_RULES = `
service firebase.storage {
  match /{allPaths=**} {
    allow read, write: if true;
  }
}`;

afterEach(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app)));
});

function overWire<T>(frame: T): T {
  return JSON.parse(JSON.stringify(frame)) as T;
}

let dbSeq = 0;
function makeWorkerCtx(): HostCtx {
  const sandbox = initializeSandbox();
  getStorageSandbox(sandbox, {
    dbName: `hosted-admin-storage-chunked-${++dbSeq}-${Math.random().toString(36).slice(2, 8)}`,
    rules: OPEN_RULES,
  });
  return {
    db: getFirestore(sandbox),
    sandbox,
    instanceId: 'admin-chunked-storage-test',
    subs: new Map(),
  };
}

function connectTab(bridge: Bridge, ctx: HostCtx, onOp?: (op: Record<string, unknown>) => void): void {
  let gen = 0;
  const port: PortLike = {
    postMessage(raw: unknown) {
      const m = raw as OutboundMessage;
      if (m.t === 'res') {
        bridge.handleSandboxMessage(
          overWire(
            m.ok
              ? { type: 'worker-res', id: m.id, ok: true, value: m.value }
              : { type: 'worker-res', id: m.id, ok: false, error: m.error },
          ) as BridgeMessage,
          gen,
        );
      } else if (m.t === 'snap') {
        bridge.handleSandboxMessage(
          overWire({ type: 'worker-snap', subId: m.subId, value: m.value }) as BridgeMessage,
          gen,
        );
      }
    },
  };
  const send = (msg: BridgeMessage): void => {
    if (gen === 0) gen = bridge.peerGeneration();
    const wire = overWire(msg);
    if (wire.type === 'worker-op') {
      if (onOp) onOp(wire.op);
      void handleMessage(ctx, port, { ...wire.op, t: 'op', id: wire.id } as InboundMessage);
    } else if (wire.type === 'worker-sub') {
      void handleMessage(ctx, port, { ...wire.sub, t: 'sub', subId: wire.subId } as InboundMessage);
    } else if (wire.type === 'worker-unsub') {
      void handleMessage(ctx, port, { t: 'unsub', subId: wire.subId } as InboundMessage);
    }
  };
  bridge.registerSandboxPeer(send, [], 'fake-tab', [WORKER_RELAY_CAPABILITY]);
}

function connectRemote(bridge: Bridge): RemoteSandbox {
  let handleMsg: (msg: BridgeMessage) => void = () => {};
  const session = createConsumerSession(bridge, (msg) => handleMsg(overWire(msg)));
  const core = createRemoteSandboxCore(
    { send: (msg) => session.handleMessage(overWire(msg)) },
    { serveUrl: SERVE_URL },
  );
  handleMsg = core.handleMessage;
  core.start();
  return createRemoteSandboxHandle({
    channel: core.channel,
    serveUrl: SERVE_URL,
    close: () => core.dispose('remote sandbox connection closed by the client'),
  });
}

function makeStack(onOp?: (op: Record<string, unknown>) => void) {
  const bridge = createBridge({ mode: 'sandbox', version: 'test' });
  const ctx = makeWorkerCtx();
  connectTab(bridge, ctx, onOp);
  const remote = connectRemote(bridge);
  const app = initializeApp({ sandbox: remote });
  return { bridge, ctx, remote, app };
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

describe('hosted pyric-admin/storage chunked transfer (Slice B.4)', () => {
  it('saves and downloads a 20 MiB file across the bridge via chunks without frame drops', async () => {
    const opsSeen: string[] = [];
    const { app } = makeStack((op) => {
      opsSeen.push(op.method as string);
    });

    const bucket = getStorage(app).bucket();
    const file = bucket.file('media/big-narration.bin');

    // 20 MiB of pseudo-random non-repetitive binary
    const size = 20 * 1024 * 1024;
    const payload = Buffer.alloc(size);
    for (let i = 0; i < size; i += 4) {
      payload.writeUInt32LE((i * 1664525 + 1013904223) >>> 0, i);
    }
    const expectedHash = sha256(payload);

    await file.save(payload, { contentType: 'application/octet-stream' });

    // Verify wire protocol used chunked upload operations
    expect(opsSeen).toContain('storage.beginUpload');
    expect(opsSeen).toContain('storage.putPart');
    expect(opsSeen).toContain('storage.finishUpload');
    // 20 MiB in 4 MiB chunks = 5 putPart calls
    const putParts = opsSeen.filter((m) => m === 'storage.putPart');
    expect(putParts.length).toBe(5);

    // Verify existence
    expect(await file.exists()).toEqual([true]);

    // Download and verify integrity
    const [downloaded] = await file.download();
    expect(downloaded.byteLength).toBe(size);
    expect(sha256(downloaded)).toBe(expectedHash);
  });

  it('preserves fast path single-shot storage.putBytes for small payloads (<= 4 MiB)', async () => {
    const opsSeen: string[] = [];
    const { app } = makeStack((op) => {
      opsSeen.push(op.method as string);
    });

    const bucket = getStorage(app).bucket();
    const file = bucket.file('small/fast.json');
    const smallPayload = Buffer.from('{"hello":"world"}');

    await file.save(smallPayload, { contentType: 'application/json' });
    expect(opsSeen).toContain('storage.putBytes');
    expect(opsSeen).not.toContain('storage.beginUpload');

    const [downloaded] = await file.download();
    expect(downloaded.toString('utf8')).toBe('{"hello":"world"}');
  });

  it('rejects client-side if file size exceeds MAX_STORAGE_OBJECT_BYTES', async () => {
    const { app } = makeStack();
    const bucket = getStorage(app).bucket();
    const file = bucket.file('huge/fail.bin');

    // We can simulate an object > 512 MiB by creating a Buffer-like object with length > 512 MiB
    const fakeHugeBuffer = {
      buffer: new ArrayBuffer(0),
      byteOffset: 0,
      byteLength: MAX_STORAGE_OBJECT_BYTES + 1,
    } as unknown as Buffer;

    await expect(file.save(fakeHugeBuffer)).rejects.toThrow(/512 MiB/);
  });
});
