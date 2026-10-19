import { describe, expect, test } from 'bun:test';
import {
  getDatabase as getInProcessDatabase,
  ref as inProcessRef,
  child as inProcessChild,
  set as inProcessSet,
  setWithPriority as inProcessSetWithPriority,
  get as inProcessGet,
  limitToFirst as rtdbLimitToFirst,
  orderByChild as rtdbOrderByChild,
  query as buildRtdbQuery,
} from 'pyric/database';
import {
  getFirestore as getInProcessFirestore,
  collection as ipCollection,
  doc as ipDoc,
  setDoc as ipSetDoc,
  getDoc as ipGetDoc,
  getDocs as ipGetDocs,
  query as ipQuery,
  orderBy as ipOrderBy,
  startAt as ipStartAt,
  startAfter as ipStartAfter,
  endAt as ipEndAt,
  endBefore as ipEndBefore,
  QueryConstraint,
  QueryFieldFilterConstraint,
  QueryCompositeFilterConstraint,
  QueryOrderByConstraint,
  QueryLimitConstraint,
  QueryStartAtConstraint,
  QueryEndAtConstraint,
  type FirestoreDataConverter,
} from 'pyric/firestore';
import { getFirestore as getAdminFirestore } from 'pyric/sandbox/admin-firestore';
import * as client from '../../../src/serve/worker/index.js';
import { _pending, disconnectPort, rejectPendingRequest } from '../../../src/serve/worker/client/core.js';
import { getDeferredFirestore } from '../../../src/serve/worker/client/deferred-connection.js';
import { messagingGetMessaging, messagingGetToken } from '../../../src/serve/worker/client/messaging.js';
import { aiStreamGenerateContent } from '../../../src/serve/worker/client/ai.js';
import { subscribeEvents } from '../../../src/serve/worker/client/studio.js';
import { addedKeys, attached, barrier, cleanups, gate, Host, until } from './hosted-delivery-contract-support.js';
import { connectClient } from './integration-support.js';

const ALLOW_ALL_FIRESTORE_RULES =
  "rules_version = '2'; service cloud.firestore { match /databases/{database}/documents { match /{document=**} { allow read, write: if true; } } }";

function settle<T>(promise: Promise<T>): Promise<
  | { status: 'resolved'; value: T }
  | { status: 'rejected'; code: string | undefined; message: string }
> {
  return promise.then(
    (value) => ({ status: 'resolved', value }),
    (error: { code?: string; message?: string }) => ({
      status: 'rejected',
      code: error?.code,
      message: error?.message ?? String(error),
    }),
  );
}

