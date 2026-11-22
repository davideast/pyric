/**
 * Focused regression suite replaying Web RTDB follow-ups (#1924, #1458, #1418,
 * #1419, #1224, #1472) side-by-side against real `firebase@12.19.0` offline.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import * as fbApp from 'firebase/app';
import * as fbDb from 'firebase/database';
import { initializeSandbox } from 'pyric/sandbox';
import { createAppForSandbox } from '../../src/app/internal.js';
import { updateTargetPaths } from '../../src/database/client-cache-state.js';
import * as pyDb from '../../src/database/index.js';

let fbSeq = 0;
const fbApps: fbApp.FirebaseApp[] = [];

function openRealOfflineDb(databaseURL = 'https://p1-default-rtdb.firebaseio.com'): fbDb.Database {
  fbSeq += 1;
  const app = fbApp.initializeApp({ projectId: 'p1', databaseURL }, `rtdb-fu-fb-${fbSeq}-${Date.now()}`);
  fbApps.push(app);
  const db = fbDb.getDatabase(app);
  fbDb.goOffline(db);
  return db;
}

function openSandboxDb(): pyDb.Database {
  const sandbox = initializeSandbox({ projectId: 'p1' });
  const db = pyDb.getDatabase(sandbox);
  pyDb.sandbox.setDefaultPolicy(db, 'allow');
  return db;
}

function syncOutcome(call: () => unknown): { threw: boolean; name: string | null; message: string | null } {
  try {
    const result = call();
    if (result !== null && (typeof result === 'object' || typeof result === 'function') && 'catch' in result) {
      const catchFn = (result as { catch?: unknown }).catch;
      if (typeof catchFn === 'function') {
        (catchFn as (cb: () => void) => void).call(result, () => {});
      }
    }
    return { threw: false, name: null, message: null };
  } catch (err) {
    const error = err as Error;
    return {
      threw: true,
      name: error.name ?? error.constructor?.name ?? 'Error',
      message: error.message ?? String(err),
    };
  }
}

afterEach(async () => {
  while (fbApps.length > 0) {
    const app = fbApps.pop();
    if (app !== undefined) {
      await fbApp.deleteApp(app);
    }
  }
});

describe('#1924: orderByChild and filtering read only own properties', () => {
  it('orders missing Object.prototype-named fields first as null and matches equalTo(null) like firebase/database', async () => {
    const real = openRealOfflineDb();
    const sandbox = openSandboxDb();

    for (const prop of ['toString', 'valueOf', 'hasOwnProperty'] as const) {
      const realRef = fbDb.ref(real, `i1924/${prop}`);
      // Seed the parent node first so offline firebase/database marks `realRef` complete,
      // then write `a/${prop}` and `c/${prop}` as leaves so `validateFirebaseData`'s own
      // `obj.hasOwnProperty(key)` loop does not trip when `prop === 'hasOwnProperty'`.
      void fbDb.set(realRef, { b: { other: 1 }, d: { other: 2 } });
      void fbDb.set(fbDb.ref(real, `i1924/${prop}/a/${prop}`), 'z');
      void fbDb.set(fbDb.ref(real, `i1924/${prop}/c/${prop}`), 'm');
      const realOrder: string[] = [];
      fbDb.onValue(
        fbDb.query(realRef, fbDb.orderByChild(prop)),
        (snap) => {
          snap.forEach((childSnap) => {
            if (childSnap.key !== null) realOrder.push(childSnap.key);
          });
        },
        { onlyOnce: true },
      );
      const realNullMatches: string[] = [];
      fbDb.onValue(
        fbDb.query(realRef, fbDb.orderByChild(prop), fbDb.equalTo(null)),
        (snap) => {
          snap.forEach((childSnap) => {
            if (childSnap.key !== null) realNullMatches.push(childSnap.key);
          });
        },
        { onlyOnce: true },
      );

      const pyRef = pyDb.ref(sandbox, `i1924/${prop}`);
      await pyDb.set(pyRef, {
        a: { [prop]: 'z' },
        b: { other: 1 },
        c: { [prop]: 'm' },
        d: { other: 2 },
      });
      const pyOrderSnap = await pyDb.get(pyDb.query(pyRef, pyDb.orderByChild(prop)));
      const pyOrder: string[] = [];
      pyOrderSnap.forEach((childSnap) => {
        if (childSnap.key !== null) pyOrder.push(childSnap.key);
      });
      const pyNullSnap = await pyDb.get(pyDb.query(pyRef, pyDb.orderByChild(prop), pyDb.equalTo(null)));
      const pyNullMatches: string[] = [];
      pyNullSnap.forEach((childSnap) => {
        if (childSnap.key !== null) pyNullMatches.push(childSnap.key);
      });

      expect(realOrder).toEqual(['b', 'd', 'c', 'a']);
      expect(pyOrder).toEqual(realOrder);
      expect(realNullMatches).toEqual(['b', 'd']);
      expect(pyNullMatches).toEqual(realNullMatches);
    }

    // Deep nested path (`meta/toString`)
    const deepRef = pyDb.ref(sandbox, 'i1924/deep');
    await pyDb.set(deepRef, {
      a: { meta: { toString: 'z' } },
      b: { meta: { label: 'none' } },
      c: { meta: { toString: 'm' } },
      d: 'scalar',
    });
    const deepSnap = await pyDb.get(pyDb.query(deepRef, pyDb.orderByChild('meta/toString')));
    const deepKeys: string[] = [];
    deepSnap.forEach((ch) => {
      if (ch.key !== null) deepKeys.push(ch.key);
    });
    expect(deepKeys).toEqual(['b', 'd', 'c', 'a']);
  });
});

describe('#1458: update() accepts keys ending in .priority', () => {
  it('stores child, nested, root, serverTimestamp, and onDisconnect .priority updates and normalizes cache target paths', async () => {
    const real = openRealOfflineDb();
    const sandbox = openSandboxDb();

    const realRef = fbDb.ref(real, 'ok');
    void fbDb.set(realRef, { p: 1, nested: { q: 2 } });
    void fbDb.update(realRef, { 'p/.priority': 'z', 'nested/q/.priority': 5, '.priority': 'top' });
    let realExport: unknown;
    fbDb.onValue(realRef, (s) => { realExport = s.exportVal(); }, { onlyOnce: true });

    const pyRef = pyDb.ref(sandbox, 'ok');
    await pyDb.set(pyRef, { p: 1, nested: { q: 2 } });
    await pyDb.update(pyRef, { 'p/.priority': 'z', 'nested/q/.priority': 5, '.priority': 'top' });
    expect((await pyDb.get(pyRef)).exportVal()).toEqual(realExport);
    expect((await pyDb.get(pyRef)).exportVal()).toEqual({
      nested: { q: { '.value': 2, '.priority': 5 } },
      p: { '.value': 1, '.priority': 'z' },
      '.priority': 'top',
    });

    // Validation matches real SDK synchronously for invalid priority values and ancestor overlaps.
    expect(syncOutcome(() => pyDb.update(pyRef, { 'p/.priority': true }))).toEqual(
      syncOutcome(() => fbDb.update(realRef, { 'p/.priority': true })),
    );
    expect(syncOutcome(() => pyDb.update(pyRef, { p: 1, 'p/.priority': 'z' }))).toEqual(
      syncOutcome(() => fbDb.update(realRef, { p: 1, 'p/.priority': 'z' })),
    );

    // serverTimestamp() in .priority update key resolves to numeric timestamp.
    await pyDb.update(pyRef, { 'p/.priority': pyDb.serverTimestamp() });
    const afterTs = (await pyDb.get(pyDb.ref(sandbox, 'ok/p'))).priority;
    expect(typeof afterTs).toBe('number');

    // onDisconnect().update with trailing .priority applies on disconnect.
    await pyDb.onDisconnect(pyRef).update({ 'p/.priority': 'disc-prio' });
    pyDb.goOffline(sandbox);
    await Promise.resolve();
    pyDb.goOnline(sandbox);
    expect((await pyDb.get(pyDb.ref(sandbox, 'ok/p'))).exportVal()).toEqual({
      '.value': 1,
      '.priority': 'disc-prio',
    });

    // Normalized targetPaths ('/coldOk/p', not '/coldOk/p/.priority') abort a cold transaction under coldOk/p/sub.
    expect(updateTargetPaths('ok', { 'p/.priority': 'z', 'nested/q/.priority': 5, '.priority': 'top' })).toEqual([
      '/ok/p',
      '/ok/nested/q',
      '/ok',
    ]);
    const freshSandbox = initializeSandbox({ projectId: 'p1' });
    const freshDb = pyDb.getDatabase(freshSandbox);
    pyDb.sandbox.setDefaultPolicy(freshDb, 'allow');
    const adminDb = pyDb.getAdminDatabase(freshSandbox);
    await pyDb.set(pyDb.ref(adminDb, 'coldOk/p/sub'), 'seeded');
    const pendingColdTxn = pyDb.runTransaction(
      pyDb.ref(freshDb, 'coldOk/p/sub'),
      (cur) => cur ?? 'from-txn',
    );
    await expect(
      Promise.all([
        pendingColdTxn,
        pyDb.update(pyDb.ref(freshDb, 'coldOk'), { 'p/.priority': 'abort-prio' }),
      ]),
    ).rejects.toThrow('set');
  });
});

describe('#1418: snapshots freeze subtree priorities at construction time', () => {
  it('preserves val() key order, exportVal(), toJSON(), child(), and forEach() on plain and query snapshots after later setPriority', async () => {
    const real = openRealOfflineDb();
    const sandbox = openSandboxDb();

    const realRef = fbDb.ref(real, 'imm');
    void fbDb.set(realRef, { a: 1, b: 2, nested: { x: 10, y: 20 } });
    void fbDb.setPriority(realRef, 'root-before');
    void fbDb.setPriority(fbDb.ref(real, 'imm/a'), 10);
    void fbDb.setPriority(fbDb.ref(real, 'imm/b'), 1);
    void fbDb.setPriority(fbDb.ref(real, 'imm/nested/x'), 20);
    void fbDb.setPriority(fbDb.ref(real, 'imm/nested/y'), 2);
    let realSnapBefore: fbDb.DataSnapshot | undefined;
    fbDb.onValue(realRef, (s) => { realSnapBefore = s; }, { onlyOnce: true });
    if (realSnapBefore === undefined) {
      throw new Error('Expected synchronous offline onValue snapshot');
    }

    const pyRef = pyDb.ref(sandbox, 'imm');
    await pyDb.set(pyRef, { a: 1, b: 2, nested: { x: 10, y: 20 } });
    await pyDb.setPriority(pyRef, 'root-before');
    await pyDb.setPriority(pyDb.ref(sandbox, 'imm/a'), 10);
    await pyDb.setPriority(pyDb.ref(sandbox, 'imm/b'), 1);
    await pyDb.setPriority(pyDb.ref(sandbox, 'imm/nested/x'), 20);
    await pyDb.setPriority(pyDb.ref(sandbox, 'imm/nested/y'), 2);

    const plainSnapBefore = await pyDb.get(pyRef);
    const querySnapBefore = await pyDb.get(pyDb.query(pyRef, pyDb.orderByKey()));

    expect(Object.keys(plainSnapBefore.val() as object)).toEqual(['nested', 'b', 'a']);
    expect(Object.keys(querySnapBefore.val() as object)).toEqual(['nested', 'b', 'a']);

    // Mutate priorities after snapshots were taken.
    void fbDb.setPriority(realRef, 'root-after');
    void fbDb.setPriority(fbDb.ref(real, 'imm/a'), 0);
    void fbDb.setPriority(fbDb.ref(real, 'imm/nested/x'), 0);

    await pyDb.setPriority(pyRef, 'root-after');
    await pyDb.setPriority(pyDb.ref(sandbox, 'imm/a'), 0);
    await pyDb.setPriority(pyDb.ref(sandbox, 'imm/nested/x'), 0);

    // Held plain snapshot must match real Firebase's immutable held snapshot.
    expect(Object.keys(plainSnapBefore.val() as object)).toEqual(Object.keys(realSnapBefore.val() as object));
    expect(Object.keys(plainSnapBefore.val() as object)).toEqual(['nested', 'b', 'a']);
    expect(Object.keys((plainSnapBefore.val() as { nested: object }).nested)).toEqual(['y', 'x']);
    expect(plainSnapBefore.exportVal()).toEqual(realSnapBefore.exportVal());
    expect(plainSnapBefore.toJSON()).toEqual(realSnapBefore.toJSON());
    expect(plainSnapBefore.child('a').priority).toBe(10);
    expect(plainSnapBefore.child('nested').exportVal()).toEqual({
      y: { '.value': 20, '.priority': 2 },
      x: { '.value': 10, '.priority': 20 },
    });
    const iteratedPlain: Array<[string | null, string | number | null]> = [];
    plainSnapBefore.forEach((ch) => {
      iteratedPlain.push([ch.key, ch.priority]);
    });
    expect(iteratedPlain).toEqual([['nested', null], ['b', 1], ['a', 10]]);

    // Held query snapshot must also stay immutable.
    expect(Object.keys(querySnapBefore.val() as object)).toEqual(['nested', 'b', 'a']);
    expect(querySnapBefore.priority).toBe('root-before');
    expect(querySnapBefore.child('a').priority).toBe(10);
    expect(Object.keys(querySnapBefore.child('nested').val() as object)).toEqual(['y', 'x']);
    const iteratedQuery: Array<[string | null, string | number | null]> = [];
    querySnapBefore.forEach((ch) => {
      iteratedQuery.push([ch.key, ch.priority]);
    });
    expect(iteratedQuery).toEqual([['a', 10], ['b', 1], ['nested', null]]);
  });
});

describe('#1419: runTransaction passes current value keys in priority-then-key order', () => {
  it('matches snapshot.val() and firebase/database key ordering across online, synchronous backend, and offline transactions', async () => {
    const real = openRealOfflineDb();
    const sandbox = openSandboxDb();

    const realRef = fbDb.ref(real, 'txnOrder');
    const unsubReal = fbDb.onValue(realRef, () => {});
    void fbDb.set(realRef, { b: 1, a: 2, c: 3, nested: { z: 1, m: 2 } });
    void fbDb.setPriority(fbDb.ref(real, 'txnOrder/c'), 1);
    void fbDb.setPriority(fbDb.ref(real, 'txnOrder/b'), 2);
    void fbDb.setPriority(fbDb.ref(real, 'txnOrder/a'), 3);
    void fbDb.setPriority(fbDb.ref(real, 'txnOrder/nested/z'), 1);
    void fbDb.setPriority(fbDb.ref(real, 'txnOrder/nested/m'), 5);

    const realSeen: Array<{ top: string[]; nested: string[] }> = [];
    void fbDb.runTransaction(realRef, (cur) => {
      if (cur !== null && typeof cur === 'object') {
        const rec = cur as { nested: object };
        realSeen.push({ top: Object.keys(rec), nested: Object.keys(rec.nested) });
      }
      return cur;
    });
    unsubReal();

    const pyRef = pyDb.ref(sandbox, 'txnOrder');
    await pyDb.set(pyRef, { b: 1, a: 2, c: 3, nested: { z: 1, m: 2 } });
    await pyDb.setPriority(pyDb.ref(sandbox, 'txnOrder/c'), 1);
    await pyDb.setPriority(pyDb.ref(sandbox, 'txnOrder/b'), 2);
    await pyDb.setPriority(pyDb.ref(sandbox, 'txnOrder/a'), 3);
    await pyDb.setPriority(pyDb.ref(sandbox, 'txnOrder/nested/z'), 1);
    await pyDb.setPriority(pyDb.ref(sandbox, 'txnOrder/nested/m'), 5);

    const snapBefore = await pyDb.get(pyRef);
    const pySeen: Array<{ top: string[]; nested: string[] }> = [];
    await pyDb.runTransaction(pyRef, (cur) => {
      if (cur !== null && typeof cur === 'object') {
        const rec = cur as { nested: object };
        pySeen.push({ top: Object.keys(rec), nested: Object.keys(rec.nested) });
      }
      return undefined; // abort so priorities remain intact for offline check
    });

    expect(realSeen).toEqual([{ top: ['nested', 'c', 'b', 'a'], nested: ['z', 'm'] }]);
    expect(pySeen).toEqual(realSeen);
    expect(pySeen[0]?.top).toEqual(Object.keys(snapBefore.val() as object));

    // Offline transaction must also deliver priority-then-key order.
    const unsubPy = pyDb.onValue(pyRef, () => {});
    pyDb.goOffline(sandbox);
    const offlineSeen: string[][] = [];
    const pendingOffline = pyDb.runTransaction(pyRef, (cur) => {
      if (cur !== null && typeof cur === 'object') {
        offlineSeen.push(Object.keys(cur as object));
      }
      return undefined;
    });
    expect(offlineSeen).toEqual([['nested', 'c', 'b', 'a']]);
    await pendingOffline;
    pyDb.goOnline(sandbox);
    unsubPy();
  });
});

describe('#1224: synchronous write validation and .sv / .info refusals', () => {
  it('throws synchronously with the exact firebase/database text for invalid values, .sv sentinels, and .info writes', async () => {
    const real = openRealOfflineDb();
    const sandbox = openSandboxDb();

    const realWarm = fbDb.ref(real, 'node');
    const unsubReal = fbDb.onValue(realWarm, () => {});
    void fbDb.set(realWarm, { intact: 1 });

    const pyWarm = pyDb.ref(sandbox, 'node');
    await pyDb.set(pyWarm, { intact: 1 });
    await pyDb.get(pyWarm);

    const badFn = () => 1;
    const cases: Array<[string, () => unknown, () => unknown]> = [
      ['set NaN', () => pyDb.set(pyWarm, NaN), () => fbDb.set(realWarm, NaN)],
      ['set undefined', () => pyDb.set(pyWarm, undefined), () => fbDb.set(realWarm, undefined)],
      ['set function', () => pyDb.set(pyWarm, badFn), () => fbDb.set(realWarm, badFn)],
      ['update null', () => pyDb.update(pyWarm, null as never), () => fbDb.update(realWarm, null as never)],
      ['update undefined', () => pyDb.update(pyWarm, undefined as never), () => fbDb.update(realWarm, undefined as never)],
      ['push NaN', () => pyDb.push(pyWarm, NaN), () => fbDb.push(realWarm, NaN)],
      ['setWithPriority NaN value', () => pyDb.setWithPriority(pyWarm, NaN, 1), () => fbDb.setWithPriority(realWarm, NaN, 1)],
      ['setWithPriority NaN priority', () => pyDb.setWithPriority(pyWarm, 1, NaN), () => fbDb.setWithPriority(realWarm, 1, NaN)],
      ['runTransaction cold NaN', () => pyDb.runTransaction(pyDb.ref(sandbox, 'cold1'), () => NaN), () => fbDb.runTransaction(fbDb.ref(real, 'cold1'), () => NaN)],
      ['runTransaction warm NaN', () => pyDb.runTransaction(pyWarm, () => NaN), () => fbDb.runTransaction(realWarm, () => NaN)],
      ['runTransaction warm undefined prop', () => pyDb.runTransaction(pyWarm, () => ({ bad: undefined })), () => fbDb.runTransaction(realWarm, () => ({ bad: undefined }))],
      ['runTransaction warm function', () => pyDb.runTransaction(pyWarm, () => badFn as never), () => fbDb.runTransaction(realWarm, () => badFn as never)],
      ['runTransaction invalid top-level .priority', () => pyDb.runTransaction(pyWarm, () => ({ '.value': 1, '.priority': true })), () => fbDb.runTransaction(realWarm, () => ({ '.value': 1, '.priority': true }))],
      ['runTransaction invalid nested .priority', () => pyDb.runTransaction(pyWarm, () => ({ nested: { a: 1, '.priority': true } })), () => fbDb.runTransaction(realWarm, () => ({ nested: { a: 1, '.priority': true } }))],
      ['set inline .priority boolean', () => pyDb.set(pyWarm, { a: 1, '.priority': true }), () => fbDb.set(realWarm, { a: 1, '.priority': true })],
      ['set nested inline .priority boolean', () => pyDb.set(pyWarm, { nested: { a: 1, '.priority': true } }), () => fbDb.set(realWarm, { nested: { a: 1, '.priority': true } })],
      ['set .value + .priority boolean', () => pyDb.set(pyWarm, { '.value': 'v', '.priority': true }), () => fbDb.set(realWarm, { '.value': 'v', '.priority': true })],
      ['update inline .priority boolean', () => pyDb.update(pyWarm, { a: { '.value': 1, '.priority': true } }), () => fbDb.update(realWarm, { a: { '.value': 1, '.priority': true } })],
      ['push inline .priority boolean', () => pyDb.push(pyWarm, { a: 1, '.priority': true }), () => fbDb.push(realWarm, { a: 1, '.priority': true })],
      ['onDisconnect set inline .priority boolean', () => pyDb.onDisconnect(pyWarm).set({ a: 1, '.priority': true }), () => fbDb.onDisconnect(realWarm).set({ a: 1, '.priority': true })],
      ['set unknown .sv string', () => pyDb.set(pyWarm, { '.sv': 'bogus' }), () => fbDb.set(realWarm, { '.sv': 'bogus' })],
      ['set numeric .sv', () => pyDb.set(pyWarm, { '.sv': 123 }), () => fbDb.set(realWarm, { '.sv': 123 })],
      ['set empty object .sv', () => pyDb.set(pyWarm, { '.sv': {} }), () => fbDb.set(realWarm, { '.sv': {} })],
      ['set array .sv', () => pyDb.set(pyWarm, { '.sv': [] }), () => fbDb.set(realWarm, { '.sv': [] })],
      ['set null .sv', () => pyDb.set(pyWarm, { '.sv': null }), () => fbDb.set(realWarm, { '.sv': null })],
      ['set non-numeric increment', () => pyDb.set(pyWarm, { '.sv': { increment: 'x' } }), () => fbDb.set(realWarm, { '.sv': { increment: 'x' } })],
      ['set NaN increment', () => pyDb.set(pyWarm, { '.sv': { increment: NaN } }), () => fbDb.set(realWarm, { '.sv': { increment: NaN } })],
      ['setPriority bogus .sv', () => pyDb.setPriority(pyWarm, { '.sv': 'bogus' } as never), () => fbDb.setPriority(realWarm, { '.sv': 'bogus' } as never)],
      ['setWithPriority bogus .sv prio', () => pyDb.setWithPriority(pyWarm, 1, { '.sv': 'bogus' } as never), () => fbDb.setWithPriority(realWarm, 1, { '.sv': 'bogus' } as never)],
      ['update bogus .sv child', () => pyDb.update(pyWarm, { child: { '.sv': 'bogus' } }), () => fbDb.update(realWarm, { child: { '.sv': 'bogus' } })],
      ['update bogus .sv .priority', () => pyDb.update(pyWarm, { 'child/.priority': { '.sv': 'bogus' } }), () => fbDb.update(realWarm, { 'child/.priority': { '.sv': 'bogus' } })],
      ['runTransaction bogus .sv', () => pyDb.runTransaction(pyWarm, () => ({ '.sv': 'bogus' })), () => fbDb.runTransaction(realWarm, () => ({ '.sv': 'bogus' }))],
      ['set /.info/x', () => pyDb.set(pyDb.ref(sandbox, '.info/x'), 1), () => fbDb.set(fbDb.ref(real, '.info/x'), 1)],
      ['update root /.info/x', () => pyDb.update(pyDb.ref(sandbox), { '.info/x': 1 }), () => fbDb.update(fbDb.ref(real), { '.info/x': 1 })],
      ['onDisconnect /.info/x set', () => pyDb.onDisconnect(pyDb.ref(sandbox, '.info/x')).set(1), () => fbDb.onDisconnect(fbDb.ref(real, '.info/x')).set(1)],
    ];

    for (const [label, pyCall, fbCall] of cases) {
      const pyResult = syncOutcome(pyCall);
      const fbResult = syncOutcome(fbCall);
      expect(pyResult.threw, label).toBe(true);
      expect(pyResult, label).toEqual(fbResult);
    }

    // Valid .sv markers alongside sibling or .priority keys are accepted upstream.
    for (const validSv of [
      { '.sv': 'timestamp', other: 1 },
      { '.sv': 'timestamp', '.priority': 1 },
    ]) {
      expect(syncOutcome(() => fbDb.set(fbDb.ref(real, 'validSv'), validSv)).threw).toBe(false);
      expect(syncOutcome(() => pyDb.set(pyDb.ref(sandbox, 'validSv'), validSv)).threw).toBe(false);
    }

    // onDisconnect with malformed .sv does NOT throw synchronously (like firebase/database),
    // and rejects asynchronously without mutating stored data on disconnect.
    expect(syncOutcome(() => fbDb.onDisconnect(realWarm).set({ '.sv': 'bogus' })).threw).toBe(false);
    expect(syncOutcome(() => pyDb.onDisconnect(pyWarm).set({ '.sv': 'bogus' })).threw).toBe(false);
    expect(syncOutcome(() => pyDb.onDisconnect(pyWarm).setWithPriority('v', { '.sv': 'bogus' } as never)).threw).toBe(false);
    expect(syncOutcome(() => pyDb.onDisconnect(pyWarm).update({ a: { '.sv': 'bogus' } })).threw).toBe(false);
    await expect(pyDb.onDisconnect(pyWarm).set({ '.sv': 'bogus' })).rejects.toThrow('Unexpected server value: bogus');
    await expect(pyDb.onDisconnect(pyWarm).setWithPriority('v', { '.sv': 'bogus' } as never)).rejects.toThrow('Unexpected server value: bogus');
    await expect(pyDb.onDisconnect(pyWarm).update({ a: { '.sv': 'bogus' } })).rejects.toThrow('Unexpected server value: bogus');
    pyDb.goOffline(sandbox);
    await Promise.resolve();
    pyDb.goOnline(sandbox);

    unsubReal();
    expect((await pyDb.get(pyWarm)).val()).toEqual({ intact: 1 });
  });
});

describe('#1472: connectDatabaseEmulator records custom emulator host for refFromURL', () => {
  it('accepts localhost and custom URLs after connectDatabaseEmulator(db, "127.0.0.1", 9000) like firebase/database', () => {
    const fb = fbApp.initializeApp(
      { projectId: 'p1', databaseURL: 'https://p1-default-rtdb.firebaseio.com' },
      `emu-1472-fb-${Date.now()}`,
    );
    fbApps.push(fb);
    const real = fbDb.getDatabase(fb);
    fbDb.connectDatabaseEmulator(real, '127.0.0.1', 9000);
    fbDb.goOffline(real);

    const rawSandbox = initializeSandbox({
      projectId: 'p1',
      databaseURL: 'https://p1-default-rtdb.firebaseio.com',
    });
    const py = createAppForSandbox(
      rawSandbox,
      { projectId: 'p1', databaseURL: 'https://p1-default-rtdb.firebaseio.com' },
      `emu-1472-py-${Date.now()}`,
    );
    const sandbox = pyDb.getDatabase(py);
    pyDb.connectDatabaseEmulator(sandbox, '127.0.0.1', 9000);

    const realLocal = fbDb.refFromURL(real, 'http://localhost:9000/a?ns=p1-default-rtdb');
    const pyLocal = pyDb.refFromURL(sandbox, 'http://localhost:9000/a?ns=p1-default-rtdb');
    expect(pyLocal.key).toBe(realLocal.key);
    expect(pyLocal.toString()).toBe(realLocal.toString());
    expect(pyLocal.toString()).toBe('http://127.0.0.1:9000/a');

    const realOther = fbDb.refFromURL(real, 'https://other-db.firebaseio.com/x/y');
    const pyOther = pyDb.refFromURL(sandbox, 'https://other-db.firebaseio.com/x/y');
    expect(pyOther.toString()).toBe(realOther.toString());
  });
});
