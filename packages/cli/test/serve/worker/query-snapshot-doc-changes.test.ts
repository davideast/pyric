/**
 * `QuerySnapshot.docChanges()` through the worker bridge. The page client
 * diffs each query snapshot against the previous one the same listener
 * received, with the change computation the in-page sandbox uses, so a served
 * listener and an in-page listener report the same change list for the same
 * writes. `includeMetadataChanges` travels with the subscription, and each
 * snapshot frame carries `hasPendingWrites`.
 */
import { expect, test } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { setRules } from 'pyric/sandbox/firestore';
import { getInternalEnv } from 'pyric/sandbox/internal';
import * as inPage from 'pyric/firestore';
import * as inPageAuth from 'pyric/auth';
import * as client from '../../../src/serve/worker/client.js';
import { makeSnapshot } from '../../../src/serve/worker/client/snapshots.js';
import { refuseInvalidInboundMessage } from '../../../src/serve/worker/inbound-validation.js';
import { makeHostCtx, connectClientToHost, sleep } from './integration-support.js';

const OPEN_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{path=**}/items/{id} { allow read, write: if true; }
    match /widgets/{id} { allow read, write: if true; }
  }
}`;

interface Change {
  type: string;
  doc: { id: string; ref: { path: string }; data(): unknown };
  oldIndex: number;
  newIndex: number;
}

interface Snap {
  metadata: { hasPendingWrites: boolean; fromCache: boolean };
  docs: { id: string }[];
  docChanges(options?: { includeMetadataChanges?: boolean }): Change[];
}

const summarize = (changes: Change[]) => changes.map((c) => ({
  type: c.type,
  path: c.doc.ref.path,
  data: c.doc.data(),
  oldIndex: c.oldIndex,
  newIndex: c.newIndex,
}));

async function withServed(
  name: string,
  run: (db: ReturnType<typeof client.getFirestore>) => Promise<void>,
): Promise<void> {
  const previousWorker = globalThis.SharedWorker;
  const ctx = await makeHostCtx();
  try {
    setRules(ctx.sandbox, OPEN_RULES);
    const { db } = connectClientToHost(ctx, `worker://${name}`);
    await run(db);
  } finally {
    await sleep();
    getInternalEnv(ctx.sandbox).dispose();
    globalThis.SharedWorker = previousWorker;
  }
}

test('a served query listener reports added, modified and removed with oldIndex and newIndex', async () => {
  await withServed('doc-changes-basic', async (db) => {
    await client.setDoc(client.doc(db, 'widgets/a'), { n: 1 });
    await client.setDoc(client.doc(db, 'widgets/b'), { n: 2 });
    const snaps: Snap[] = [];
    const errors: unknown[] = [];
    const stop = client.onSnapshot(
      client.query(client.collection(db, 'widgets'), client.orderBy('n')),
      (s) => snaps.push(s as unknown as Snap),
      (e) => errors.push(e),
    );
    try {
      await sleep();
      expect(errors).toEqual([]);
      expect(snaps).toHaveLength(1);
      expect(summarize(snaps[0]!.docChanges())).toEqual([
        { type: 'added', path: 'widgets/a', data: { n: 1 }, oldIndex: -1, newIndex: 0 },
        { type: 'added', path: 'widgets/b', data: { n: 2 }, oldIndex: -1, newIndex: 1 },
      ]);

      await client.setDoc(client.doc(db, 'widgets/c'), { n: 3 });
      await sleep();
      expect(summarize(snaps.at(-1)!.docChanges())).toEqual([
        { type: 'added', path: 'widgets/c', data: { n: 3 }, oldIndex: -1, newIndex: 2 },
      ]);

      await client.updateDoc(client.doc(db, 'widgets/a'), { n: 9 });
      await sleep();
      expect(summarize(snaps.at(-1)!.docChanges())).toEqual([
        { type: 'modified', path: 'widgets/a', data: { n: 9 }, oldIndex: 0, newIndex: 2 },
      ]);

      await client.deleteDoc(client.doc(db, 'widgets/b'));
      await sleep();
      const removed = snaps.at(-1)!.docChanges();
      expect(summarize(removed)).toEqual([
        { type: 'removed', path: 'widgets/b', data: { n: 2 }, oldIndex: 0, newIndex: -1 },
      ]);
      // The removed document is a full snapshot: its ref is a write handle.
      await client.setDoc(removed[0]!.doc.ref as never, { n: 0 });
      await sleep();
      expect(summarize(snaps.at(-1)!.docChanges())).toEqual([
        { type: 'added', path: 'widgets/b', data: { n: 0 }, oldIndex: -1, newIndex: 0 },
      ]);
      expect(errors).toEqual([]);
    } finally {
      stop();
    }
  });
});

