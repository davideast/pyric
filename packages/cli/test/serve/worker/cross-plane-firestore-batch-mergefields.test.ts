import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createMemoryBackend, initializeSandbox } from 'pyric/sandbox';
import {
  FieldPath as AdminFieldPath,
  getAdminFirestore,
  getFirestore as getSandboxAdminCompat,
} from 'pyric/sandbox/admin-firestore';
import {
  FieldPath as ClientFieldPath,
  doc as ipDoc,
  getDoc as ipGetDoc,
  getFirestore as ipGetFirestore,
  runTransaction as ipRunTransaction,
  setDoc as ipSetDoc,
  writeBatch as ipWriteBatch,
} from 'pyric/firestore';
import { getAuth as ipGetAuth } from 'pyric/auth';
import { getInternalEnv } from 'pyric/sandbox/internal';
import * as client from '../../../src/serve/worker/index.js';
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
import { createRemoteSandboxHandle } from '../../../src/remote/index.js';
import { connectClientToHost } from './integration-support.js';

const OPEN_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if request.auth != null;
    }
  }
}`;

let previousWorker: unknown;

beforeEach(() => {
  previousWorker = (globalThis as { SharedWorker?: unknown }).SharedWorker;
});

afterEach(() => {
  client.setLens(undefined);
  (globalThis as { SharedWorker?: unknown }).SharedWorker = previousWorker;
});

async function setupPlanes() {
  const sandbox = initializeSandbox();
  await sandbox.enablePersistence({
    key: `batch-merge-${Math.random()}`,
    injectedBackend: createMemoryBackend(),
  });
  ipGetAuth(sandbox);
  getSandboxAdminCompat(sandbox.withAuth(null)).setRules(OPEN_RULES);
  const ctx: HostCtx = {
    db: ipGetFirestore(sandbox),
    sandbox,
    subs: new Map(),
    sessionMode: 'LOCAL',
    sessionBackend: createMemoryBackend(),
  };
  const { db: workerDb } = connectClientToHost(ctx, `worker://batch-merge-${Math.random()}`);
  client.setLens({ mode: 'as', uid: 'user-1' });
  const ipDb = ipGetFirestore(sandbox.withAuth({ uid: 'user-1' }));
  const compatDb = getSandboxAdminCompat(sandbox.withAuth({ uid: 'user-1' }));
  const adminDb = getAdminFirestore(sandbox);
  return {
    sandbox,
    ctx,
    ipDb,
    compatDb,
    adminDb,
    workerDb,
    dispose: () => getInternalEnv(sandbox).dispose(),
  };
}

