/**
 * Served RTDB follow-up regression suite (#1924, #1458, #1460, #1418, #1419,
 * #1224, #1472) across SharedWorker, Node host, and `entries/database.js`.
 */
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'bun:test';
import * as fbApp from 'firebase/app';
import * as fbDb from 'firebase/database';
import { deleteApp, getApps } from 'pyric/app';
import { createAppForSandbox, resetAppRegistryForTests } from 'pyric/app/internal';
import { handleMessage, type PortLike } from '../../../src/serve/worker/host.js';
import type { InboundMessage, OutboundMessage, ResMessage } from '../../../src/serve/worker/protocol.js';
import * as client from '../../../src/serve/worker/index.js';
import { rtdbInstanceDatabase, rtdbRefFromURL } from '../../../src/serve/worker/client/rtdb-references.js';
import {
  hostedRtdbContext,
  restoreSharedWorker,
  servedRtdbContext,
  type ServedRtdbAdminContext,
} from './oracle-captures/support.ts';
import { type FakePort, makeHostCtx, portPair } from './integration-support.js';

restoreSharedWorker();

let fbSeq = 0;
const fbApps: fbApp.FirebaseApp[] = [];

function openRealOfflineDb(): fbDb.Database {
  fbSeq += 1;
  const app = fbApp.initializeApp(
    { projectId: 'p1', databaseURL: 'https://p1-default-rtdb.firebaseio.com' },
    `served-fu-fb-${fbSeq}-${Date.now()}`,
  );
  fbApps.push(app);
  const db = fbDb.getDatabase(app);
  fbDb.goOffline(db);
  return db;
}

function syncThrown(call: () => unknown): { threw: boolean; message: string | null } {
  try {
    const out = call();
    if (out !== null && (typeof out === 'object' || typeof out === 'function') && 'catch' in out) {
      const catchFn = (out as { catch?: unknown }).catch;
      if (typeof catchFn === 'function') {
        (catchFn as (cb: () => void) => void).call(out, () => {});
      }
    }
    return { threw: false, message: null };
  } catch (err) {
    return { threw: true, message: (err as Error).message ?? String(err) };
  }
}

afterEach(async () => {
  while (fbApps.length > 0) {
    const app = fbApps.pop();
    if (app !== undefined) {
      await fbApp.deleteApp(app);
    }
  }
  await Promise.all(getApps().map((app) => deleteApp(app).catch(() => undefined)));
  resetAppRegistryForTests();
});

type PlaneFactory = (rules?: Record<string, unknown>) => Promise<ServedRtdbAdminContext>;

const PLANES: ReadonlyArray<[string, PlaneFactory]> = [
  ['SharedWorker', (rules) => servedRtdbContext(rules)],
  ['Node host', (rules) => hostedRtdbContext(rules)],
];

const INDEXED_I1924_RULES = {
  rules: {
    '.read': true,
    '.write': true,
    pyric_oracle: {
      replay: {
        i1924: { '.indexOn': ['toString', 'valueOf'] },
      },
    },
  },
};