test('docChanges() returns the same array on repeat calls and shares document snapshots with docs', async () => {
  await withServed('doc-changes-identity', async (db) => {
    await client.setDoc(client.doc(db, 'widgets/a'), { n: 1 });
    const snaps: Snap[] = [];
    const stop = client.onSnapshot(client.collection(db, 'widgets'), (s) => snaps.push(s as unknown as Snap));
    try {
      await sleep();
      const snap = snaps[0]!;
      expect(snap.docChanges()).toBe(snap.docChanges());
      expect(snap.docChanges()[0]!.doc).toBe(snap.docs[0] as never);
    } finally {
      stop();
    }
  });
});

test('includeMetadataChanges: the pending echo, then a settled metadata-only snapshot with no changes', async () => {
  await withServed('doc-changes-metadata', async (db) => {
    const meta: Snap[] = [];
    const plain: Snap[] = [];
    const coll = client.collection(db, 'widgets');
    const stopMeta = client.onSnapshot(coll, { includeMetadataChanges: true }, (s) => meta.push(s as unknown as Snap));
    const stopPlain = client.onSnapshot(coll, (s) => plain.push(s as unknown as Snap));
    try {
      await sleep();
      await client.setDoc(client.doc(db, 'widgets/a'), { n: 1 });
      await sleep();

      expect(meta.map((s) => s.metadata.hasPendingWrites)).toEqual([false, true, false]);
      expect(plain.map((s) => s.metadata.hasPendingWrites)).toEqual([false, true]);
      expect(summarize(meta[1]!.docChanges({ includeMetadataChanges: true }))).toEqual([
        { type: 'added', path: 'widgets/a', data: { n: 1 }, oldIndex: -1, newIndex: 0 },
      ]);
      expect(meta[2]!.docChanges()).toEqual([]);
      expect(meta[2]!.docChanges({ includeMetadataChanges: true })).toEqual([]);
      expect(() => plain[1]!.docChanges({ includeMetadataChanges: true })).toThrow(
        /you must also pass \{ includeMetadataChanges: true \} to onSnapshot/,
      );
    } finally {
      stopMeta();
      stopPlain();
    }
  });
});

test('a served collection-group listener reports changes across collections with the id', async () => {
  await withServed('doc-changes-group', async (db) => {
    const snaps: Snap[] = [];
    const errors: unknown[] = [];
    const stop = client.onSnapshot(client.collectionGroup(db, 'items'), (s) => snaps.push(s as unknown as Snap), (e) => errors.push(e));
    try {
      await sleep();
      expect(snaps[0]!.docChanges()).toEqual([]);
      await client.setDoc(client.doc(db, 'users/u1/items/a'), { n: 1 });
      await sleep();
      expect(summarize(snaps.at(-1)!.docChanges())).toEqual([
        { type: 'added', path: 'users/u1/items/a', data: { n: 1 }, oldIndex: -1, newIndex: 0 },
      ]);
      await client.setDoc(client.doc(db, 'items/b'), { n: 2 });
      await sleep();
      const afterRoot = summarize(snaps.at(-1)!.docChanges());
      expect(afterRoot).toHaveLength(1);
      expect(afterRoot[0]).toMatchObject({ type: 'added', path: 'items/b', oldIndex: -1 });
      await client.deleteDoc(client.doc(db, 'users/u1/items/a'));
      await sleep();
      const afterDelete = summarize(snaps.at(-1)!.docChanges());
      expect(afterDelete).toHaveLength(1);
      expect(afterDelete[0]).toMatchObject({ type: 'removed', path: 'users/u1/items/a', newIndex: -1 });
      expect(errors).toEqual([]);
    } finally {
      stop();
    }
  });
});

