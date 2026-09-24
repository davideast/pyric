import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { getFirestore } from 'pyric/firestore';
import { getStorageSandbox } from 'pyric/storage';
import { bytesToBase64 } from '../../../src/serve/worker/protocol.js';
import { handleMessage, type HostCtx, type PortLike } from '../../../src/serve/worker/host.js';
import type { InboundMessage, OutboundMessage, ResMessage } from '../../../src/serve/worker/protocol.js';
import { OPEN_STORAGE_RULES } from './permissive-services.js';

let sequence = 0;

function makeCtx(): HostCtx {
  const sandbox = initializeSandbox();
  getStorageSandbox(sandbox, { dbName: `pyric-storage-set-metadata-${++sequence}`, rules: OPEN_STORAGE_RULES });
  return { db: getFirestore(sandbox), sandbox, instanceId: 'storage-set-metadata-test', subs: new Map() };
}

function op(ctx: HostCtx, payload: Record<string, unknown>): Promise<ResMessage> {
  return new Promise((resolve) => {
    const port: PortLike = { postMessage(message: OutboundMessage) { if (message.t === 'res') resolve(message); } };
    void handleMessage(ctx, port, { ...payload, t: 'op', id: `set-metadata-${++sequence}` } as InboundMessage);
  });
}

const ADMIN = { mode: 'admin' } as const;

describe('storage.setMetadata', () => {
  it('merges custom keys, removes a null one, and sets or removes the download tokens in one write', async () => {
    const ctx = makeCtx();
    await op(ctx, { method: 'storage.putBytes', path: 'media/take.wav', dataB64: bytesToBase64(new Uint8Array([1, 2, 3])), actAs: ADMIN });
    const set = await op(ctx, { method: 'storage.setMetadata', path: 'media/take.wav', actAs: ADMIN,
      patch: { customMetadata: { note: 'first', take: '1' }, downloadTokens: 'token-one', settable: { cacheControl: 'no-store' } } });
    expect(set.ok).toBe(true);
    const first = (set as { value: Record<string, unknown> }).value;
    expect(first.customMetadata).toEqual({ note: 'first', take: '1' });
    expect(first.downloadTokens).toBe('token-one');
    expect(first.cacheControl).toBe('no-store');
    expect(first.metageneration).toBe('2');

    const cleared = await op(ctx, { method: 'storage.setMetadata', path: 'media/take.wav', actAs: ADMIN,
      patch: { customMetadata: { note: null }, downloadTokens: null } });
    const second = (cleared as { value: Record<string, unknown> }).value;
    expect(second.customMetadata).toEqual({ take: '1' });
    expect(second.downloadTokens).toBeUndefined();
    expect(second.metageneration).toBe('3');
  });

  it('runs only on the admin lens, since it can change the download tokens', async () => {
    const ctx = makeCtx();
    await op(ctx, { method: 'storage.putBytes', path: 'media/take.wav', dataB64: bytesToBase64(new Uint8Array([1])), actAs: ADMIN });
    const refused = await op(ctx, { method: 'storage.setMetadata', path: 'media/take.wav', patch: { downloadTokens: 'forged' } });
    expect(refused.ok).toBe(false);
    expect((refused as { error: { code: string } }).error.code).toBe('storage/unauthorized');
  });

  it('refuses a patch whose custom values are not strings or null', async () => {
    const ctx = makeCtx();
    const refused = await op(ctx, { method: 'storage.setMetadata', path: 'media/take.wav', actAs: ADMIN, patch: { customMetadata: { note: 3 } } });
    expect(refused.ok).toBe(false);
  });
});