for (const [planeName, createPlane] of PLANES) {
  describe(`Served RTDB follow-ups (${planeName})`, () => {
    it('#1924: orderByChild("toString") orders missing fields as null and matches equalTo(null)', async () => {
      const ctx = await createPlane(INDEXED_I1924_RULES);
      const rtdb = ctx.rtdb;
      const db = ctx.db;
      const rowsRef = rtdb.ref(db, `${ctx.base}/i1924`);
      await rtdb.set(rowsRef, {
        a: { toString: 'z' },
        b: { other: 1 },
        c: { toString: 'm' },
        d: { other: 2 },
      });

      const orderedSnap = await rtdb.get(rtdb.query(rowsRef, rtdb.orderByChild('toString')));
      const orderedKeys: string[] = [];
      orderedSnap.forEach((ch) => {
        if (ch.key !== null) orderedKeys.push(ch.key);
      });
      expect(orderedKeys).toEqual(['b', 'd', 'c', 'a']);

      const nullSnap = await rtdb.get(
        rtdb.query(rowsRef, rtdb.orderByChild('toString'), rtdb.equalTo(null)),
      );
      const nullKeys: string[] = [];
      nullSnap.forEach((ch) => {
        if (ch.key !== null) nullKeys.push(ch.key);
      });
      expect(nullKeys).toEqual(['b', 'd']);
    });

    it('#1458 & #1460: update(.priority) and serverTimestamp() as priority succeed on live and disconnect paths', async () => {
      const ctx = await createPlane();
      const rtdb = ctx.rtdb;
      const db = ctx.db;

      // #1458
      const okRef = rtdb.ref(db, `${ctx.base}/i1458`);
      await rtdb.set(okRef, { p: 1 });
      await rtdb.update(okRef, { 'p/.priority': 'z' });
      expect((await rtdb.get(okRef)).exportVal()).toEqual({
        p: { '.value': 1, '.priority': 'z' },
      });
      await rtdb.update(okRef, { 'p/.priority': rtdb.serverTimestamp() });
      expect(typeof (await rtdb.get(rtdb.ref(db, `${ctx.base}/i1458/p`))).priority).toBe('number');

      // #1460: setPriority, setWithPriority, and onDisconnect().setWithPriority with both sentinel shapes
      const legacySentinel = { __rtdbSentinel: 'serverTimestamp' };
      for (const [tag, makeSentinel] of [
        ['sv', () => rtdb.serverTimestamp()],
        ['legacy-marker', () => legacySentinel],
      ] as const) {
        const target = rtdb.ref(db, `${ctx.base}/i1460_${tag}`);
        await rtdb.set(target, 'v0');
        await rtdb.setPriority(target, makeSentinel() as never);
        const p1 = (await rtdb.get(target)).priority;
        expect(typeof p1).toBe('number');

        await rtdb.setWithPriority(target, 'v1', makeSentinel() as never);
        const snap2 = await rtdb.get(target);
        expect(snap2.val()).toBe('v1');
        expect(typeof snap2.priority).toBe('number');

        await rtdb.onDisconnect(target).setWithPriority('v2', makeSentinel() as never);
        rtdb.goOffline(db);
        await ctx.wait();
        rtdb.goOnline(db);
        await ctx.wait();
        const snap3 = await rtdb.get(target);
        expect(snap3.val()).toBe('v2');
        expect(typeof snap3.priority).toBe('number');
      }
    });

    it('#1418 & #1419: snapshots stay immutable after setPriority and transactions receive priority-then-key order (online and offline)', async () => {
      const ctx = await createPlane();
      const rtdb = ctx.rtdb;
      const db = ctx.db;

      const r = rtdb.ref(db, `${ctx.base}/i1418_1419`);
      await rtdb.set(r, { b: 1, a: 2, c: 3, nested: { m: 2, z: 1 } });
      await rtdb.setPriority(rtdb.ref(db, `${ctx.base}/i1418_1419/c`), 1);
      await rtdb.setPriority(rtdb.ref(db, `${ctx.base}/i1418_1419/b`), 2);
      await rtdb.setPriority(rtdb.ref(db, `${ctx.base}/i1418_1419/a`), 3);
      await rtdb.setPriority(rtdb.ref(db, `${ctx.base}/i1418_1419/nested/z`), 1);
      await rtdb.setPriority(rtdb.ref(db, `${ctx.base}/i1418_1419/nested/m`), 5);

      const snapBefore = await rtdb.get(r);
      expect(Object.keys(snapBefore.val() as object)).toEqual(['nested', 'c', 'b', 'a']);
      expect(Object.keys((snapBefore.val() as { nested: object }).nested)).toEqual(['z', 'm']);

      // Online warm transaction sees ['nested', 'c', 'b', 'a'] and nested ['z', 'm']
      const onlineSeen: Array<{ top: string[]; nested: string[] }> = [];
      await rtdb.runTransaction(r, (cur) => {
        if (cur !== null && typeof cur === 'object') {
          const rec = cur as { nested: object };
          onlineSeen.push({ top: Object.keys(rec), nested: Object.keys(rec.nested) });
        }
        return undefined;
      });
      expect(onlineSeen).toEqual([{ top: ['nested', 'c', 'b', 'a'], nested: ['z', 'm'] }]);

      // Offline worker overlay get() and transaction preserve depth-2+ nested priorities too
      const unsub = rtdb.onValue(r, () => {});
      await ctx.wait();
      rtdb.goOffline(db);
      const offlineSnap = await rtdb.get(r);
      expect(Object.keys((offlineSnap.val() as { nested: object }).nested)).toEqual(['z', 'm']);
      expect(offlineSnap.child('nested').exportVal()).toEqual({
        z: { '.value': 1, '.priority': 1 },
        m: { '.value': 2, '.priority': 5 },
      });
      const offlineSeen: Array<{ top: string[]; nested: string[] }> = [];
      const offlineTxn = rtdb.runTransaction(r, (cur) => {
        if (cur !== null && typeof cur === 'object') {
          const rec = cur as { nested: object };
          offlineSeen.push({ top: Object.keys(rec), nested: Object.keys(rec.nested) });
        }
        return undefined;
      });
      expect(offlineSeen).toEqual([{ top: ['nested', 'c', 'b', 'a'], nested: ['z', 'm'] }]);
      await offlineTxn;

      // Offline overwrite clears stale descendant priorities
      const pendingOverwrite = rtdb.set(rtdb.ref(db, `${ctx.base}/i1418_1419/nested`), { m: 20, z: 10 });
      const afterOverwrite = await rtdb.get(rtdb.ref(db, `${ctx.base}/i1418_1419/nested`));
      expect(Object.keys(afterOverwrite.val() as object)).toEqual(['m', 'z']);
      expect(afterOverwrite.exportVal()).toEqual({ m: 20, z: 10 });
      rtdb.goOnline(db);
      await pendingOverwrite;
      await ctx.wait();
      unsub();

      // Mutate priority on 'c' to 99; held snapBefore must still report ['nested', 'c', 'b', 'a'] and old priority 1.
      await rtdb.setPriority(rtdb.ref(db, `${ctx.base}/i1418_1419/c`), 99);
      expect(Object.keys(snapBefore.val() as object)).toEqual(['nested', 'c', 'b', 'a']);
      expect(snapBefore.child('c').priority).toBe(1);
    });

    it('#1224: synchronously refuses invalid writes, cold runTransaction NaN, and bogus .sv sentinels matching firebase/database', async () => {
      const real = openRealOfflineDb();
      const ctx = await createPlane();
      const rtdb = ctx.rtdb;
      const db = ctx.db;

      const realNode = fbDb.ref(real, 'v1224');
      const unsubRealWarm = fbDb.onValue(realNode, () => {});
      void fbDb.set(realNode, { ok: 1 });
      const servedNode = rtdb.ref(db, '/v1224');
      await rtdb.set(servedNode, { ok: 1 });

      const table: Array<[string, () => unknown, () => unknown]> = [
        ['set bogus .sv', () => rtdb.set(servedNode, { '.sv': 'bogus' }), () => fbDb.set(realNode, { '.sv': 'bogus' })],
        ['set non-number increment', () => rtdb.set(servedNode, { '.sv': { increment: 'bad' } }), () => fbDb.set(realNode, { '.sv': { increment: 'bad' } })],
        ['set inline .priority bool', () => rtdb.set(servedNode, { a: 1, '.priority': true }), () => fbDb.set(realNode, { a: 1, '.priority': true })],
        ['set nested inline .priority bool', () => rtdb.set(servedNode, { nested: { a: 1, '.priority': true } }), () => fbDb.set(realNode, { nested: { a: 1, '.priority': true } })],
        ['setPriority bogus .sv', () => rtdb.setPriority(servedNode, { '.sv': 'bogus' } as never), () => fbDb.setPriority(realNode, { '.sv': 'bogus' } as never)],
        ['setWithPriority bogus .sv', () => rtdb.setWithPriority(servedNode, 1, { '.sv': 'bogus' } as never), () => fbDb.setWithPriority(realNode, 1, { '.sv': 'bogus' } as never)],
        ['update bogus .sv', () => rtdb.update(servedNode, { a: { '.sv': 'bogus' } }), () => fbDb.update(realNode, { a: { '.sv': 'bogus' } })],
        ['update inline .priority bool', () => rtdb.update(servedNode, { a: { '.value': 1, '.priority': true } }), () => fbDb.update(realNode, { a: { '.value': 1, '.priority': true } })],
        ['push inline .priority bool', () => rtdb.push(servedNode, { a: 1, '.priority': true }), () => fbDb.push(realNode, { a: 1, '.priority': true })],
        ['warm runTransaction NaN', () => rtdb.runTransaction(servedNode, () => NaN), () => fbDb.runTransaction(realNode, () => NaN)],
        ['warm runTransaction bogus .sv', () => rtdb.runTransaction(servedNode, () => ({ '.sv': 'bogus' })), () => fbDb.runTransaction(realNode, () => ({ '.sv': 'bogus' }))],
        ['warm runTransaction top .priority bool', () => rtdb.runTransaction(servedNode, () => ({ '.value': 1, '.priority': true })), () => fbDb.runTransaction(realNode, () => ({ '.value': 1, '.priority': true }))],
        ['warm runTransaction nested .priority bool', () => rtdb.runTransaction(servedNode, () => ({ nested: { a: 1, '.priority': true } })), () => fbDb.runTransaction(realNode, () => ({ nested: { a: 1, '.priority': true } }))],
        ['cold runTransaction NaN', () => rtdb.runTransaction(rtdb.ref(db, '/cold_nan'), () => NaN), () => fbDb.runTransaction(fbDb.ref(real, 'cold_nan'), () => NaN)],
        ['cold runTransaction bogus .sv', () => rtdb.runTransaction(rtdb.ref(db, '/cold_sv'), () => ({ '.sv': 'bogus' })), () => fbDb.runTransaction(fbDb.ref(real, 'cold_sv'), () => ({ '.sv': 'bogus' }))],
        ['cold runTransaction nested .priority bool', () => rtdb.runTransaction(rtdb.ref(db, '/cold_prio'), () => ({ nested: { a: 1, '.priority': true } })), () => fbDb.runTransaction(fbDb.ref(real, 'cold_prio'), () => ({ nested: { a: 1, '.priority': true } }))],
        ['onDisconnect set inline .priority bool', () => rtdb.onDisconnect(servedNode).set({ a: 1, '.priority': true }), () => fbDb.onDisconnect(realNode).set({ a: 1, '.priority': true })],
        ['set /.info/x', () => rtdb.set(rtdb.ref(db, '.info/x'), 1), () => fbDb.set(fbDb.ref(real, '.info/x'), 1)],
        ['update /.info/x key', () => rtdb.update(rtdb.ref(db), { '.info/x': 1 }), () => fbDb.update(fbDb.ref(real), { '.info/x': 1 })],
      ];

      for (const [label, servedCall, fbCall] of table) {
        const sOut = syncThrown(servedCall);
        const fOut = syncThrown(fbCall);
        expect(sOut.threw, label).toBe(true);
        expect(sOut, label).toEqual(fOut);
      }

      // onDisconnect with malformed .sv does not throw synchronously, and rejects asynchronously.
      expect(syncThrown(() => fbDb.onDisconnect(realNode).set({ '.sv': 'bogus' })).threw).toBe(false);
      expect(syncThrown(() => rtdb.onDisconnect(servedNode).set({ '.sv': 'bogus' })).threw).toBe(false);
      expect(syncThrown(() => rtdb.onDisconnect(servedNode).setWithPriority('v', { '.sv': 'bogus' } as never)).threw).toBe(false);
      expect(syncThrown(() => rtdb.onDisconnect(servedNode).update({ a: { '.sv': 'bogus' } })).threw).toBe(false);
      await expect(rtdb.onDisconnect(servedNode).set({ '.sv': 'bogus' })).rejects.toThrow('Unexpected server value: bogus');
      await expect(rtdb.onDisconnect(servedNode).setWithPriority('v', { '.sv': 'bogus' } as never)).rejects.toThrow('Unexpected server value: bogus');
      await expect(rtdb.onDisconnect(servedNode).update({ a: { '.sv': 'bogus' } })).rejects.toThrow('Unexpected server value: bogus');

      unsubRealWarm();

      expect((await rtdb.get(servedNode)).val()).toEqual({ ok: 1 });

      // Authoritative worker server-mirror regressions:
      // (a) Online set/update with increment(delta) + active listener does not double-increment warm txn or offline get
      const seeder = await ctx.newClient('mirror-seeder');
      const cntPath = `${ctx.base}/mirror_cnt`;
      await rtdb.set(rtdb.ref(seeder.db, cntPath), { total: 10 });
      const cntRef = rtdb.ref(db, cntPath);
      const unsubCnt = rtdb.onValue(cntRef, () => {});
      await ctx.wait();
      await rtdb.set(cntRef, { total: rtdb.increment(5) });
      await ctx.wait();
      const cntTxn = await rtdb.runTransaction(cntRef, (cur) => {
        const rec = cur as { total: number } | null;
        if (rec !== null && rec.total >= 20) return undefined;
        return { total: (rec?.total ?? 0) + 1 };
      });
      expect(cntTxn.committed).toBe(true);
      expect(cntTxn.snapshot.val()).toEqual({ total: 16 });
      await rtdb.update(cntRef, { total: rtdb.increment(4) });
      await ctx.wait();
      rtdb.goOffline(db);
      expect((await rtdb.get(cntRef)).val()).toEqual({ total: 20 });
      rtdb.goOnline(db);
      await ctx.wait();
      unsubCnt();

      // (b) Cold set with increment(delta) without listener does not fabricate 0 + delta
      const coldIncPath = `${ctx.base}/mirror_cold_inc`;
      await rtdb.set(rtdb.ref(seeder.db, coldIncPath), { total: 10 });
      const coldIncRef = rtdb.ref(db, coldIncPath);
      await rtdb.set(coldIncRef, { total: rtdb.increment(5) });
      const coldIncTxn = await rtdb.runTransaction(coldIncRef, (cur) => {
        const rec = cur as { total: number } | null;
        if (rec !== null && rec.total < 10) return undefined;
        return { total: (rec?.total ?? 0) + 1 };
      });
      expect(coldIncTxn.committed).toBe(true);
      expect(coldIncTxn.snapshot.val()).toEqual({ total: 16 });

      // (c) Partial child update on cold parent does not hide uncached siblings from parent runTransaction,
      //     while still throwing synchronously on invalid candidates
      const partialPath = `${ctx.base}/mirror_partial`;
      await rtdb.set(rtdb.ref(seeder.db, partialPath), { a: 1, b: 0 });
      const partialRef = rtdb.ref(db, partialPath);
      await rtdb.update(partialRef, { b: 2 });
      expect(syncThrown(() => rtdb.runTransaction(partialRef, () => NaN)).threw).toBe(true);
      const partialTxn = await rtdb.runTransaction(partialRef, (cur) => {
        const rec = cur as { a?: number; b?: number } | null;
        if (rec !== null && rec.a === undefined) return undefined;
        return { ...(rec ?? {}), c: 3 };
      });
      expect(partialTxn.committed).toBe(true);
      expect(partialTxn.snapshot.val()).toEqual({ a: 1, b: 2, c: 3 });

      // (d) Warm pass-0 callback returning undefined re-evaluates when server state diverged from local mirror
      const createOnlyDeletedPath = `${ctx.base}/mirror_create_only_deleted`;
      const createOnlyDeletedRef = rtdb.ref(db, createOnlyDeletedPath);
      await rtdb.set(createOnlyDeletedRef, { created: true });
      await rtdb.remove(rtdb.ref(seeder.db, createOnlyDeletedPath));
      const recreated = await rtdb.runTransaction(createOnlyDeletedRef, (cur) =>
        cur === null ? { created: 'again' } : undefined,
      );
      expect(recreated.committed).toBe(true);
      expect(recreated.snapshot.val()).toEqual({ created: 'again' });
    });

    it('re-runs warm create-only transaction against null and rejects permission_denied after read/write access is revoked (#3223)', async () => {
      const ctx = await createPlane({
        rules: {
          users: {
            $uid: {
              '.read': 'auth != null && auth.uid === $uid',
              '.write': 'auth != null && auth.uid === $uid',
            },
          },
        },
      });
      const authed = await ctx.openAuthedClient('revoked-writer');
      const ownRef = ctx.rtdb.ref(authed.db, `/users/${authed.uid}`);
      await ctx.rtdb.set(ownRef, { stamped: ctx.rtdb.serverTimestamp() });
      await client.signOut(client.getAuth(authed.db as unknown as client.ClientDb));
      await expect(
        ctx.rtdb.runTransaction(ownRef, (cur) => (cur === null ? { created: true } : undefined)),
      ).rejects.toThrow('permission_denied');
    });

    it('#1472: rtdbConnectDatabaseEmulator updates instance URL so rtdbRefFromURL accepts localhost', async () => {
      const ctx = await createPlane();
      const opened = await ctx.newClient('emu-1472');
      const db = rtdbInstanceDatabase(opened.db as unknown as client.ClientRtdb, {
        name: 'p1-default-rtdb',
        url: 'https://p1-default-rtdb.firebaseio.com/',
      });
      client.rtdbConnectDatabaseEmulator(db, '127.0.0.1', 9000);
      const resolved = rtdbRefFromURL(db, 'http://localhost:9000/a?ns=p1-default-rtdb');
      expect(resolved.path).toBe('/a');
      expect(resolved.toString()).toBe('http://127.0.0.1:9000/a');
    });
  });
}

