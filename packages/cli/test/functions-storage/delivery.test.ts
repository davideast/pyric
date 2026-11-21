import 'fake-indexeddb/auto';
import { describe, expect, test } from 'bun:test';
import { createMemoryBackend, initializeSandbox } from 'pyric/sandbox';
import { getFirestore } from 'pyric/firestore';
import { getStorageSandbox } from 'pyric/storage';
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
});
