import 'fake-indexeddb/auto';
import { describe, expect, test } from 'bun:test';
import { createMemoryBackend, initializeSandbox } from 'pyric/sandbox';
import { getFirestore } from 'pyric/firestore';
import { getStorageSandbox, ref as sandboxStorageRef, updateMetadata } from 'pyric/storage';
import {
  InMemoryStorageTriggerDelivery,
  RemoteStorageTriggerDelivery,
  type StorageDeliveryReadyInfo,
  type StorageMutationNotification,
} from '../../src/functions/storage/delivery.js';
import { computeCrc32cBase64 } from '../../src/functions/storage/event.js';
import { cleanupPort, handleMessage, type HostCtx, type PortLike } from '../../src/serve/worker/host.js';
import type { OutboundMessage } from '../../src/serve/worker/protocol.js';
import type { StorageSubscriptionSnapWire } from '../../src/serve/worker/host/storage-subscriptions.js';

async function createWorkerCtx(storageBucket?: string): Promise<HostCtx> {
  const suffix = Math.random().toString(36).slice(2, 9);
  const sandbox = initializeSandbox();
  await sandbox.enablePersistence({
    key: `storage-sub-persist-${suffix}`,
    injectedBackend: createMemoryBackend(),
  });
  getStorageSandbox(sandbox, {
    dbName: `storage-sub-test-${suffix}`,
    rules: 'service firebase.storage { match /{allPaths=**} { allow read, write: if true; } }',
  });
  const ctx: HostCtx = {
    db: getFirestore(sandbox),
    sandbox,
    instanceId: 'storage-sub-host',
    subs: new Map(),
  };
  if (storageBucket !== undefined) {
    ctx.appOptions = { storageBucket };
  }
  return ctx;
}

