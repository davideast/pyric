import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createMemoryBackend, initializeSandbox } from 'pyric/sandbox';
import {
  getAdminFirestore,
  getFirestore as getSandboxAdminCompat,
} from 'pyric/sandbox/admin-firestore';
import {
  Timestamp as ClientTimestamp,
  collection as ipCollection,
  deleteDoc as ipDeleteDoc,
  doc as ipDoc,
  endBefore as ipEndBefore,
  getDoc as ipGetDoc,
  getDocs as ipGetDocs,
  getFirestore as ipGetFirestore,
  limitToLast as ipLimitToLast,
  onSnapshot as ipOnSnapshot,
  orderBy as ipOrderBy,
  query as ipQuery,
  setDoc as ipSetDoc,
  startAfter as ipStartAfter,
  startAt as ipStartAt,
  where as ipWhere,
  type FirestoreDataConverter,
} from 'pyric/firestore';
import { getAuth as ipGetAuth } from 'pyric/auth';
import { getInternalEnv } from 'pyric/sandbox/internal';
import * as client from '../../../src/serve/worker/index.js';
import type { HostCtx } from '../../../src/serve/worker/host.js';
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
    key: `cursor-docchanges-${Math.random()}`,
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
  const { db: workerDb } = connectClientToHost(ctx, `worker://cursor-docchanges-${Math.random()}`);
  client.setLens({ mode: 'as', uid: 'user-1' });
  const ipDb = ipGetFirestore(sandbox.withAuth({ uid: 'user-1' }));
  const compatDb = getSandboxAdminCompat(sandbox.withAuth({ uid: 'user-1' }));
  const adminDb = getAdminFirestore(sandbox);
  return {
    sandbox,
    ipDb,
    compatDb,
    adminDb,
    workerDb,
    dispose: () => getInternalEnv(sandbox).dispose(),
  };
}

