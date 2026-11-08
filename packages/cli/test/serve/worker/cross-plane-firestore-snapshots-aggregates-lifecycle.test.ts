import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createMemoryBackend, initializeSandbox } from 'pyric/sandbox';
import {
  getAdminFirestore,
  getFirestore as getSandboxAdminCompat,
} from 'pyric/sandbox/admin-firestore';
import {
  Bytes as ClientBytes,
  FieldPath as ClientFieldPath,
  GeoPoint as ClientGeoPoint,
  Timestamp as ClientTimestamp,
  actingAs as ipActingAs,
  addDoc as ipAddDoc,
  aggregateFieldEqual as ipAggregateFieldEqual,
  aggregateQuerySnapshotEqual as ipAggregateQuerySnapshotEqual,
  average as ipAverage,
  collection as ipCollection,
  count as ipCount,
  disableNetwork as ipDisableNetwork,
  doc as ipDoc,
  enableIndexedDbPersistence as ipEnableIndexedDbPersistence,
  enableNetwork as ipEnableNetwork,
  getAggregateFromServer as ipGetAggregateFromServer,
  getCountFromServer as ipGetCountFromServer,
  getDoc as ipGetDoc,
  getDocFromCache as ipGetDocFromCache,
  getDocs as ipGetDocs,
  getFirestore as ipGetFirestore,
  onSnapshot as ipOnSnapshot,
  onSnapshotsInSync as ipOnSnapshotsInSync,
  query as ipQuery,
  refEqual as ipRefEqual,
  runTransaction as ipRunTransaction,
  setDoc as ipSetDoc,
  sum as ipSum,
  where as ipWhere,
  writeBatch as ipWriteBatch,
  type DocumentReference,
  type FirestoreDataConverter,
} from 'pyric/firestore';
import { deleteApp } from 'pyric/app';
import { createAppForSandbox } from 'pyric/app/internal';
import { getAuth as ipGetAuth } from 'pyric/auth';
import { getInternalEnv } from 'pyric/sandbox/internal';
import * as client from '../../../src/serve/worker/index.js';
import { onSnapshotsInSync as wkOnSnapshotsInSync } from '../../../src/serve/worker/client/firestore-reads.js';
import { refEqual as wkRefEqual } from '../../../src/serve/worker/client/firestore-reference-equality.js';
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
    key: `snap-agg-lifecycle-${Math.random()}`,
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
  const { db: workerDb } = connectClientToHost(ctx, `worker://snap-agg-${Math.random()}`);
  client.setLens({ mode: 'as', uid: 'user-1' });
  const ipDb = ipGetFirestore(sandbox.withAuth({ uid: 'user-1' }));
  const adminDb = getAdminFirestore(sandbox);
  return {
    sandbox,
    ipDb,
    adminDb,
    workerDb,
    dispose: () => getInternalEnv(sandbox).dispose(),
  };
}