describe('Cross-plane Firestore mergeFields FieldPath and WriteBatch commit lifecycle parity', () => {
  it('supports FieldPath instances (including literal dots) in mergeFields across admin-compat set, batch.set, and tx.set', async () => {
    const { compatDb, adminDb, dispose } = await setupPlanes();
    try {
      const initial = {
        'meta.v1': 'old-literal',
        meta: { v1: 'keep-nested' },
        profile: { displayName: 'Initial', role: 'viewer' },
        untouched: true,
      };
      await adminDb.doc('items/compat-set').set(initial);
      await adminDb.doc('items/compat-batch').set(initial);
      await adminDb.doc('items/compat-tx').set(initial);

      const updatePayload = {
        'meta.v1': 'new-literal',
        meta: { v1: 'should-ignore' },
        profile: { displayName: 'Updated', role: 'should-ignore' },
        extra: 'should-ignore',
      };
      const mask = [new AdminFieldPath('meta.v1'), new AdminFieldPath('profile', 'displayName')];

      await compatDb.doc('items/compat-set').set(updatePayload, { mergeFields: mask });

      const batch = compatDb.batch();
      batch.set(compatDb.doc('items/compat-batch'), updatePayload, { mergeFields: mask });
      await batch.commit();

      await compatDb.runTransaction(async (tx) => {
        tx.set(compatDb.doc('items/compat-tx'), updatePayload, { mergeFields: mask });
      });

      const expected = {
        'meta.v1': 'new-literal',
        meta: { v1: 'keep-nested' },
        profile: { displayName: 'Updated', role: 'viewer' },
        untouched: true,
      };
      expect((await adminDb.doc('items/compat-set').get()).data()).toEqual(expected);
      expect((await adminDb.doc('items/compat-batch').get()).data()).toEqual(expected);
      expect((await adminDb.doc('items/compat-tx').get()).data()).toEqual(expected);
    } finally {
      dispose();
    }
  });

  it('supports FieldPath instances (including literal dots) in mergeFields across in-process and served modular writes', async () => {
    const { ipDb, workerDb, adminDb, dispose } = await setupPlanes();
    try {
      const initial = {
        'meta.v1': 'old-literal',
        meta: { v1: 'keep-nested' },
        profile: { displayName: 'Initial', role: 'viewer' },
        untouched: true,
      };
      for (const id of ['ip-set', 'ip-batch', 'ip-tx', 'wk-set', 'wk-batch', 'wk-tx']) {
        await adminDb.doc(`items/${id}`).set(initial);
      }

      const updatePayload = {
        'meta.v1': 'new-literal',
        meta: { v1: 'should-ignore' },
        profile: { displayName: 'Updated', role: 'should-ignore' },
        extra: 'should-ignore',
      };
      const mask = [new ClientFieldPath('meta.v1'), new ClientFieldPath('profile', 'displayName')];

      await ipSetDoc(ipDoc(ipDb, 'items/ip-set'), updatePayload, { mergeFields: mask });
      const ipBatch = ipWriteBatch(ipDb);
      ipBatch.set(ipDoc(ipDb, 'items/ip-batch'), updatePayload, { mergeFields: mask });
      await ipBatch.commit();
      await ipRunTransaction(ipDb, async (tx) => {
        tx.set(ipDoc(ipDb, 'items/ip-tx'), updatePayload, { mergeFields: mask });
      });

      await client.setDoc(client.doc(workerDb, 'items/wk-set'), updatePayload, { mergeFields: mask });
      const wkBatch = client.writeBatch(workerDb);
      wkBatch.set(client.doc(workerDb, 'items/wk-batch'), updatePayload, { mergeFields: mask });
      await wkBatch.commit();
      await client.runTransaction(workerDb, async (tx) => {
        tx.set(client.doc(workerDb, 'items/wk-tx'), updatePayload, { mergeFields: mask });
      });

      const expected = {
        'meta.v1': 'new-literal',
        meta: { v1: 'keep-nested' },
        profile: { displayName: 'Updated', role: 'viewer' },
        untouched: true,
      };
      for (const id of ['ip-set', 'ip-batch', 'ip-tx']) {
        expect((await ipGetDoc(ipDoc(ipDb, `items/${id}`))).data()).toEqual(expected);
      }
      for (const id of ['wk-set', 'wk-batch', 'wk-tx']) {
        expect((await client.getDoc(client.doc(workerDb, `items/${id}`))).data()).toEqual(expected);
      }
    } finally {
      dispose();
    }
  });

  it('rejects post-commit WriteBatch mutations and duplicate commit() calls across admin-compat, in-process, and worker planes', async () => {
    const { compatDb, ipDb, workerDb, adminDb, dispose } = await setupPlanes();
    try {
      // 1. admin-compat WriteBatch
      const compatBatch = compatDb.batch();
      compatBatch.set(compatDb.doc('items/b-compat'), { count: 1 });
      await compatBatch.commit();

      expect(() => compatBatch.set(compatDb.doc('items/b-compat'), { count: 2 })).toThrow();
      expect(() => compatBatch.update(compatDb.doc('items/b-compat'), { count: 3 })).toThrow();
      expect(() => compatBatch.delete(compatDb.doc('items/b-compat'))).toThrow();
      expect(() => compatBatch.create(compatDb.doc('items/b-compat-new'), { count: 4 })).toThrow();
      await expect(compatBatch.commit()).rejects.toMatchObject({ code: 'failed-precondition' });

      // 2. in-process modular WriteBatch
      const ipBatch = ipWriteBatch(ipDb);
      ipBatch.set(ipDoc(ipDb, 'items/b-ip'), { count: 1 });
      await ipBatch.commit();

      expect(() => ipBatch.set(ipDoc(ipDb, 'items/b-ip'), { count: 2 })).toThrow();
      expect(() => ipBatch.update(ipDoc(ipDb, 'items/b-ip'), { count: 3 })).toThrow();
      expect(() => ipBatch.delete(ipDoc(ipDb, 'items/b-ip'))).toThrow();
      await expect(ipBatch.commit()).rejects.toMatchObject({ code: 'failed-precondition' });

      // 3. worker modular WriteBatch
      const wkBatch = client.writeBatch(workerDb);
      wkBatch.set(client.doc(workerDb, 'items/b-wk'), { count: 1 });
      await wkBatch.commit();

      expect(() => wkBatch.set(client.doc(workerDb, 'items/b-wk'), { count: 2 })).toThrow();
      expect(() => wkBatch.update(client.doc(workerDb, 'items/b-wk'), { count: 3 })).toThrow();
      expect(() => wkBatch.delete(client.doc(workerDb, 'items/b-wk'))).toThrow();
      await expect(wkBatch.commit()).rejects.toMatchObject({ code: 'failed-precondition' });

      // Verify none of the post-commit mutations or re-commits modified stored data
      await adminDb.doc('items/b-wk').set({ count: 99 });
      await expect(wkBatch.commit()).rejects.toMatchObject({ code: 'failed-precondition' });
      expect((await adminDb.doc('items/b-wk').get()).data()).toEqual({ count: 99 });
    } finally {
      dispose();
    }
  });

  it('normalizes FieldPath in remote admin-firestore docRef.set mergeFields and query.aggregate over the JSON worker wire', async () => {
    const { ctx, adminDb, dispose } = await setupPlanes();
    try {
      let rpcSeq = 0;
      const remoteSandbox = createRemoteSandboxHandle({
        serveUrl: 'http://127.0.0.1:5000',
        close: () => {},
        channel: {
          op: async (op) => {
            const id = `remote-op-${++rpcSeq}`;
            const wireInbound = JSON.parse(JSON.stringify({ t: 'op', id, ...op })) as InboundMessage;
            const outbound: OutboundMessage[] = [];
            const port: PortLike = {
              postMessage: (m) => outbound.push(m),
            };
            await handleMessage(ctx, port, wireInbound);
            const res = outbound.find((m): m is ResMessage => m.t === 'res' && m.id === id);
            if (!res) throw new Error(`Missing res for ${id}`);
            if (!res.ok) {
              throw Object.assign(new Error(res.error.message), { code: res.error.code });
            }
            return res.value;
          },
          subscribe: () => () => {},
        },
      });
      const remoteDb = getSandboxAdminCompat(remoteSandbox.withAuth({ uid: 'user-1' }));

      await adminDb.doc('items/remote-set').set({
        'meta.v1': 'old-literal',
        meta: { v1: 'keep-nested' },
        profile: { displayName: 'Initial', role: 'viewer' },
        untouched: true,
      });

      await remoteDb.doc('items/remote-set').set(
        {
          'meta.v1': 'new-literal',
          meta: { v1: 'should-ignore' },
          profile: { displayName: 'Updated', role: 'should-ignore' },
          extra: 'should-ignore',
        },
        {
          mergeFields: [new AdminFieldPath('meta.v1'), new AdminFieldPath('profile', 'displayName')],
        },
      );

      expect((await adminDb.doc('items/remote-set').get()).data()).toEqual({
        'meta.v1': 'new-literal',
        meta: { v1: 'keep-nested' },
        profile: { displayName: 'Updated', role: 'viewer' },
        untouched: true,
      });

      await adminDb.doc('ledger/l1').set({ 'amount.v1': 10, amount: { v1: 100 }, stats: { qty: 4 } });
      await adminDb.doc('ledger/l2').set({ 'amount.v1': 30, amount: { v1: 200 }, stats: { qty: 6 } });

      const aggSnap = await remoteDb.collection('ledger').aggregate({
        totalCount: { kind: 'count' },
        literalSum: { kind: 'sum', field: new AdminFieldPath('amount.v1') },
        nestedAvg: { kind: 'average', field: new AdminFieldPath('stats', 'qty') },
      });
      expect(aggSnap.data()).toEqual({
        totalCount: 2,
        literalSum: 40,
        nestedAvg: 5,
      });
    } finally {
      dispose();
    }
  });
});