describe('Cross-plane Firestore snapshot cursors and docChanges parity', () => {
  it('extracts nested dotted orderBy fields from snapshot cursors and defers cursor bound evaluation until later orderBy/where clauses', async () => {
    const { ipDb, compatDb, adminDb, workerDb, dispose } = await setupPlanes();
    try {
      await adminDb.doc('items/a').set({ stats: { score: 10 }, title: 'alpha' });
      await adminDb.doc('items/b').set({ stats: { score: 20 }, title: 'beta' });
      await adminDb.doc('items/c').set({ stats: { score: 30 }, title: 'gamma' });

      const compatSnapB = await compatDb.doc('items/b').get();
      const ipSnapB = await ipGetDoc(ipDoc(ipDb, 'items/b'));
      const wkSnapB = await client.getDoc(client.doc(workerDb, 'items/b'));

      // Nested dotted orderBy before snapshot cursor
      const compatAfterNested = await compatDb
        .collection('items')
        .orderBy('stats.score', 'asc')
        .startCursorFromSnapshot(compatSnapB, false)
        .get();
      expect(compatAfterNested.docs.map((d) => d.id)).toEqual(['c']);

      const ipAfterNested = await ipGetDocs(
        ipQuery(ipCollection(ipDb, 'items'), ipOrderBy('stats.score', 'asc'), ipStartAfter(ipSnapB)),
      );
      expect(ipAfterNested.docs.map((d) => d.id)).toEqual(['c']);

      const wkAfterNested = await client.getDocs(
        client.query(client.collection(workerDb, 'items'), client.orderBy('stats.score', 'asc'), client.startAfter(wkSnapB)),
      );
      expect(wkAfterNested.docs.map((d) => d.id)).toEqual(['c']);

      // Late-chained orderBy and inequality where AFTER snapshot cursor
      const compatLateOrder = await compatDb
        .collection('items')
        .startCursorFromSnapshot(compatSnapB, false)
        .orderBy('stats.score', 'asc')
        .get();
      expect(compatLateOrder.docs.map((d) => d.id)).toEqual(['c']);

      const ipLateOrder = await ipGetDocs(
        ipQuery(ipCollection(ipDb, 'items'), ipStartAfter(ipSnapB), ipOrderBy('stats.score', 'asc')),
      );
      expect(ipLateOrder.docs.map((d) => d.id)).toEqual(['c']);

      const ipLateEndBefore = await ipGetDocs(
        ipQuery(ipCollection(ipDb, 'items'), ipEndBefore(ipSnapB), ipOrderBy('stats.score', 'asc')),
      );
      expect(ipLateEndBefore.docs.map((d) => d.id)).toEqual(['a']);

      const ipLateInequality = await ipGetDocs(
        ipQuery(ipCollection(ipDb, 'items'), ipStartAfter(ipSnapB), ipWhere('stats.score', '>', 5)),
      );
      expect(ipLateInequality.docs.map((d) => d.id)).toEqual(['c']);

      const wkLateOrder = await client.getDocs(
        client.query(client.collection(workerDb, 'items'), client.startAfter(wkSnapB), client.orderBy('stats.score', 'asc')),
      );
      expect(wkLateOrder.docs.map((d) => d.id)).toEqual(['c']);
    } finally {
      dispose();
    }
  });

  it('does not inject explicit __name__ orderBy on worker snapshot cursors, rejecting limitToLast without explicit orderBy', async () => {
    const { ipDb, adminDb, workerDb, dispose } = await setupPlanes();
    try {
      await adminDb.doc('items/a').set({ rank: 1 });
      await adminDb.doc('items/b').set({ rank: 2 });

      const ipSnapA = await ipGetDoc(ipDoc(ipDb, 'items/a'));
      const wkSnapA = await client.getDoc(client.doc(workerDb, 'items/a'));

      let ipErr: unknown;
      try {
        await ipGetDocs(ipQuery(ipCollection(ipDb, 'items'), ipStartAt(ipSnapA), ipLimitToLast(1)));
      } catch (err) {
        ipErr = err;
      }
      expect((ipErr as { code?: string })?.code).toBe('unimplemented');

      let wkErr: unknown;
      try {
        await client.getDocs(
          client.query(client.collection(workerDb, 'items'), client.startAt(wkSnapA), client.limitToLast(1)),
        );
      } catch (err) {
        wkErr = err;
      }
      expect((wkErr as { code?: string })?.code).toBe('unimplemented');

      // Snapshot cursor without orderBy still works for forward reads on both planes
      const ipForward = await ipGetDocs(ipQuery(ipCollection(ipDb, 'items'), ipStartAfter(ipSnapA)));
      const wkForward = await client.getDocs(
        client.query(client.collection(workerDb, 'items'), client.startAfter(wkSnapA)),
      );
      expect(ipForward.docs.map((d) => d.id)).toEqual(['b']);
      expect(wkForward.docs.map((d) => d.id)).toEqual(['b']);
    } finally {
      dispose();
    }
  });

  it('exposes .docChanges() on in-process getDocs snapshots (plain and withConverter) and wraps removed onSnapshot docChange.doc entries', async () => {
    const { ipDb, adminDb, workerDb, dispose } = await setupPlanes();
    try {
      const ts1 = ClientTimestamp.fromMillis(1_700_000_000_000);
      const ts2 = ClientTimestamp.fromMillis(1_700_000_060_000);
      await ipSetDoc(ipDoc(ipDb, 'items/first'), { label: 'one', createdAt: ts1 });
      await ipSetDoc(ipDoc(ipDb, 'items/second'), { label: 'two', createdAt: ts2 });

      const ipSnap = await ipGetDocs(ipQuery(ipCollection(ipDb, 'items'), ipOrderBy('label', 'asc')));
      const wkSnap = await client.getDocs(client.query(client.collection(workerDb, 'items'), client.orderBy('label', 'asc')));

      expect(typeof ipSnap.docChanges).toBe('function');
      expect(ipSnap.docChanges().map((c) => ({ type: c.type, oldIndex: c.oldIndex, newIndex: c.newIndex, id: c.doc.id }))).toEqual(
        wkSnap.docChanges().map((c) => ({ type: c.type, oldIndex: c.oldIndex, newIndex: c.newIndex, id: c.doc.id })),
      );
      expect(ipSnap.docChanges()).toHaveLength(2);

      interface LabelItem {
        readonly display: string;
      }
      const converter: FirestoreDataConverter<LabelItem> = {
        toFirestore: (model) => ({ label: model.display }),
        fromFirestore: (snap) => ({ display: `converted:${String(snap.data().label)}` }),
      };

      const ipConvSnap = await ipGetDocs(
        ipQuery(ipCollection(ipDb, 'items').withConverter(converter), ipOrderBy('label', 'asc')),
      );
      expect(ipConvSnap.docChanges().map((c) => ({ type: c.type, data: c.doc.data() }))).toEqual([
        { type: 'added', data: { display: 'converted:one' } },
        { type: 'added', data: { display: 'converted:two' } },
      ]);

      // Verify removed docChange.doc is properly finalized, tagged, and converted in in-process onSnapshot
      const plainEvents: Array<ReturnType<typeof ipSnap.docChanges>> = [];
      const convEvents: Array<ReturnType<typeof ipConvSnap.docChanges>> = [];
      const unsubPlain = ipOnSnapshot(ipCollection(ipDb, 'items'), (s) => {
        plainEvents.push(s.docChanges());
      });
      const unsubConv = ipOnSnapshot(ipCollection(ipDb, 'items').withConverter(converter), (s) => {
        convEvents.push(s.docChanges());
      });
      await new Promise<void>((resolve) => queueMicrotask(resolve));

      await ipDeleteDoc(ipDoc(ipDb, 'items/first'));
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      unsubPlain();
      unsubConv();

      const removedPlain = plainEvents[plainEvents.length - 1]?.find((c) => c.type === 'removed');
      expect(removedPlain).toBeDefined();
      expect(typeof removedPlain!.doc.exists).toBe('function');
      expect(removedPlain!.doc.exists()).toBe(true);
      expect(removedPlain!.doc.data().createdAt).toBeInstanceOf(ClientTimestamp);
      // Usable ref on removed docChange.doc
      const rereadRemoved = await ipGetDoc(removedPlain!.doc.ref);
      expect(rereadRemoved.exists()).toBe(false);

      const removedConv = convEvents[convEvents.length - 1]?.find((c) => c.type === 'removed');
      expect(removedConv).toBeDefined();
      expect(removedConv!.doc.data()).toEqual({ display: 'converted:one' });
      await ipSetDoc(removedConv!.doc.ref, { display: 'restored' });
      expect((await adminDb.doc('items/first').get()).data()).toEqual({ label: 'restored' });
      expect((await adminDb.doc('items/second').get()).exists).toBe(true);
    } finally {
      dispose();
    }
  });

  it('detects NaN and Infinity transitions in in-process onSnapshot using firestoreValuesEqual', async () => {
    const { ipDb, dispose } = await setupPlanes();
    try {
      await ipSetDoc(ipDoc(ipDb, 'metrics/m1'), { reading: Number.NaN });

      const docDeliveries: unknown[] = [];
      const queryChanges: Array<Array<{ type: string; id: string; reading: unknown }>> = [];

      const unsubDoc = ipOnSnapshot(ipDoc(ipDb, 'metrics/m1'), (s) => {
        docDeliveries.push(s.data()?.reading);
      });
      const unsubQuery = ipOnSnapshot(ipCollection(ipDb, 'metrics'), (s) => {
        queryChanges.push(
          s.docChanges().map((c) => ({ type: c.type, id: c.doc.id, reading: c.doc.data().reading })),
        );
      });
      await new Promise<void>((resolve) => queueMicrotask(resolve));

      expect(docDeliveries).toHaveLength(1);
      expect(Number.isNaN(docDeliveries[0])).toBe(true);
      expect(queryChanges).toHaveLength(1);
      expect(queryChanges[0]?.[0]?.type).toBe('added');

      // Writing NaN again should be suppressed as unchanged
      await ipSetDoc(ipDoc(ipDb, 'metrics/m1'), { reading: Number.NaN });
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      expect(docDeliveries).toHaveLength(1);
      expect(queryChanges).toHaveLength(1);

      // Transitioning NaN -> Infinity must fire modified
      await ipSetDoc(ipDoc(ipDb, 'metrics/m1'), { reading: Number.POSITIVE_INFINITY });
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      expect(docDeliveries).toHaveLength(2);
      expect(docDeliveries[1]).toBe(Number.POSITIVE_INFINITY);
      expect(queryChanges).toHaveLength(2);
      expect(queryChanges[1]).toEqual([{ type: 'modified', id: 'm1', reading: Number.POSITIVE_INFINITY }]);

      // Transitioning Infinity -> -Infinity must fire modified
      await ipSetDoc(ipDoc(ipDb, 'metrics/m1'), { reading: Number.NEGATIVE_INFINITY });
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      expect(docDeliveries).toHaveLength(3);
      expect(docDeliveries[2]).toBe(Number.NEGATIVE_INFINITY);
      expect(queryChanges).toHaveLength(3);
      expect(queryChanges[2]).toEqual([{ type: 'modified', id: 'm1', reading: Number.NEGATIVE_INFINITY }]);

      // Transitioning -Infinity -> null must fire modified
      await ipSetDoc(ipDoc(ipDb, 'metrics/m1'), { reading: null });
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      expect(docDeliveries).toHaveLength(4);
      expect(docDeliveries[3]).toBeNull();
      expect(queryChanges).toHaveLength(4);
      expect(queryChanges[3]).toEqual([{ type: 'modified', id: 'm1', reading: null }]);

      unsubDoc();
      unsubQuery();
    } finally {
      dispose();
    }
  });

  it('preserves pending snapshot cursors across QueryHandle.withConverter() and ignores prototype properties in readSnapshotField', async () => {
    const { adminDb, workerDb, dispose } = await setupPlanes();
    try {
      await adminDb.doc('items/a').set({ stats: { score: 10 }, title: 'alpha' });
      await adminDb.doc('items/b').set({ stats: { score: 20 }, title: 'beta' });
      await adminDb.doc('items/c').set({ stats: { score: 30 }, title: 'gamma' });

      const wkSnapB = await client.getDoc(client.doc(workerDb, 'items/b'));

      interface ScoreRow {
        readonly id: string;
        readonly score: number;
      }
      const scoreConverter: FirestoreDataConverter<ScoreRow> = {
        toFirestore: (row) => ({ stats: { score: row.score } }),
        fromFirestore: (snap) => ({
          id: snap.id,
          score: Number((snap.data().stats as { score: number }).score),
        }),
      };

      const q1 = client.query(client.collection(workerDb, 'items'), client.startAfter(wkSnapB));
      const q2 = client.query(q1.withConverter(scoreConverter), client.orderBy('stats.score', 'asc'));
      const convertedSnap = await client.getDocs(q2);
      expect(convertedSnap.docs.map((d) => d.data())).toEqual([{ id: 'c', score: 30 }]);

      // Object.hasOwn guard in readSnapshotField: ordering by a missing field matching Object.prototype
      // must treat the field as absent rather than encoding Function.prototype / Object.prototype.toString
      expect(() =>
        client.query(client.collection(workerDb, 'items'), client.startAfter(wkSnapB), client.orderBy('toString', 'asc')),
      ).not.toThrow();
      expect(() =>
        client.query(
          client.collection(workerDb, 'items'),
          client.startAfter(wkSnapB),
          client.orderBy('stats.toString', 'asc'),
        ),
      ).not.toThrow();
    } finally {
      dispose();
    }
  });
});