describe('Storage trigger delivery adapters and worker subscription', () => {
  test('InMemoryStorageTriggerDelivery clones notifications and unsubscribes cleanly', () => {
    const delivery = new InMemoryStorageTriggerDelivery({
      defaultBucket: 'demo-project.appspot.com',
    });
    const seen: StorageMutationNotification[] = [];
    let readyInfo: StorageDeliveryReadyInfo | undefined;

    const unsubscribe = delivery.subscribe(
      (notification) => {
        seen.push(notification);
      },
      (info) => {
        readyInfo = info;
      },
    );

    expect(readyInfo).toEqual({ defaultBucket: 'demo-project.appspot.com' });

    const original: StorageMutationNotification = {
      op: 'object_put',
      storeBucket: 'pyric-default',
      bucketName: 'demo-project.appspot.com',
      path: 'photos/one.jpg',
      at: 1_700_000_000_000,
      after: {
        fullPath: 'photos/one.jpg',
        bucket: 'demo-project.appspot.com',
        generation: '1',
        metageneration: '1',
        timeCreated: '2026-11-21T00:00:00.000Z',
        updated: '2026-11-21T00:00:00.000Z',
        size: 3,
      },
    };
    delivery.emit(original);
    original.path = 'mutated-after-emit';
    expect(seen).toHaveLength(1);
    expect(seen[0]?.path).toBe('photos/one.jpg');

    unsubscribe();
    delivery.emit(original);
    expect(seen).toHaveLength(1);
  });

  test('RemoteStorageTriggerDelivery deduplicates reconnect ready snaps and forwards mutations and errors', () => {
    let capturedSnapHandler: ((snap: unknown) => void) | undefined;
    let capturedErrorHandler: ((err: Error & { code: string }) => void) | undefined;
    let subscribedPayload: unknown;
    let unsubscribed = false;

    const delivery = new RemoteStorageTriggerDelivery(
      {
        subscribe(sub, onSnap, onError) {
          subscribedPayload = sub;
          capturedSnapHandler = onSnap;
          capturedErrorHandler = onError;
          return () => {
            unsubscribed = true;
          };
        },
      },
      { defaultBucket: 'demo-project.appspot.com' },
    );

    const readyCalls: StorageDeliveryReadyInfo[] = [];
    const mutations: StorageMutationNotification[] = [];
    const errors: unknown[] = [];

    const stop = delivery.subscribe(
      (item) => mutations.push(item),
      (info) => readyCalls.push(info),
      (err) => errors.push(err),
    );

    expect(subscribedPayload).toEqual({
      target: { service: 'storage', defaultBucket: 'demo-project.appspot.com' },
      actAs: { mode: 'admin' },
    });

    capturedSnapHandler?.({ kind: 'ready', defaultBucket: 'demo-project.appspot.com' });
    capturedSnapHandler?.({ kind: 'ready', defaultBucket: 'demo-project.appspot.com' });
    expect(readyCalls).toEqual([{ defaultBucket: 'demo-project.appspot.com' }]);

    capturedSnapHandler?.({
      kind: 'mutation',
      op: 'object_put',
      storeBucket: 'pyric-default',
      bucketName: 'demo-project.appspot.com',
      path: 'a/b.txt',
      at: 1234,
      rollback: false,
      after: {
        fullPath: 'a/b.txt',
        bucket: 'demo-project.appspot.com',
        generation: '1',
        metageneration: '1',
        timeCreated: '2026-11-21T00:00:00.000Z',
        updated: '2026-11-21T00:00:00.000Z',
        size: 5,
        crc32c: 'AAAAAA==',
      },
    } satisfies StorageSubscriptionSnapWire);
    expect(mutations).toHaveLength(1);
    expect(mutations[0]?.path).toBe('a/b.txt');

    const failErr = Object.assign(new Error('unavailable'), { code: 'unavailable' });
    capturedErrorHandler?.(failErr);
    expect(errors).toEqual([failErr]);

    stop();
    expect(unsubscribed).toBe(true);
  });

  test('worker storage subscription enforces admin lens and relays FIFO mutations with cached crc32c', async () => {
    const ctx = await createWorkerCtx();
    const frames: OutboundMessage[] = [];
    const port: PortLike = {
      postMessage(raw) {
        frames.push(raw as OutboundMessage);
      },
    };

    // Non-admin subscription is refused immediately with storage/unauthorized.
    await handleMessage(ctx, port, {
      t: 'sub',
      subId: 'sub-unauth',
      target: { service: 'storage' },
    });
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      t: 'snap',
      subId: 'sub-unauth',
      value: { __error: { code: 'storage/unauthorized' } },
    });

    // Admin subscription receives immediate ready snap without pre-seeding defaultBucketNamesByHost,
    // so a modern .firebasestorage.app client can still adopt the primary default bucket.
    await handleMessage(ctx, port, {
      t: 'sub',
      subId: 'sub-admin',
      target: { service: 'storage', defaultBucket: 'demo-project.appspot.com' },
      actAs: { mode: 'admin' },
    });
    expect(frames[1]).toEqual({
      t: 'snap',
      subId: 'sub-admin',
      value: { kind: 'ready', defaultBucket: 'demo-project.appspot.com' },
    });

    // Upload multi-chunk (> 64 KiB) payload, then overwrite, then delete rapidly to prove FIFO order
    // and cached before.crc32c preservation across overwrite and delete.
    const largeBytes = new Uint8Array(70_000);
    for (let index = 0; index < largeBytes.byteLength; index += 1) {
      largeBytes[index] = (index * 31 + 7) & 0xff;
    }
    const expectedLargeCrc = computeCrc32cBase64(largeBytes);
    const secondBytes = Buffer.from('123456789', 'utf8');
    const expectedSecondCrc = computeCrc32cBase64(secondBytes);

    await handleMessage(ctx, port, {
      t: 'op',
      id: 'op-put-1',
      method: 'storage.putBytes',
      bucket: 'demo-project.firebasestorage.app',
      defaultBucket: 'demo-project.firebasestorage.app',
      path: 'nested/large.bin',
      dataB64: Buffer.from(largeBytes).toString('base64'),
      contentType: 'application/octet-stream',
      actAs: { mode: 'admin' },
    });
    await handleMessage(ctx, port, {
      t: 'op',
      id: 'op-put-2',
      method: 'storage.putBytes',
      path: 'nested/large.bin',
      dataB64: secondBytes.toString('base64'),
      contentType: 'text/plain',
      actAs: { mode: 'admin' },
    });
    await handleMessage(ctx, port, {
      t: 'op',
      id: 'op-del-1',
      method: 'storage.deleteObject',
      path: 'nested/large.bin',
      actAs: { mode: 'admin' },
    });

    const deadline = Date.now() + 3_000;
    while (
      frames.filter((frame) => frame.t === 'snap' && frame.subId === 'sub-admin').length < 4 &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const adminSnaps = frames
      .filter(
        (frame): frame is Extract<OutboundMessage, { t: 'snap' }> =>
          frame.t === 'snap' && frame.subId === 'sub-admin',
      )
      .map((frame) => frame.value as StorageSubscriptionSnapWire);

    expect(adminSnaps.map((snap) => (snap.kind === 'ready' ? 'ready' : snap.op))).toEqual([
      'ready',
      'object_put',
      'object_put',
      'object_delete',
    ]);

    const firstPut = adminSnaps[1];
    const secondPut = adminSnaps[2];
    const deletion = adminSnaps[3];
    if (
      firstPut?.kind !== 'mutation' ||
      secondPut?.kind !== 'mutation' ||
      deletion?.kind !== 'mutation'
    ) {
      throw new Error('expected three mutation snaps');
    }

    expect(firstPut.storeBucket).toBe('pyric-default');
    expect(firstPut.bucketName).toBe('demo-project.firebasestorage.app');
    expect(firstPut.after?.crc32c).toBe(expectedLargeCrc);
    expect(secondPut.before?.crc32c).toBe(expectedLargeCrc);
    expect(secondPut.after?.crc32c).toBe(expectedSecondCrc);
    expect(deletion.before?.crc32c).toBe(expectedSecondCrc);

    cleanupPort(ctx, port);
    await handleMessage(ctx, port, {
      t: 'op',
      id: 'op-after-cleanup',
      method: 'storage.putBytes',
      path: 'nested/after.bin',
      dataB64: secondBytes.toString('base64'),
      actAs: { mode: 'admin' },
    });
    const afterCleanupSnaps = frames.filter(
      (frame) => frame.t === 'snap' && frame.subId === 'sub-admin',
    );
    expect(afterCleanupSnaps).toHaveLength(4);
  });

  test('marks storage.rollbackUpload mutations with rollback: true for both new-object delete and overwrite restore', async () => {
    const ctx = await createWorkerCtx();
    const frames: OutboundMessage[] = [];
    const port: PortLike = {
      postMessage(raw) {
        frames.push(raw as OutboundMessage);
      },
    };

    await handleMessage(ctx, port, {
      t: 'sub',
      subId: 'sub-rollback',
      target: { service: 'storage', defaultBucket: 'demo-project.appspot.com' },
      actAs: { mode: 'admin' },
    });

    const waitForRes = async (id: string): Promise<Record<string, unknown>> => {
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline) {
        const match = frames.find(
          (frame): frame is Extract<OutboundMessage, { t: 'res' }> =>
            frame.t === 'res' && frame.id === id,
        );
        if (match !== undefined) {
          if (!match.ok) {
            throw new Error(`unexpected op error ${match.error.code}: ${match.error.message}`);
          }
          return match.value as Record<string, unknown>;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`timed out waiting for response ${id}`);
    };

    // 1. Canceled new upload -> rollbackUpload deletes generation with rollback: true.
    await handleMessage(ctx, port, {
      t: 'op',
      id: 'rb-new-put',
      method: 'storage.putBytes',
      path: 'rollback/new-item.txt',
      dataB64: Buffer.from('temp-new', 'utf8').toString('base64'),
      rollback: true,
      actAs: { mode: 'admin' },
    });
    const newCommitted = await waitForRes('rb-new-put');
    const newToken = String(newCommitted.rollbackToken ?? '');
    expect(newToken.length).toBeGreaterThan(0);

    await handleMessage(ctx, port, {
      t: 'op',
      id: 'rb-new-undo',
      method: 'storage.rollbackUpload',
      rollbackToken: newToken,
      actAs: { mode: 'admin' },
    });
    expect(await waitForRes('rb-new-undo')).toEqual({ deleted: true, restored: false });

    // 2. Seed v1, overwrite with v2 (rollback: true), then rollbackUpload restores v1 with rollback: true.
    await handleMessage(ctx, port, {
      t: 'op',
      id: 'rb-v1-seed',
      method: 'storage.putBytes',
      path: 'rollback/existing-item.txt',
      dataB64: Buffer.from('stable-v1', 'utf8').toString('base64'),
      actAs: { mode: 'admin' },
    });
    await waitForRes('rb-v1-seed');

    await handleMessage(ctx, port, {
      t: 'op',
      id: 'rb-v2-put',
      method: 'storage.putBytes',
      path: 'rollback/existing-item.txt',
      dataB64: Buffer.from('canceled-v2', 'utf8').toString('base64'),
      rollback: true,
      actAs: { mode: 'admin' },
    });
    const overwriteCommitted = await waitForRes('rb-v2-put');
    const overwriteToken = String(overwriteCommitted.rollbackToken ?? '');
    expect(overwriteToken.length).toBeGreaterThan(0);

    await handleMessage(ctx, port, {
      t: 'op',
      id: 'rb-v2-undo',
      method: 'storage.rollbackUpload',
      rollbackToken: overwriteToken,
      actAs: { mode: 'admin' },
    });
    expect(await waitForRes('rb-v2-undo')).toEqual({ deleted: false, restored: true });

    const deadline = Date.now() + 3_000;
    while (
      frames.filter((frame) => frame.t === 'snap' && frame.subId === 'sub-rollback').length < 6 &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const mutations = frames
      .filter(
        (frame): frame is Extract<OutboundMessage, { t: 'snap' }> =>
          frame.t === 'snap' && frame.subId === 'sub-rollback',
      )
      .map((frame) => frame.value as StorageSubscriptionSnapWire)
      .filter(
        (snap): snap is Extract<StorageSubscriptionSnapWire, { kind: 'mutation' }> =>
          snap.kind === 'mutation',
      );

    expect(
      mutations.map((item) => ({
        op: item.op,
        path: item.path,
        rollback: item.rollback,
      })),
    ).toEqual([
      { op: 'object_put', path: 'rollback/new-item.txt', rollback: false },
      { op: 'object_delete', path: 'rollback/new-item.txt', rollback: true },
      { op: 'object_put', path: 'rollback/existing-item.txt', rollback: false },
      { op: 'object_put', path: 'rollback/existing-item.txt', rollback: false },
      { op: 'object_put', path: 'rollback/existing-item.txt', rollback: true },
    ]);

    cleanupPort(ctx, port);
  });

  test('relays pyric/storage updateMetadata with bumped metageneration, preserved generation/crc32c, and updated customMetadata', async () => {
    const ctx = await createWorkerCtx();
    const frames: OutboundMessage[] = [];
    const port: PortLike = {
      postMessage(raw) {
        frames.push(raw as OutboundMessage);
      },
    };

    await handleMessage(ctx, port, {
      t: 'sub',
      subId: 'sub-meta',
      target: { service: 'storage', defaultBucket: 'demo-project.appspot.com' },
      actAs: { mode: 'admin' },
    });

    const payloadBytes = Buffer.from('metadata-check-payload', 'utf8');
    const expectedCrc = computeCrc32cBase64(payloadBytes);
    await handleMessage(ctx, port, {
      t: 'op',
      id: 'meta-seed',
      method: 'storage.putBytes',
      path: 'docs/meta-target.txt',
      dataB64: payloadBytes.toString('base64'),
      contentType: 'text/plain',
      metadata: { customMetadata: { owner: 'alice', draft: 'true' } },
      actAs: { mode: 'admin' },
    });

    const storage = getStorageSandbox(ctx.sandbox);
    await updateMetadata(sandboxStorageRef(storage, 'docs/meta-target.txt'), {
      cacheControl: 'public, max-age=120',
      customMetadata: { owner: 'bob', draft: null as unknown as string },
    });

    const deadline = Date.now() + 2_000;
    while (
      frames.filter((frame) => frame.t === 'snap' && frame.subId === 'sub-meta').length < 3 &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const mutations = frames
      .filter(
        (frame): frame is Extract<OutboundMessage, { t: 'snap' }> =>
          frame.t === 'snap' && frame.subId === 'sub-meta',
      )
      .map((frame) => frame.value as StorageSubscriptionSnapWire)
      .filter(
        (snap): snap is Extract<StorageSubscriptionSnapWire, { kind: 'mutation' }> =>
          snap.kind === 'mutation',
      );

    expect(mutations).toHaveLength(2);
    const putSnap = mutations[0];
    const metaSnap = mutations[1];
    if (putSnap === undefined || metaSnap === undefined) {
      throw new Error('expected put and metadata_update snaps');
    }

    expect(metaSnap.op).toBe('metadata_update');
    expect(metaSnap.after?.generation).toBe(putSnap.after?.generation);
    expect(metaSnap.after?.metageneration).toBe('2');
    expect(metaSnap.after?.size).toBe(payloadBytes.byteLength);
    expect(metaSnap.after?.crc32c).toBe(expectedCrc);
    expect(metaSnap.after?.cacheControl).toBe('public, max-age=120');
    expect(metaSnap.after?.customMetadata).toEqual({ owner: 'bob' });

    cleanupPort(ctx, port);
  });
});
