import { describe, expect, test } from 'bun:test';
import {
  Bytes as RulesBytes,
  LatLng as RulesLatLng,
  Reference as RulesReference,
  Timestamp as RulesTimestamp,
} from 'pyric/rules/internal';
import { createMemoryBackend, initializeSandbox } from 'pyric/sandbox';
import {
  Bytes as FirestoreBytes,
  GeoPoint as FirestoreGeoPoint,
  Timestamp as FirestoreTimestamp,
  doc as pyricDoc,
  getFirestore as getClientFirestore,
  setDoc,
  updateDoc,
  writeBatch,
} from 'pyric/firestore';
import { handleMessage, type HostCtx, type PortLike } from '../../src/serve/worker/host.js';
import type { InboundMessage, OutboundMessage } from '../../src/serve/worker/protocol.js';
import type { RemoteSandboxChannel } from '../../src/remote/index.js';
import type { FirestoreMutationRecord } from '../../src/functions/firestore/delivery.js';
import { FirestoreReferenceValue } from '../../src/functions/firestore/proto-encoder.js';
import { RemoteFirestoreTriggerDelivery } from '../../src/functions/firestore/remote-delivery.js';

async function createInProcessChannel(): Promise<{
  ctx: HostCtx;
  channel: Pick<RemoteSandboxChannel, 'subscribe'>;
  dispose(): void;
}> {
  const sandbox = initializeSandbox();
  await sandbox.enablePersistence({
    key: `firestore-remote-delivery-${Math.random()}`,
    injectedBackend: createMemoryBackend(),
  });
  const ctx: HostCtx = {
    db: getClientFirestore(sandbox),
    sandbox,
    instanceId: 'test-remote-delivery',
    subs: new Map(),
    messagingEnabled: false,
  };
  let nextSubSeq = 0;
  const listeners = new Map<string, (snap: unknown) => void>();
  const port: PortLike = {
    postMessage(raw: unknown) {
      const msg = raw as OutboundMessage;
      if (msg.t === 'snap') {
        listeners.get(msg.subId)?.(msg.value);
      }
    },
  };
  const channel: Pick<RemoteSandboxChannel, 'subscribe'> = {
    subscribe(sub, onSnap) {
      const subId = `sub-${(nextSubSeq += 1)}`;
      listeners.set(subId, onSnap);
      void handleMessage(ctx, port, {
        ...sub,
        t: 'sub',
        subId,
      } as InboundMessage);
      return () => {
        listeners.delete(subId);
        void handleMessage(ctx, port, { t: 'unsub', subId });
      };
    },
  };
  return {
    ctx,
    channel,
    dispose: () => sandbox.dispose(),
  };
}

describe('RemoteFirestoreTriggerDelivery', () => {
  test('skips pre-existing history, preserves createTime across updates, coalesces batches, and decodes rich types', async () => {
    const { ctx, channel, dispose } = await createInProcessChannel();
    try {
      const adminDb = getClientFirestore(ctx.sandbox.withAuth({ uid: 'seed-user' }));
      await setDoc(pyricDoc(adminDb, 'users/preexisting'), { seeded: true });

      const delivery = new RemoteFirestoreTriggerDelivery(channel);
      const mutations: FirestoreMutationRecord[] = [];
      let ready = false;

      const unsubscribe = delivery.subscribe('(default)', {
        onReady() {
          ready = true;
        },
        onMutation(mutation) {
          mutations.push(mutation);
        },
      });

      expect(ready).toBe(true);
      expect(mutations).toEqual([]);

      const authedDb = getClientFirestore(ctx.sandbox.withAuth({ uid: 'alice-uid' }));
      await setDoc(pyricDoc(authedDb, 'users/alice'), {
        name: 'Alice',
        at: new RulesTimestamp(1_700_000_000, 500_000_000),
        loc: new RulesLatLng(35.6762, 139.6503),
        blob: new RulesBytes(new Uint8Array([0xfb, 0xff, 0xfe])),
        friend: new RulesReference('users/bob'),
      });
      await updateDoc(pyricDoc(authedDb, 'users/alice'), { name: 'Alice v2' });

      const batch = writeBatch(authedDb);
      batch.set(pyricDoc(authedDb, 'orders/ord-1'), { step: 1 });
      batch.update(pyricDoc(authedDb, 'orders/ord-1'), { step: 2, finalized: true });
      await batch.commit();
      await Promise.resolve();

      expect(mutations.length).toBe(3);

      const createRec = mutations[0];
      const updateRec = mutations[1];
      const batchRec = mutations[2];
      expect(createRec?.before).toBeNull();
      expect(createRec?.authId).toBe('alice-uid');
      expect(createRec?.after?.fields.at).toBeInstanceOf(FirestoreTimestamp);
      expect(createRec?.after?.fields.loc).toBeInstanceOf(FirestoreGeoPoint);
      expect(createRec?.after?.fields.blob).toBeInstanceOf(FirestoreBytes);
      const decodedBytes = (createRec?.after?.fields.blob as FirestoreBytes).toUint8Array();
      expect(Array.from(decodedBytes)).toEqual([0xfb, 0xff, 0xfe]);
      expect(createRec?.after?.fields.friend).toBeInstanceOf(FirestoreReferenceValue);

      expect(updateRec?.before?.fields.name).toBe('Alice');
      expect(updateRec?.after?.fields.name).toBe('Alice v2');
      expect(updateRec?.after?.createTime).toEqual(createRec?.after?.createTime);

      expect(batchRec?.document).toBe('orders/ord-1');
      expect(batchRec?.before).toBeNull();
      expect(batchRec?.after?.fields).toEqual({ step: 2, finalized: true });

      unsubscribe();
      await setDoc(pyricDoc(authedDb, 'users/after-unsub'), { ignored: true });
      expect(mutations.length).toBe(3);
    } finally {
      dispose();
    }
  });
});