describe('Served host defense-in-depth (RP-3 #1224) and entries/database.js (#1472)', () => {
  it('host rejects a raw bogus .sv frame without poisoning ancestor get() or active listeners', async () => {
    const ctx = await makeHostCtx();
    const messages: OutboundMessage[] = [];
    const port: PortLike = {
      postMessage: (m: OutboundMessage) => {
        messages.push(m);
      },
    };
    await handleMessage(ctx, port, {
      t: 'op',
      id: 'seed-1',
      method: 'rtdb.set',
      path: '/room/msg',
      value: 'clean',
      actAs: { mode: 'admin' },
    });
    await handleMessage(ctx, port, {
      t: 'op',
      id: 'bad-sv',
      method: 'rtdb.set',
      path: '/room/poison',
      value: { '.sv': 'bogus' },
      actAs: { mode: 'admin' },
    });
    const badRes = messages.find((m): m is ResMessage => m.t === 'res' && m.id === 'bad-sv');
    expect(badRes?.ok).toBe(false);

    await handleMessage(ctx, port, {
      t: 'op',
      id: 'read-parent',
      method: 'rtdb.get',
      path: '/room',
      actAs: { mode: 'admin' },
    });
    const readRes = messages.find((m): m is ResMessage => m.t === 'res' && m.id === 'read-parent');
    expect(readRes?.ok).toBe(true);
    if (readRes !== undefined && readRes.ok) {
      expect((readRes.value as { value: unknown }).value).toEqual({ msg: 'clean' });
    }
  });

  it('served database-surface.ts connectDatabaseEmulator lets refFromURL accept localhost (#1472)', async () => {
    const ctx = await makeHostCtx();
    (globalThis as { SharedWorker?: unknown }).SharedWorker = class {
      port: FakePort;
      addEventListener() {}
      constructor(_url: unknown, _opts: unknown) {
        const { a: clientPort, b: hostPort } = portPair();
        const hostPortLike: PortLike = {
          postMessage: (message: OutboundMessage) => hostPort.postMessage(message),
        };
        hostPort.onmessage = (event) => {
          void handleMessage(ctx, hostPortLike, event.data as InboundMessage);
        };
        this.port = clientPort;
      }
    };
    try {
      const databaseSurface = await import('../../../src/serve/entries/database-surface.js');
      const app = createAppForSandbox(
        ctx.sandbox,
        { projectId: 'p1', databaseURL: 'https://p1-default-rtdb.firebaseio.com' },
        `served-1472-${Date.now()}`,
      );
      const db = databaseSurface.getDatabase(app);
      databaseSurface.connectDatabaseEmulator(db, '127.0.0.1', 9000);
      const r = databaseSurface.refFromURL(db, 'http://localhost:9000/a?ns=p1-default-rtdb');
      expect(r.key).toBe('a');
      expect(r.toString()).toBe('http://127.0.0.1:9000/a');
    } finally {
      ctx.sandbox.dispose();
    }
  });
});
