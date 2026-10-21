/**
 * SharedWorker host: object generations (issue #1160).
 *
 * An overwrite under a fixed sandbox clock gets a new generation, so a range
 * read pinned to the earlier generation fails `storage/object-changed`
 * instead of returning the later write's bytes.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { getClock } from 'pyric/sandbox/internal';
import { getFirestore } from 'pyric/firestore';
import { getStorageSandbox } from 'pyric/storage';

import { handleMessage, type HostCtx, type PortLike } from '../../../src/serve/worker/host.js';
import type { InboundMessage, OutboundMessage, ResMessage } from '../../../src/serve/worker/protocol.js';
import { bytesToBase64 } from '../../../src/serve/worker/protocol.js';
import { OPEN_STORAGE_RULES } from './permissive-services.js';

function makeCtx(): HostCtx {
  const sandbox = initializeSandbox();
  const dbName = `pyric-storage-worker-generation-${Math.random().toString(36).slice(2, 10)}`;
  getStorageSandbox(sandbox, { dbName, rules: OPEN_STORAGE_RULES });
  getClock(sandbox).set(Date.UTC(2030, 0, 1));
  return { db: getFirestore(sandbox), sandbox, instanceId: 'storage-generation-test', subs: new Map() };
}

let opSeq = 0;
function op(ctx: HostCtx, payload: Record<string, unknown>): Promise<ResMessage> {
  return new Promise((resolve) => {
    const port: PortLike = {
      postMessage(msg: OutboundMessage) {
        if (msg.t === 'res') resolve(msg);
      },
    };
    void handleMessage(ctx, port, { ...payload, t: 'op', id: `gen-${++opSeq}` } as InboundMessage);
  });
}

async function putBytes(ctx: HostCtx, path: string, fill: number): Promise<{ generation: string }> {
  const res = await op(ctx, {
    method: 'storage.putBytes',
    path,
    dataB64: bytesToBase64(new Uint8Array(32).fill(fill)),
  });
  if (!res.ok) throw new Error(`putBytes failed: ${res.error.code}`);
  return res.value as { generation: string };
}

describe('SharedWorker host object generations', () => {
  it('gives an overwrite under a fixed clock a new, larger generation', async () => {
    const ctx = makeCtx();
    const first = await putBytes(ctx, 'media/clip.bin', 0x11);
    const second = await putBytes(ctx, 'media/clip.bin', 0x22);
    expect(BigInt(second.generation)).toBeGreaterThan(BigInt(first.generation));
  });

  it('refuses a range read pinned to the generation an overwrite replaced', async () => {
    const ctx = makeCtx();
    const first = await putBytes(ctx, 'media/clip.bin', 0x11);
    await putBytes(ctx, 'media/clip.bin', 0x22);
    const res = await op(ctx, {
      method: 'storage.getBytes',
      path: 'media/clip.bin',
      offset: 0,
      length: 8,
      expectedGeneration: first.generation,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('storage/object-changed');
  });
});