describe('Cross-plane Firestore snapshots, converters, refEqual, aggregates, and lifecycle parity', () => {
  it('finalizes values in snap.get(fieldPath) and supports snap.get() on converted snapshots', async () => {
    const { ipDb, workerDb, dispose } = await setupPlanes();
    try {
      const createdAt = ClientTimestamp.fromMillis(1_700_100_000_000);
      const coords = new ClientGeoPoint(37.7749, -122.4194);
      const payloadBytes = ClientBytes.fromUint8Array(new Uint8Array([1, 2, 3]));
      const targetRef = ipDoc(ipDb, 'targets/t1');

      await ipSetDoc(ipDoc(ipDb, 'records/r1'), {
        nested: {
          createdAt,
          coords,
          payloadBytes,
          targetRef,
        },
        title: 'stored-title',
      });

      const ipSnap = await ipGetDoc(ipDoc(ipDb, 'records/r1'));
      const wkSnap = await client.getDoc(client.doc(workerDb, 'records/r1'));

      expect(ipSnap.get('nested.createdAt')).toBeInstanceOf(ClientTimestamp);
      expect(wkSnap.get('nested.createdAt')).toBeInstanceOf(ClientTimestamp);
      expect(ipSnap.get('nested.coords')).toBeInstanceOf(ClientGeoPoint);
      expect(ipSnap.get('nested.payloadBytes')).toBeInstanceOf(ClientBytes);
      const gotRef = ipSnap.get('nested.targetRef') as DocumentReference;
      expect(gotRef.path).toBe('targets/t1');

      interface TitleView {
        readonly upper: string;
      }
      const converter: FirestoreDataConverter<TitleView> = {
        toFirestore: (v) => ({ title: v.upper.toLowerCase() }),
        fromFirestore: (snap) => ({
          // Converter fromFirestore receives a QueryDocumentSnapshot whose .get() works too
          upper: String(snap.get('title')).toUpperCase(),
        }),
      };

      const ipConvSnap = await ipGetDoc(ipDoc(ipDb, 'records/r1').withConverter(converter));
      const wkConvSnap = await client.getDoc(client.doc(workerDb, 'records/r1').withConverter(converter));
      expect(ipConvSnap.data()).toEqual({ upper: 'STORED-TITLE' });
      expect(wkConvSnap.data()).toEqual({ upper: 'STORED-TITLE' });
      expect(ipConvSnap.get('title')).toBe('stored-title');
      expect(wkConvSnap.get('title')).toBe('stored-title');
      expect(ipConvSnap.get('nested.createdAt')).toBeInstanceOf(ClientTimestamp);
    } finally {
      dispose();
    }
  });

  it('preserves .withConverter across docRef, addDoc return refs, and querySnapshot.docs[i].ref, and checks db/converter/kind in refEqual', async () => {
    const { sandbox, ipDb, workerDb, dispose } = await setupPlanes();
    const sandbox2 = initializeSandbox();
    try {
      interface EntryModel {
        readonly label: string;
      }
      const convA: FirestoreDataConverter<EntryModel> = {
        toFirestore: (m) => ({ label: m.label }),
        fromFirestore: (s) => ({ label: String(s.data().label) }),
      };
      const convB: FirestoreDataConverter<EntryModel> = {
        toFirestore: (m) => ({ label: m.label }),
        fromFirestore: (s) => ({ label: String(s.data().label) }),
      };

      // addDoc return ref supports .withConverter and preserves collection converter
      const addedPlain = await ipAddDoc(ipCollection(ipDb, 'entries'), { label: 'plain' });
      expect(typeof addedPlain.withConverter).toBe('function');
      const retypedAdded = addedPlain.withConverter(convA);
      expect((await ipGetDoc(retypedAdded)).data()).toEqual({ label: 'plain' });

      const addedTyped = await ipAddDoc(ipCollection(ipDb, 'entries').withConverter(convA), { label: 'typed' });
      expect(typeof addedTyped.withConverter).toBe('function');
      expect((await ipGetDoc(addedTyped)).data()).toEqual({ label: 'typed' });

      // querySnapshot.docs[i].ref supports .withConverter
      const plainList = await ipGetDocs(ipCollection(ipDb, 'entries'));
      expect(typeof plainList.docs[0]!.ref.withConverter).toBe('function');
      const docViaSnapRef = await ipGetDoc(plainList.docs[0]!.ref.withConverter(convA));
      expect(docViaSnapRef.data()).toBeDefined();

      // refEqual checks db instance, converter identity, and doc vs collection kind
      const ipDbOther = ipGetFirestore(sandbox2.withAuth({ uid: 'user-1' }));
      expect(ipRefEqual(ipDoc(ipDb, 'entries/e1'), ipDoc(ipDb, 'entries/e1'))).toBe(true);
      expect(ipRefEqual(ipDoc(ipDb, 'entries/e1'), ipDoc(ipDbOther, 'entries/e1'))).toBe(false);
      expect(
        ipRefEqual(
          ipDoc(ipDb, 'entries/e1').withConverter(convA),
          ipDoc(ipDb, 'entries/e1').withConverter(convA),
        ),
      ).toBe(true);
      expect(
        ipRefEqual(
          ipDoc(ipDb, 'entries/e1').withConverter(convA),
          ipDoc(ipDb, 'entries/e1').withConverter(convB),
        ),
      ).toBe(false);
      expect(
        ipRefEqual(
          ipDoc(ipDb, 'entries/e1').withConverter(convA),
          ipDoc(ipDb, 'entries/e1'),
        ),
      ).toBe(false);
      expect(
        ipRefEqual(
          ipDoc(ipDb, 'entries/e1') as unknown as DocumentReference,
          ipCollection(ipDb, 'entries') as unknown as DocumentReference,
        ),
      ).toBe(false);

      expect(
        wkRefEqual(
          client.doc(workerDb, 'entries/e1').withConverter(convA),
          client.doc(workerDb, 'entries/e1').withConverter(convB),
        ),
      ).toBe(false);
    } finally {
      getInternalEnv(sandbox2).dispose();
      dispose();
    }
  });

  it('supports FieldPath in sum/average/aggregateFieldEqual and exposes .query and .type on AggregateQuerySnapshot across planes', async () => {
    const { ipDb, workerDb, dispose } = await setupPlanes();
    try {
      await ipSetDoc(ipDoc(ipDb, 'ledger/l1'), { 'amount.v1': 10, amount: { v1: 100 }, stats: { qty: 4 } });
      await ipSetDoc(ipDoc(ipDb, 'ledger/l2'), { 'amount.v1': 30, amount: { v1: 200 }, stats: { qty: 6 } });

      const literalDotFp = new ClientFieldPath('amount.v1');
      const nestedFp = new ClientFieldPath('stats', 'qty');

      expect(ipAggregateFieldEqual(ipSum(nestedFp), ipSum('stats.qty'))).toBe(true);
      expect(ipAggregateFieldEqual(ipSum(literalDotFp), ipSum('amount.v1'))).toBe(false);
      expect(ipAggregateFieldEqual(ipSum(literalDotFp), ipSum(new ClientFieldPath('amount.v1')))).toBe(true);

      const ipColl = ipCollection(ipDb, 'ledger');
      const ipCountSnap = await ipGetCountFromServer(ipColl);
      const ipCountSnapSameQuery = await ipGetCountFromServer(ipCollection(ipDb, 'ledger'));
      const ipCountSnapOtherQuery = await ipGetCountFromServer(ipCollection(ipDb, 'otherLedger'));
      expect((ipCountSnap as { type?: string }).type).toBe('AggregateQuerySnapshot');
      expect((ipCountSnap as { query?: unknown }).query).toBe(ipColl);
      expect(ipCountSnap.data().count).toBe(2);
      expect(ipAggregateQuerySnapshotEqual(ipCountSnap, ipCountSnapSameQuery)).toBe(true);
      expect(ipAggregateQuerySnapshotEqual(ipCountSnap, ipCountSnapOtherQuery)).toBe(false);

      const ipAggSnap = await ipGetAggregateFromServer(ipColl, {
        n: ipCount(),
        literalSum: ipSum(literalDotFp),
        nestedAvg: ipAverage(nestedFp),
      });
      expect((ipAggSnap as { type?: string }).type).toBe('AggregateQuerySnapshot');
      expect((ipAggSnap as { query?: unknown }).query).toBe(ipColl);
      expect(ipAggSnap.data()).toEqual({ n: 2, literalSum: 40, nestedAvg: 5 });

      const wkColl = client.collection(workerDb, 'ledger');
      const wkCountSnap = await client.getCountFromServer(wkColl);
      expect(wkCountSnap.type).toBe('AggregateQuerySnapshot');
      expect(wkCountSnap.query).toBe(wkColl);
      expect(wkCountSnap.data().count).toBe(2);

      const wkAggSnap = await client.getAggregateFromServer(wkColl, {
        n: client.count(),
        literalSum: client.sum(literalDotFp),
        nestedAvg: client.average(nestedFp),
      });
      expect(wkAggSnap.type).toBe('AggregateQuerySnapshot');
      expect(wkAggSnap.query).toBe(wkColl);
      expect(wkAggSnap.data()).toEqual({ n: 2, literalSum: 40, nestedAvg: 5 });
    } finally {
      dispose();
    }
  });

  it('enforces enableIndexedDbPersistence failed-precondition after aggregates/batches/transactions, honors offline pendingWrites in batches/transactions, and fires onSnapshotsInSync with bound observer', async () => {
    const { sandbox, workerDb, dispose } = await setupPlanes();
    try {
      // 1. markStarted() on getCountFromServer, getAggregateFromServer, writeBatch, runTransaction
      for (const starter of [
        async (db: ReturnType<typeof ipGetFirestore>) => {
          await ipGetCountFromServer(ipCollection(db, 'items'));
        },
        async (db: ReturnType<typeof ipGetFirestore>) => {
          await ipGetAggregateFromServer(ipCollection(db, 'items'), { n: ipCount() });
        },
        async (db: ReturnType<typeof ipGetFirestore>) => {
          ipWriteBatch(db);
        },
        async (db: ReturnType<typeof ipGetFirestore>) => {
          await ipRunTransaction(db, async () => undefined);
        },
      ]) {
        const freshSandbox = initializeSandbox();
        getSandboxAdminCompat(freshSandbox.withAuth(null)).setRules(OPEN_RULES);
        const freshDb = ipGetFirestore(freshSandbox.withAuth({ uid: 'user-1' }));
        try {
          await starter(freshDb);
          let err: unknown;
          try {
            await ipEnableIndexedDbPersistence(freshDb);
          } catch (e) {
            err = e;
          }
          expect((err as { code?: string })?.code).toBe('failed-precondition');
        } finally {
          getInternalEnv(freshSandbox).dispose();
        }
      }

      // 2. Offline writeBatch pendingWrites and cache visibility
      const offlineSandbox = initializeSandbox();
      getSandboxAdminCompat(offlineSandbox.withAuth(null)).setRules(OPEN_RULES);
      const offlineDb = ipGetFirestore(offlineSandbox.withAuth({ uid: 'user-1' }));
      try {
        await ipDisableNetwork(offlineDb);
        const batch = ipWriteBatch(offlineDb);
        batch.set(ipDoc(offlineDb, 'offlineItems/o1'), { status: 'queued' });
        let settled = false;
        const commitPromise = batch.commit().then(() => {
          settled = true;
        });
        await new Promise<void>((r) => queueMicrotask(r));
        expect(settled).toBe(false);

        const cachedSnap = await ipGetDocFromCache(ipDoc(offlineDb, 'offlineItems/o1'));
        expect(cachedSnap.data()).toEqual({ status: 'queued' });
        expect(cachedSnap.metadata.fromCache).toBe(true);
        expect(cachedSnap.metadata.hasPendingWrites).toBe(true);

        await ipEnableNetwork(offlineDb);
        await commitPromise;
        expect(settled).toBe(true);
      } finally {
        getInternalEnv(offlineSandbox).dispose();
      }

      // 3. onSnapshotsInSync observer binding + post-snapshot delivery on in-process and worker planes
      const ipDb = ipGetFirestore(sandbox.withAuth({ uid: 'user-1' }));
      const ipSyncReceiver: unknown[] = [];
      const ipObserver = {
        tag: 'ip-sync',
        next(this: unknown) {
          ipSyncReceiver.push(this);
        },
      };
      const unsubIpSync = ipOnSnapshotsInSync(ipDb, ipObserver);
      expect(ipSyncReceiver).toEqual([ipObserver]);
      unsubIpSync();

      const wkOrder: string[] = [];
      const wkObserver = {
        tag: 'wk-sync',
        next(this: unknown) {
          wkOrder.push(this === wkObserver ? 'sync:bound' : 'sync:unbound');
        },
      };
      const unsubWkSnap = client.onSnapshot(client.doc(workerDb, 'syncDocs/s1'), (snap) => {
        wkOrder.push(`snap:${String(snap.data()?.step ?? 'empty')}`);
      });
      await new Promise((r) => setTimeout(r, 20));
      const unsubWkSync = wkOnSnapshotsInSync(workerDb, wkObserver);
      await new Promise((r) => setTimeout(r, 10));
      wkOrder.length = 0;

      await client.setDoc(client.doc(workerDb, 'syncDocs/s1'), { step: 1 });
      await new Promise((r) => setTimeout(r, 20));

      expect(wkOrder).toEqual(['snap:1', 'sync:bound']);
      unsubWkSync();
      unsubWkSnap();
    } finally {
      dispose();
    }
  });

  it('preserves DocumentReference WeakMap identity and fresh-per-call copies when converter.fromFirestore calls snap.get()', async () => {
    const { ipDb, dispose } = await setupPlanes();
    try {
      const peerRef = ipDoc(ipDb, 'targets/t1');
      await ipSetDoc(peerRef, { name: 'peer-target' });
      await ipSetDoc(ipDoc(ipDb, 'links/l1'), {
        peer: peerRef,
        meta: { tags: ['alpha'] },
      });

      interface LinkView {
        readonly peer: DocumentReference;
        readonly secondGetTags: string[];
        readonly secondDataTags: string[];
      }

      const linkConverter: FirestoreDataConverter<LinkView> = {
        toFirestore: (model) => ({ peer: model.peer, meta: { tags: model.secondGetTags } }),
        fromFirestore: (snap) => {
          const firstMetaGet = snap.get('meta') as { tags: string[] };
          firstMetaGet.tags.push('mutated-via-get');
          const secondGetTags = [...((snap.get('meta.tags') as string[]) ?? [])];

          const firstData = snap.data() as { meta: { tags: string[] } };
          firstData.meta.tags.push('mutated-via-data');
          const secondDataTags = [...((snap.data() as { meta: { tags: string[] } }).meta.tags)];

          return {
            peer: snap.get('peer') as DocumentReference,
            secondGetTags,
            secondDataTags,
          };
        },
      };

      const typedDoc = ipDoc(ipDb, 'links/l1').withConverter(linkConverter);
      const typedColl = ipCollection(ipDb, 'links').withConverter(linkConverter);

      const fromGetDoc = (await ipGetDoc(typedDoc)).data()!;
      const fromGetDocs = (await ipGetDocs(typedColl)).docs[0]!.data();
      const fromTxGet = await ipRunTransaction(ipDb, async (tx) => (await tx.get(typedDoc)).data()!);

      let fromDocSnap: LinkView | undefined;
      let fromQuerySnap: LinkView | undefined;
      const unsubDoc = ipOnSnapshot(typedDoc, (s) => {
        fromDocSnap = s.data();
      });
      const unsubQuery = ipOnSnapshot(typedColl, (s) => {
        fromQuerySnap = s.docs[0]?.data();
      });
      await new Promise<void>((r) => queueMicrotask(r));
      unsubDoc();
      unsubQuery();

      for (const view of [fromGetDoc, fromGetDocs, fromTxGet, fromDocSnap!, fromQuerySnap!]) {
        expect(view).toBeDefined();
        expect(view.secondGetTags).toEqual(['alpha']);
        expect(view.secondDataTags).toEqual(['alpha']);
        expect(ipRefEqual(view.peer, peerRef)).toBe(true);
        expect((await ipGetDoc(view.peer)).data()).toEqual({ name: 'peer-target' });
        const matched = await ipGetDocs(ipQuery(ipCollection(ipDb, 'links'), ipWhere('peer', '==', view.peer)));
        expect(matched.docs.map((d) => d.id)).toEqual(['l1']);
      }
    } finally {
      dispose();
    }
  });

  it('distinguishes distinct named FirebaseApp instances in in-process refEqual while keeping bare-sandbox handles equal', async () => {
    const { sandbox, dispose } = await setupPlanes();
    const appA = createAppForSandbox(sandbox, { projectId: 'demo-project' }, `ref-eq-a-${Math.random()}`);
    const appB = createAppForSandbox(sandbox, { projectId: 'demo-project' }, `ref-eq-b-${Math.random()}`);
    try {
      const dbAppA = ipGetFirestore(appA);
      const dbAppB = ipGetFirestore(appB);
      const dbSandbox = ipGetFirestore(sandbox);
      const dbActing = ipActingAs(sandbox, { uid: 'user-1' });

      expect(ipRefEqual(ipDoc(dbAppA, 'items/1'), ipDoc(dbAppA, 'items/1'))).toBe(true);
      expect(ipRefEqual(ipDoc(dbAppA, 'items/1'), ipDoc(dbAppB, 'items/1'))).toBe(false);
      expect(ipRefEqual(ipDoc(dbAppA, 'items/1'), ipDoc(dbSandbox, 'items/1'))).toBe(false);
      expect(ipRefEqual(ipDoc(dbSandbox, 'items/1'), ipDoc(dbActing, 'items/1'))).toBe(true);
    } finally {
      await deleteApp(appA);
      await deleteApp(appB);
      dispose();
    }
  });

  it('dispatches served onSnapshotsInSync by handle brand without swallowing synchronous callback errors or leaking observers', async () => {
    const { ipDb, workerDb, dispose } = await setupPlanes();
    try {
      (globalThis as { SharedWorker?: unknown }).SharedWorker = class {
        port = workerDb.port;
        addEventListener() {}
      };
      const servedFirestore = await import('../../../src/serve/entries/firestore-surface.js');

      let ipCalls = 0;
      expect(() =>
        servedFirestore.onSnapshotsInSync(ipDb, () => {
          ipCalls += 1;
          throw new Error('sync-ip-boom');
        }),
      ).toThrow('sync-ip-boom');
      expect(ipCalls).toBe(1);

      const unsubIpDoc = ipOnSnapshot(ipDoc(ipDb, 'syncBrand/s1'), () => {});
      await new Promise<void>((r) => queueMicrotask(r));
      await ipSetDoc(ipDoc(ipDb, 'syncBrand/s1'), { n: 1 });
      await new Promise<void>((r) => queueMicrotask(r));
      unsubIpDoc();
      expect(ipCalls).toBe(1);

      let wkCalls = 0;
      expect(() =>
        servedFirestore.onSnapshotsInSync(workerDb, () => {
          wkCalls += 1;
          throw new Error('sync-wk-boom');
        }),
      ).toThrow('sync-wk-boom');
      expect(wkCalls).toBe(1);

      const unsubWkDoc = client.onSnapshot(client.doc(workerDb, 'syncBrand/s2'), () => {});
      await new Promise((r) => setTimeout(r, 20));
      await client.setDoc(client.doc(workerDb, 'syncBrand/s2'), { n: 2 });
      await new Promise((r) => setTimeout(r, 20));
      unsubWkDoc();
      expect(wkCalls).toBe(1);
    } finally {
      dispose();
    }
  });
});