test('served and in-page listeners report identical change lists and metadata for the same writes and a resubscribe', async () => {
  type Writes = {
    set(path: string, data: Record<string, unknown>): Promise<void>;
    update(path: string, data: Record<string, unknown>): Promise<void>;
    remove(path: string): Promise<void>;
    batch(ops: Array<['set', string, Record<string, unknown>] | ['delete', string]>): Promise<void>;
    /** Sign in. Production re-establishes the listen stream for the new identity. */
    resubscribe(): Promise<void>;
  };
  const script = async (w: Writes, settle: () => Promise<void>) => {
    await w.set('widgets/a', { n: 1 }); await settle();
    await w.set('widgets/b', { n: 2 }); await settle();
    await w.set('widgets/c', { n: 3 }); await settle();
    await w.update('widgets/a', { n: 5 }); await settle();
    await w.set('widgets/b', { n: 2 }); await settle();
    await w.remove('widgets/c'); await settle();
    await w.batch([['delete', 'widgets/b'], ['set', 'widgets/d', { n: 0 }], ['set', 'widgets/a', { n: 4 }]]); await settle();
    await w.resubscribe(); await settle();
    await w.set('widgets/e', { n: 6 }); await settle();
  };
  const record = (snaps: Snap[], withMetadata: boolean) => snaps.map((s) => ({
    hasPendingWrites: s.metadata.hasPendingWrites,
    ids: s.docs.map((d) => d.id),
    changes: summarize(s.docChanges()),
    ...(withMetadata ? { metaChanges: summarize(s.docChanges({ includeMetadataChanges: true })) } : {}),
  }));

  // In-page plane.
  const sandbox = initializeSandbox();
  setRules(sandbox, OPEN_RULES);
  const ipDb = inPage.getFirestore(sandbox);
  const ipQuery = inPage.query(inPage.collection(ipDb, 'widgets'), inPage.orderBy('n'));
  const ipMeta: Snap[] = [];
  const ipPlain: Snap[] = [];
  const ipStopMeta = inPage.onSnapshot(ipQuery, { includeMetadataChanges: true }, (s) => ipMeta.push(s as unknown as Snap));
  const ipStopPlain = inPage.onSnapshot(ipQuery, (s) => ipPlain.push(s as unknown as Snap));
  await sleep();
  await script({
    set: (p, d) => inPage.setDoc(inPage.doc(ipDb, p), d),
    update: (p, d) => inPage.updateDoc(inPage.doc(ipDb, p), d),
    remove: (p) => inPage.deleteDoc(inPage.doc(ipDb, p)),
    batch: async (ops) => {
      const b = inPage.writeBatch(ipDb);
      for (const op of ops) {
        if (op[0] === 'set') b.set(inPage.doc(ipDb, op[1]), op[2]);
        else b.delete(inPage.doc(ipDb, op[1]));
      }
      await b.commit();
    },
    resubscribe: async () => { await inPageAuth.signInAnonymously(inPageAuth.getAuth(sandbox)); },
  }, () => sleep());
  ipStopMeta();
  ipStopPlain();
  getInternalEnv(sandbox).dispose();

  // Served plane.
  let servedMeta: Snap[] = [];
  let servedPlain: Snap[] = [];
  await withServed('doc-changes-parity', async (db) => {
    const servedQuery = client.query(client.collection(db, 'widgets'), client.orderBy('n'));
    const meta: Snap[] = [];
    const plain: Snap[] = [];
    const stopMeta = client.onSnapshot(servedQuery, { includeMetadataChanges: true }, (s) => meta.push(s as unknown as Snap));
    const stopPlain = client.onSnapshot(servedQuery, (s) => plain.push(s as unknown as Snap));
    await sleep();
    await script({
      set: (p, d) => client.setDoc(client.doc(db, p), d),
      update: (p, d) => client.updateDoc(client.doc(db, p), d),
      remove: (p) => client.deleteDoc(client.doc(db, p)),
      batch: async (ops) => {
        const b = client.writeBatch(db);
        for (const op of ops) {
          if (op[0] === 'set') b.set(client.doc(db, op[1]), op[2]);
          else b.delete(client.doc(db, op[1]));
        }
        await b.commit();
      },
      resubscribe: async () => { await client.signInAnonymously(client.getAuth(db)); },
    }, () => sleep());
    stopMeta();
    stopPlain();
    servedMeta = meta;
    servedPlain = plain;
  });

  const inPageMeta = record(ipMeta, true);
  const changeTypes = new Set(inPageMeta.flatMap((s) => s.changes.map((c) => c.type)));
  expect([...changeTypes].sort()).toEqual(['added', 'modified', 'removed']);
  expect(inPageMeta.some((s) => s.changes.length > 1)).toBe(true);
  expect(inPageMeta.at(-2)!.changes).toEqual([
    { type: 'added', path: 'widgets/e', data: { n: 6 }, oldIndex: -1, newIndex: 2 },
  ]);
  expect(record(servedMeta, true)).toEqual(inPageMeta);
  expect(record(servedPlain, false)).toEqual(record(ipPlain, false));
});

test('a snapshot frame with a non-boolean hasPendingWrites is refused as malformed', () => {
  const port = {} as Parameters<typeof makeSnapshot>[1];
  const baseline = { excludesMetadataChanges: true };
  expect(() => makeSnapshot({ docs: [], hasPendingWrites: 'yes' }, port, null, baseline))
    .toThrow('The sandbox sent a malformed Firestore snapshot.');
  expect(() => makeSnapshot({ id: 'a', path: 'widgets/a', exists: false, hasPendingWrites: 1 }, port, null, baseline))
    .toThrow('The sandbox sent a malformed Firestore snapshot.');
});

test('a Firestore subscription with a non-boolean includeMetadataChanges is refused', () => {
  const replies: unknown[] = [];
  const port = { postMessage: (message: unknown) => replies.push(message) } as Parameters<typeof refuseInvalidInboundMessage>[0];
  const target = { __ref: 'collection', path: 'widgets' };
  expect(refuseInvalidInboundMessage(port, { t: 'sub', subId: 's1', target, includeMetadataChanges: true })).toBe(false);
  expect(refuseInvalidInboundMessage(port, { t: 'sub', subId: 's2', target, includeMetadataChanges: 'yes' })).toBe(true);
  expect(replies).toEqual([{ t: 'snap', subId: 's2', value: { __error: { code: 'invalid-argument', message: expect.stringContaining('includeMetadataChanges') } } }]);
});