describe('worker client proxy transport & parity hunt (#1124 / #1110)', () => {
  test('SW-CLI-1a/b: operation queued behind SendReservation survives socket drop and sends once in call order after reconnect', async () => {
    const host = new Host();
    host.answers.set('messaging.getToken', { token: 'tok-1' });
    const { db, states } = await attached(host);

    const regGate = gate<string>();
    const messaging = messagingGetMessaging(db, () => regGate.promise);
    const tokenPromise = messagingGetToken(messaging);

    const writeOutcome = settle(client.setDoc(client.doc(db, 'items/a'), { ok: true }));
    expect(host.frames.filter((frame) => frame.t === 'op' && frame.method === 'setDoc')).toHaveLength(0);

    // Drop the WebSocket while the reservation is still open, then release while detached.
    host.stop();
    await until(() => states.at(-1) === 'interrupted');

    regGate.open('sw-reg-1');
    host.start();
    await until(() => states.filter((state) => state === 'attached').length >= 2);

    const tokenResult = await tokenPromise;
    const writeResult = await writeOutcome;
    await barrier(db);

    const opMethods = host.frames
      .filter((frame) => frame.t === 'op' && (frame.method === 'messaging.getToken' || frame.method === 'setDoc'))
      .map((frame) => frame.method);

    expect(tokenResult).toBe('tok-1');
    expect(writeResult).toEqual({ status: 'resolved', value: undefined });
    expect(opMethods).toEqual(['messaging.getToken', 'setDoc']);
  });

  test('SW-CLI-1b: rejected pending operation waiting behind SendReservation is withdrawn and never sent as a ghost write', async () => {
    const host = new Host();
    host.answers.set('messaging.getToken', { token: 'tok-2' });
    const { db, states } = await attached(host);

    const regGate = gate<string>();
    const messaging = messagingGetMessaging(db, () => regGate.promise);
    const tokenPromise = messagingGetToken(messaging);

    let writeOutcome!: ReturnType<typeof settle<void>>;
    const [writeOpId] = addedKeys(_pending, () => {
      writeOutcome = settle(client.setDoc(client.doc(db, 'items/cancelled'), { ghost: true }));
    });
    expect(writeOpId).toBeDefined();

    // Cancel/reject the queued operation while detached before the reservation releases.
    host.stop();
    await until(() => states.at(-1) === 'interrupted');
    rejectPendingRequest(writeOpId!, Object.assign(new Error('cancelled locally'), { code: 'cancelled' }));
    expect((await writeOutcome).status).toBe('rejected');

    regGate.open('sw-reg-2');
    host.start();
    await until(() => states.filter((state) => state === 'attached').length >= 2);

    expect(await tokenPromise).toBe('tok-2');
    await barrier(db);
    expect(host.frames.filter((frame) => frame.t === 'op' && frame.method === 'setDoc')).toHaveLength(0);
  });

  test('SW-CLI-2a/b/c: ClientDataSnapshot.child() and .forEach() preserve array iteration, nested priority, and priority ordering', async () => {
    const { ctx: ipCtx } = await connectClient();
    const ipDb = getInProcessDatabase(ipCtx.sandbox);
    const ipRoot = inProcessRef(ipDb, 'room');
    await inProcessSet(inProcessChild(ipRoot, 'items'), ['first', 'second']);
    await inProcessSetWithPriority(inProcessChild(ipRoot, 'users/lin'), { score: 20 }, 20);
    await inProcessSetWithPriority(inProcessChild(ipRoot, 'users/ada'), { score: 10 }, 10);

    const ipSnap = await inProcessGet(ipRoot);
    const ipIteratedItems: Array<{ key: string | null; val: unknown }> = [];
    ipSnap.child('items').forEach((c) => {
      ipIteratedItems.push({ key: c.key, val: c.val() });
    });
    const ipIteratedUsers: Array<{ key: string | null; priority: string | number | null; exportVal: unknown }> = [];
    ipSnap.child('users').forEach((c) => {
      ipIteratedUsers.push({ key: c.key, priority: c.priority, exportVal: c.exportVal() });
    });

    const { db } = await connectClient();
    const rtdb = client.rtdbGetDatabase(db);
    const root = client.rtdbRef(rtdb, 'room');
    await client.rtdbSet(client.rtdbChild(root, 'items'), ['first', 'second']);
    await client.rtdbSetWithPriority(client.rtdbChild(root, 'users/lin'), { score: 20 }, 20);
    await client.rtdbSetWithPriority(client.rtdbChild(root, 'users/ada'), { score: 10 }, 10);

    const snap = await client.rtdbGet(root);
    const itemsSnap = snap.child('items');
    const iteratedItems: Array<{ key: string | null; val: unknown }> = [];
    itemsSnap.forEach((c) => {
      iteratedItems.push({ key: c.key, val: c.val() });
    });
    const usersSnap = snap.child('users');
    const iteratedUsers: Array<{ key: string | null; priority: string | number | null; exportVal: unknown }> = [];
    usersSnap.forEach((c) => {
      iteratedUsers.push({ key: c.key, priority: c.priority, exportVal: c.exportVal() });
    });

    expect(itemsSnap.size).toBe(ipSnap.child('items').size);
    expect(itemsSnap.hasChildren()).toBe(ipSnap.child('items').hasChildren());
    expect(iteratedItems).toEqual(ipIteratedItems);
    expect(snap.child('users/ada').priority).toBe(ipSnap.child('users/ada').priority);
    expect(snap.child('users').child('ada').priority).toBe(ipSnap.child('users').child('ada').priority);
    expect(iteratedUsers).toEqual(ipIteratedUsers);
  });

  test('SW-CLI-4a/b: auth and lens transitions suppress unchanged doc snapshots and duplicate unindexed RTDB warnings, while delivering real mutations', async () => {
    const { db } = await connectClient();
    const rtdb = client.rtdbGetDatabase(db);
    const auth = client.getAuth(db);

    await client.setRules(db, ALLOW_ALL_FIRESTORE_RULES);
    await client.setDatabaseRules(rtdb, {
      rules: { scores: { '.read': true, '.write': true } },
    });

    await client.setDoc(client.doc(db, 'rooms/r1'), { title: 'Hello' });
    await client.rtdbSet(client.rtdbRef(rtdb, 'scores'), {
      ada: { pos: 2 },
      grace: { pos: 1 },
    });

    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };
    cleanups.push(() => {
      console.warn = originalWarn;
      client.setLens(undefined);
    });

    let queryDeliveries = 0;
    const docTitles: Array<string | undefined> = [];
    let rtdbLimitedDeliveries = 0;

    const unsubQuery = client.onSnapshot(client.collection(db, 'rooms'), () => {
      queryDeliveries += 1;
    });
    const unsubDoc = client.onSnapshot(client.doc(db, 'rooms/r1'), (snap) => {
      docTitles.push(snap.data()?.title as string | undefined);
    });
    const limitedScores = buildRtdbQuery(
      client.rtdbRef(rtdb, 'scores'),
      rtdbOrderByChild('pos'),
      rtdbLimitToFirst(1),
    );
    const unsubRtdb = client.rtdbOnValue(limitedScores, () => {
      rtdbLimitedDeliveries += 1;
    });
    cleanups.push(() => {
      unsubQuery();
      unsubDoc();
      unsubRtdb();
    });

    await until(() => queryDeliveries >= 1 && docTitles.length >= 1 && rtdbLimitedDeliveries >= 1);

    // Trigger session and lens re-establishments without mutating data.
    await client.signInAnonymously(auth);
    await client.signOut(auth);
    client.setLens({ mode: 'admin' });
    client.setLens(undefined);
    await client.getDoc(client.doc(db, 'rooms/r1'));
    await client.rtdbGet(client.rtdbRef(rtdb, 'scores'));

    expect(queryDeliveries).toBe(1);
    expect(docTitles).toEqual(['Hello']);
    expect(rtdbLimitedDeliveries).toBe(1);
    expect(warnings).toHaveLength(1);

    // Mutating the document still delivers the updated snapshot immediately.
    await client.setDoc(client.doc(db, 'rooms/r1'), { title: 'Updated' });
    await until(() => docTitles.length >= 2);
    expect(docTitles).toEqual(['Hello', 'Updated']);
  });

  test('SW-CLI-5a: open AI stream rejects promptly on disconnectPort and on non-retryable WebSocket failure', async () => {
    let transportReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      transportReady = resolve;
    });
    const deferredDb = getDeferredFirestore(
      Promise.resolve((existingPort) => {
        const port = Object.assign(existingPort ?? {}, {
          onmessage: existingPort?.onmessage ?? null,
          postMessage() {},
          start() {},
          close() {},
        });
        transportReady();
        return { __kind: 'client-db' as const, port };
      }),
    );
    await ready;
    const stream = aiStreamGenerateContent(deferredDb, { model: 'models/test', request: {} });
    const nextOutcome = settle(stream.next());
    disconnectPort(deferredDb.port);
    expect(await nextOutcome).toMatchObject({ status: 'rejected', code: 'app/app-deleted' });

    const host = new Host();
    const { db } = await attached(host);
    const wsStream = aiStreamGenerateContent(db, { model: 'models/test', request: {} });
    const wsNextOutcome = settle(wsStream.next());
    await barrier(db);
    host.pushRaw('not-json');
    expect(await wsNextOutcome).toMatchObject({ status: 'rejected', code: 'unavailable' });
  });

  test('SW-CLI-5b: subscribeEvents on a deferred connection invokes onError when connection setup rejects', async () => {
    let rejectConn!: (reason?: unknown) => void;
    const connPromise = new Promise<never>((_, reject) => {
      rejectConn = reject;
    });
    const db = getDeferredFirestore(connPromise);
    const errPromise = new Promise<Error & { code?: string }>((_, reject) => {
      subscribeEvents(db, () => {}, (err) => reject(err));
    });
    rejectConn(Object.assign(new Error('boot failed'), { code: 'unavailable' }));
    const outcome = await settle(errPromise);
    expect(outcome).toMatchObject({ status: 'rejected', code: 'unavailable' });
  });

  test('SW-CLI-5c: in-flight operation on attached WebSocket settles with unavailable when db.port.close() is called', async () => {
    const host = new Host();
    host.unanswered.add('getDoc');
    const { db } = await attached(host);

    const readOutcome = settle(client.getDoc(client.doc(db, 'rooms/r1')));
    await until(() => host.frames.some((frame) => frame.t === 'op' && frame.method === 'getDoc'));
    db.port.close();

    expect(await readOutcome).toMatchObject({
      status: 'rejected',
      code: 'unavailable',
      message: 'The hosted sandbox connection is closed.',
    });
  });

  test('SW-CLI-6a/b: snapshot cursors match in-process pagination without running fromFirestore, clone cleanly, and expose QueryConstraint types', async () => {
    let converterReads = 0;
    const converter: FirestoreDataConverter<{ displayRank: number }> = {
      toFirestore: (model) => ({ rank: model.displayRank / 10 }),
      fromFirestore: (snap) => {
        converterReads += 1;
        return { displayRank: (snap.data().rank as number) * 10 };
      },
    };

    const { ctx: ipCtx } = await connectClient();
    const ipDb = getInProcessFirestore(ipCtx.sandbox);
    getAdminFirestore(ipCtx.sandbox.withAuth(null)).setRules(ALLOW_ALL_FIRESTORE_RULES);
    const ipColl = ipCollection(ipDb, 'items').withConverter(converter);
    await ipSetDoc(ipDoc(ipColl, 'a'), { displayRank: 10 });
    await ipSetDoc(ipDoc(ipColl, 'b'), { displayRank: 20 });
    await ipSetDoc(ipDoc(ipColl, 'c'), { displayRank: 20 });
    await ipSetDoc(ipDoc(ipColl, 'd'), { displayRank: 30 });
    const ipCursorB = await ipGetDoc(ipDoc(ipColl, 'b'));

    const { db } = await connectClient();
    await client.setRules(db, ALLOW_ALL_FIRESTORE_RULES);
    const coll = client.collection(db, 'items').withConverter(converter);
    await client.setDoc(client.doc(coll, 'a'), { displayRank: 10 });
    await client.setDoc(client.doc(coll, 'b'), { displayRank: 20 });
    await client.setDoc(client.doc(coll, 'c'), { displayRank: 20 });
    await client.setDoc(client.doc(coll, 'd'), { displayRank: 30 });

    const cursorB = await client.getDoc(client.doc(coll, 'b'));
    const readsBeforeCursorBuild = converterReads;

    const qStartAfter = client.query(coll, client.orderBy('rank'), client.startAfter(cursorB));
    const qStartAt = client.query(coll, client.orderBy('rank'), client.startAt(cursorB));
    const qEndAt = client.query(coll, client.orderBy('rank'), client.endAt(cursorB));
    const qEndBefore = client.query(coll, client.orderBy('rank'), client.endBefore(cursorB));
    const qKeyOnly = client.query(coll, client.startAfter(cursorB));

    expect(converterReads).toBe(readsBeforeCursorBuild);
    expect(() => structuredClone(qStartAfter.descriptor)).not.toThrow();

    expect((await client.getDocs(qStartAfter)).docs.map((d) => d.id)).toEqual(
      (await ipGetDocs(ipQuery(ipColl, ipOrderBy('rank'), ipStartAfter(ipCursorB)))).docs.map((d) => d.id),
    );
    expect((await client.getDocs(qStartAt)).docs.map((d) => d.id)).toEqual(
      (await ipGetDocs(ipQuery(ipColl, ipOrderBy('rank'), ipStartAt(ipCursorB)))).docs.map((d) => d.id),
    );
    expect((await client.getDocs(qEndAt)).docs.map((d) => d.id)).toEqual(
      (await ipGetDocs(ipQuery(ipColl, ipOrderBy('rank'), ipEndAt(ipCursorB)))).docs.map((d) => d.id),
    );
    expect((await client.getDocs(qEndBefore)).docs.map((d) => d.id)).toEqual(
      (await ipGetDocs(ipQuery(ipColl, ipOrderBy('rank'), ipEndBefore(ipCursorB)))).docs.map((d) => d.id),
    );
    expect((await client.getDocs(qKeyOnly)).docs.map((d) => d.id)).toEqual(
      (await ipGetDocs(ipQuery(ipColl, ipStartAfter(ipCursorB)))).docs.map((d) => d.id),
    );

    const missingSnap = await client.getDoc(client.doc(coll, 'missing'));
    expect(() => client.query(coll, client.orderBy('rank'), client.startAfter(missingSnap))).toThrow();

    const w = client.where('rank', '==', 1);
    const orC = client.or(w, client.where('rank', '==', 2));
    const andC = client.and(w, client.where('rank', '>', 0));
    const ord = client.orderBy('rank');
    const lim = client.limit(5);
    const limLast = client.limitToLast(5);
    const sAt = client.startAt(1);
    const sAfter = client.startAfter(1);
    const eAt = client.endAt(1);
    const eBefore = client.endBefore(1);

    for (const c of [w, orC, andC, ord, lim, limLast, sAt, sAfter, eAt, eBefore]) {
      expect(c instanceof QueryConstraint).toBe(true);
    }
    expect(w instanceof QueryFieldFilterConstraint).toBe(true);
    expect(orC instanceof QueryCompositeFilterConstraint).toBe(true);
    expect(andC instanceof QueryCompositeFilterConstraint).toBe(true);
    expect(ord instanceof QueryOrderByConstraint).toBe(true);
    expect(lim instanceof QueryLimitConstraint).toBe(true);
    expect(limLast instanceof QueryLimitConstraint).toBe(true);
    expect(sAt instanceof QueryStartAtConstraint).toBe(true);
    expect(sAfter instanceof QueryStartAtConstraint).toBe(true);
    expect(eAt instanceof QueryEndAtConstraint).toBe(true);
    expect(eBefore instanceof QueryEndAtConstraint).toBe(true);
  });

  test('SW-PRO-6a: ClientTransaction set/update/delete return the transaction handle for method chaining', async () => {
    const { db } = await connectClient();
    await client.setRules(db, ALLOW_ALL_FIRESTORE_RULES);
    await client.setDoc(client.doc(db, 'items/b'), { count: 1 });
    await client.setDoc(client.doc(db, 'items/c'), { drop: true });

    await client.runTransaction(db, async (tx) => {
      const chained = tx
        .set(client.doc(db, 'items/a'), { ok: true })
        .update(client.doc(db, 'items/b'), { count: 2 })
        .delete(client.doc(db, 'items/c'));
      expect(chained).toBe(tx);
    });

    expect((await client.getDoc(client.doc(db, 'items/a'))).data()).toEqual({ ok: true });
    expect((await client.getDoc(client.doc(db, 'items/b'))).data()).toEqual({ count: 2 });
    expect((await client.getDoc(client.doc(db, 'items/c'))).exists()).toBe(false);
  });
});
