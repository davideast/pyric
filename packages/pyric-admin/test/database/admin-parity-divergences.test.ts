/**
 * Dual-arm (`in-process` and `shared-worker`) regression tests for
 * `pyric-admin/database` parity issues `#1927`, `#1928`, `#1930`, `#1931`,
 * `#1932`, and `#1935` (admin path cache).
 */

import { afterEach, describe, expect, test } from 'bun:test';
import {
  deleteApp as deleteProdApp,
  getApps as getProdApps,
  initializeApp as initializeProdApp,
} from 'firebase-admin/app';
import {
  getDatabase as getProdDatabase,
  getDatabaseWithUrl as getProdDatabaseWithUrl,
} from 'firebase-admin/database';
import {
  deleteApp,
  getApps,
  initializeApp,
  type PyricAdminApp,
} from '../../src/app/index.js';
import { AdminPathCache } from '../../src/database/admin-transaction.js';
import {
  getDatabase,
  getDatabaseWithUrl,
  ServerValue,
  type Database,
} from '../../src/database/index.js';
import { inProcessApp, sharedWorkerApp } from './arms.js';

let seq = 0;

interface AdminArm {
  readonly name: string;
  readonly makeApp: () => PyricAdminApp;
}

const ARMS: ReadonlyArray<AdminArm> = [
  { name: 'in-process', makeApp: inProcessApp },
  { name: 'shared-worker', makeApp: sharedWorkerApp },
];

function captureSyncOutcome(action: () => unknown): string {
  try {
    const result = action() as { catch?: (onReject: () => void) => void } | undefined;
    if (result !== undefined && typeof result.catch === 'function') {
      result.catch(() => undefined);
    }
    return 'OK';
  } catch (err) {
    if (err instanceof Error) {
      return `${err.name}: ${err.message}`;
    }
    return String(err);
  }
}

afterEach(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app)));
  await Promise.all(getProdApps().map((app) => deleteProdApp(app)));
});

describe('offline firebase-admin differential parity for #1927 and #1930', () => {
  test('#1927: ref(), child(), and DataSnapshot.child()/hasChild() path validation matches firebase-admin across both arms', async () => {
    const prodApp = initializeProdApp(
      { projectId: 'demo-diff-path', databaseURL: 'https://demo-diff-path-default-rtdb.firebaseio.com' },
      `prod-path-${++seq}`,
    );
    const prodDb = getProdDatabase(prodApp);
    prodDb.goOffline();
    void prodDb.ref('snapRoot').set({ '0': 'zero', a: 1 }).catch(() => undefined);
    let prodSnap: ReturnType<typeof prodDb.ref> extends never ? never : unknown = null;
    prodDb.ref('snapRoot').once('value', (snap) => {
      prodSnap = snap;
    });
    await new Promise((resolve) => setTimeout(resolve, 15));

    const runPathMatrix = (
      db: { ref: Database['ref']; refFromURL: Database['refFromURL'] },
      snap: { child: (p: string) => unknown; hasChild: (p: string) => boolean },
    ): Record<string, string> => {
      const origin = db.ref().toString();
      return {
        refRoot: captureSyncOutcome(() => db.ref()),
        refSlash: captureSyncOutcome(() => db.ref('/')),
        refEmpty: captureSyncOutcome(() => db.ref('')),
        refNumber: captureSyncOutcome(() => db.ref(0 as never)),
        refNull: captureSyncOutcome(() => db.ref(null as never)),
        refDot: captureSyncOutcome(() => db.ref('a.b')),
        refHash: captureSyncOutcome(() => db.ref('a#b')),
        refDollar: captureSyncOutcome(() => db.ref('a$b')),
        refOpenBracket: captureSyncOutcome(() => db.ref('a[b')),
        refCloseBracket: captureSyncOutcome(() => db.ref('a]b')),
        refNullChar: captureSyncOutcome(() => db.ref('a\u0000b')),
        refDelChar: captureSyncOutcome(() => db.ref('a\u007fb')),
        refInfoConnected: captureSyncOutcome(() => db.ref('.info/connected')),
        refLeadingSlashInfo: captureSyncOutcome(() => db.ref('/.info/connected')),
        refInfoDot: captureSyncOutcome(() => db.ref('.info/a.b')),
        refNestedInfo: captureSyncOutcome(() => db.ref('a/.info')),
        childEmpty: captureSyncOutcome(() => db.ref().child('')),
        childSlash: captureSyncOutcome(() => db.ref().child('/')),
        childDot: captureSyncOutcome(() => db.ref().child('a.b')),
        childHash: captureSyncOutcome(() => db.ref().child('a#b')),
        childDollar: captureSyncOutcome(() => db.ref().child('a$b')),
        childOpenBracket: captureSyncOutcome(() => db.ref().child('a[b')),
        childCloseBracket: captureSyncOutcome(() => db.ref().child('a]b')),
        childInteger: captureSyncOutcome(() => db.ref().child(0 as never)),
        childDecimal: captureSyncOutcome(() => db.ref().child(1.5 as never)),
        childNull: captureSyncOutcome(() => db.ref().child(null as never)),
        childUndefined: captureSyncOutcome(() => db.ref().child(undefined as never)),
        rootChildInfo: captureSyncOutcome(() => db.ref().child('.info/connected')),
        nonRootChildInfo: captureSyncOutcome(() => db.ref('a').child('.info/connected')),
        infoChildConnected: captureSyncOutcome(() => db.ref('.info').child('connected')),
        refFromUrlDot: captureSyncOutcome(() => db.refFromURL(`${origin}a.b`)),
        refFromUrlInfo: captureSyncOutcome(() => db.refFromURL(`${origin}.info/connected`)),
        snapChildEmpty: captureSyncOutcome(() => snap.child('')),
        snapChildDot: captureSyncOutcome(() => snap.child('a.b')),
        snapChildInfo: captureSyncOutcome(() => snap.child('.info')),
        snapChildInteger: captureSyncOutcome(() => snap.child(0 as never)),
        snapHasChildEmpty: captureSyncOutcome(() => snap.hasChild('')),
        snapHasChildDot: captureSyncOutcome(() => snap.hasChild('a.b')),
        snapHasChildInfo: captureSyncOutcome(() => snap.hasChild('.info')),
        snapHasChildInteger: captureSyncOutcome(() => snap.hasChild(0 as never)),
      };
    };

    const oracle = runPathMatrix(
      prodDb as unknown as { ref: Database['ref']; refFromURL: Database['refFromURL'] },
      prodSnap as { child: (p: string) => unknown; hasChild: (p: string) => boolean },
    );
    expect(oracle.refDot).toContain('path argument was an invalid path = "a.b"');
    expect(oracle.childEmpty).toContain('path argument was an invalid path = ""');
    expect(oracle.childInteger).toBe('OK');
    expect(oracle.rootChildInfo).toBe('OK');
    expect(oracle.nonRootChildInfo).toContain('path argument was an invalid path = ".info/connected"');

    for (const arm of ARMS) {
      const app = arm.makeApp();
      const db = getDatabase(app);
      await db.ref('snapRoot').set({ '0': 'zero', a: 1 });
      const snap = await db.ref('snapRoot').get();
      expect(runPathMatrix(db, snap)).toEqual(oracle);
      expect(db.ref('snapRoot').child(0 as never).path).toBe('/snapRoot/0');
      expect(snap.child(0 as never).val()).toBe('zero');
    }
  });

  test('#1930: isEqual compares database target and rejects non-Query inputs matching firebase-admin', () => {
    const prodApp1 = initializeProdApp(
      { projectId: 'demo-diff-eq', databaseURL: 'https://demo-diff-eq-default-rtdb.firebaseio.com' },
      `prod-eq-1-${++seq}`,
    );
    const prodApp2 = initializeProdApp(
      { projectId: 'demo-diff-eq', databaseURL: 'https://demo-diff-eq-default-rtdb.firebaseio.com' },
      `prod-eq-2-${++seq}`,
    );
    const prodDb1 = getProdDatabase(prodApp1);
    const prodDb2 = getProdDatabase(prodApp2);
    const prodShard = getProdDatabaseWithUrl('https://demo-diff-eq-shard.firebaseio.com', prodApp1);
    prodDb1.goOffline();
    prodDb2.goOffline();
    prodShard.goOffline();

    const runEqualityMatrix = (
      db1: { ref: Database['ref'] },
      db2: { ref: Database['ref'] },
      shardDb: { ref: Database['ref'] },
    ): Record<string, string | boolean> => {
      const checkBool = (fn: () => boolean): string | boolean => {
        try {
          return fn();
        } catch (err) {
          if (err instanceof Error) {
            return `THROW: ${err.message}`;
          }
          return `THROW: ${String(err)}`;
        }
      };
      return {
        samePath: checkBool(() => db1.ref('a').isEqual(db1.ref('a'))),
        slashedPath: checkBool(() => db1.ref('a').isEqual(db1.ref('/a/'))),
        rootAlias: checkBool(() => db1.ref().isEqual(db1.ref('/'))),
        differentApp: checkBool(() => db1.ref('a').isEqual(db2.ref('a'))),
        differentShard: checkBool(() => db1.ref('a').isEqual(shardDb.ref('a'))),
        querySame: checkBool(() => db1.ref('a').orderByKey().isEqual(db1.ref('a').orderByKey())),
        queryDifferentApp: checkBool(() => db1.ref('a').orderByKey().isEqual(db2.ref('a').orderByKey())),
        refVsQuery: checkBool(() => db1.ref('a').isEqual(db1.ref('a').orderByKey())),
        nullArg: checkBool(() => db1.ref('a').isEqual(null)),
        undefinedArg: checkBool(() => db1.ref('a').isEqual(undefined as never)),
        plainPathObj: checkBool(() => db1.ref('a').isEqual({ path: '/a' } as never)),
        queryPlainObj: checkBool(() => db1.ref('a').orderByKey().isEqual({ path: '/a' } as never)),
      };
    };

    const oracle = runEqualityMatrix(
      prodDb1 as unknown as { ref: Database['ref'] },
      prodDb2 as unknown as { ref: Database['ref'] },
      prodShard as unknown as { ref: Database['ref'] },
    );
    expect(oracle.differentApp).toBe(false);
    expect(oracle.differentShard).toBe(false);
    expect(oracle.plainPathObj).toBe(
      'THROW: Query.isEqual failed: First argument must be an instance of firebase.database.Query.',
    );

    for (const arm of ARMS) {
      const app1 = arm.makeApp();
      const app2 = initializeApp(
        {
          sandbox: app1.sandbox,
          projectId: 'demo-diff-eq',
          databaseURL: 'https://demo-diff-eq-default-rtdb.firebaseio.com',
        },
        `pyric-eq-peer-${arm.name}-${++seq}`,
      );
      const db1 = getDatabase(app1);
      const db2 = getDatabase(app2);
      const shardDb = getDatabaseWithUrl('https://demo-diff-eq-shard.firebaseio.com', app1);
      expect(runEqualityMatrix(db1, db2, shardDb)).toEqual(oracle);
    }
  });
});

describe.each(ARMS)('pyric-admin/database divergence closures ($name)', ({ name, makeApp }) => {
  test('#1928: set, update, remove, push, setPriority, setWithPriority, and once invoke callbacks asynchronously', async () => {
    const app = makeApp();
    const db = getDatabase(app);

    const setOrder: string[] = [];
    const setPromise = db.ref('cb/item').set({ count: 1 }, (err) => {
      setOrder.push(`cb:${String(err)}`);
    });
    setOrder.push('after-call');
    await setPromise;
    setOrder.push('after-await');
    expect(setOrder).toEqual(['after-call', 'cb:null', 'after-await']);

    const updateOrder: string[] = [];
    const updatePromise = db.ref('cb/item').update({ extra: true }, (err) => {
      updateOrder.push(`cb:${String(err)}`);
    });
    updateOrder.push('after-call');
    await updatePromise;
    updateOrder.push('after-await');
    expect(updateOrder).toEqual(['after-call', 'cb:null', 'after-await']);

    // Direct #1928/#1929 repro: callback reads `r.key` on the returned ThenableReference.
    const pushOrder: string[] = [];
    let observedPushKey: string | null = null;
    const pushedRef = db.ref('cb/list').push(1, (err) => {
      pushOrder.push(`cb:${String(err)}`);
      observedPushKey = pushedRef.key;
    });
    pushOrder.push('after-call');
    const resolvedPushRef = await pushedRef;
    pushOrder.push('after-await');
    expect(pushOrder).toEqual(['after-call', 'cb:null', 'after-await']);
    expect(observedPushKey).toBe(pushedRef.key);
    expect(resolvedPushRef.key).toBe(pushedRef.key);
    expect((await resolvedPushRef.get()).val()).toBe(1);

    const emptyPushOrder: string[] = [];
    let observedEmptyPushKey: string | null = null;
    const emptyPushRef = db.ref('cb/list').push(undefined, (err) => {
      emptyPushOrder.push(`cb:${String(err)}`);
      observedEmptyPushKey = emptyPushRef.key;
    });
    emptyPushOrder.push('after-call');
    await emptyPushRef;
    emptyPushOrder.push('after-await');
    expect(emptyPushOrder).toEqual(['after-call', 'cb:null', 'after-await']);
    expect(observedEmptyPushKey).toBe(emptyPushRef.key);

    const setWithPrioOrder: string[] = [];
    const swpPromise = db.ref('cb/prio').setWithPriority('v', 1, (err) => {
      setWithPrioOrder.push(`cb:${String(err)}`);
    });
    setWithPrioOrder.push('after-call');
    await swpPromise;
    setWithPrioOrder.push('after-await');
    expect(setWithPrioOrder).toEqual(['after-call', 'cb:null', 'after-await']);

    const setPrioOrder: string[] = [];
    const spPromise = db.ref('cb/prio').setPriority(2, (err) => {
      setPrioOrder.push(`cb:${String(err)}`);
    });
    setPrioOrder.push('after-call');
    await spPromise;
    setPrioOrder.push('after-await');
    expect(setPrioOrder).toEqual(['after-call', 'cb:null', 'after-await']);

    const onceValueOrder: string[] = [];
    const onceValuePromise = db.ref('cb/item/count').once('value', (snap) => {
      onceValueOrder.push(`cb:${String(snap.val())}`);
    });
    onceValueOrder.push('after-call');
    const onceValueSnap = await onceValuePromise;
    onceValueOrder.push('after-await');
    expect(onceValueSnap.val()).toBe(1);
    expect(onceValueOrder).toEqual(['after-call', 'cb:1', 'after-await']);

    const onceChildOrder: string[] = [];
    const onceChildPromise = db.ref('cb/item').once('child_added', (snap) => {
      onceChildOrder.push(`cb:${String(snap.key)}`);
    });
    onceChildOrder.push('after-call');
    await onceChildPromise;
    onceChildOrder.push('after-await');
    expect(onceChildOrder).toEqual(['after-call', 'cb:count', 'after-await']);

    const onceInfoOrder: string[] = [];
    const onceInfoPromise = db.ref('/.info/connected').once('value', (snap) => {
      onceInfoOrder.push(`cb:${String(snap.val())}`);
    });
    onceInfoOrder.push('after-call');
    await onceInfoPromise;
    onceInfoOrder.push('after-await');
    expect(onceInfoOrder).toEqual(['after-call', 'cb:true', 'after-await']);

    const removeOrder: string[] = [];
    const removePromise = db.ref('cb/item').remove((err) => {
      removeOrder.push(`cb:${String(err)}`);
    });
    removeOrder.push('after-call');
    await removePromise;
    removeOrder.push('after-await');
    expect(removeOrder).toEqual(['after-call', 'cb:null', 'after-await']);

    // Error callbacks on a deleted app also fire asynchronously after returning.
    const retainedRef = db.ref('cb/deleted');
    await deleteApp(app);

    const errSetOrder: string[] = [];
    const errSetPromise = retainedRef.set('x', (err) => {
      errSetOrder.push(`cb:${err === null ? 'null' : 'error'}`);
    });
    errSetOrder.push('after-call');
    await expect(errSetPromise).rejects.toMatchObject({ code: 'app/app-deleted' });
    errSetOrder.push('after-await');
    expect(errSetOrder).toEqual(['after-call', 'cb:error', 'after-await']);

    const errOnceOrder: string[] = [];
    const errOncePromise = retainedRef.once(
      'value',
      () => {
        errOnceOrder.push('unexpected-success');
      },
      (err) => {
        errOnceOrder.push(`fail:${err.message.length > 0 ? 'error' : 'empty'}`);
      },
    );
    errOnceOrder.push('after-call');
    await expect(errOncePromise).rejects.toMatchObject({ code: 'app/app-deleted' });
    errOnceOrder.push('after-await');
    expect(errOnceOrder).toEqual(['after-call', 'fail:error', 'after-await']);
  });

  test('#1931: /.info/connected and /.info/serverTimeOffset resolve true and 0 even under deny-all auth override', async () => {
    const app = makeApp();
    const db = getDatabase(app);
    await db.setRules({ rules: { '.read': false, '.write': false } });

    const anonApp = initializeApp(
      {
        sandbox: app.sandbox,
        projectId: 'demo-info-override',
        databaseAuthVariableOverride: null,
      },
      `info-anon-${name}-${++seq}`,
    );
    const anonDb = getDatabase(anonApp);

    for (const targetDb of [db, anonDb]) {
      const connSnap = await targetDb.ref('/.info/connected').once('value');
      expect([connSnap.key, connSnap.exists(), connSnap.val()]).toEqual(['connected', true, true]);

      const childConnSnap = await targetDb.ref().child('.info/connected').once('value');
      expect([childConnSnap.key, childConnSnap.exists(), childConnSnap.val()]).toEqual([
        'connected',
        true,
        true,
      ]);

      const offsetSnap = await targetDb.ref('/.info/serverTimeOffset').once('value');
      expect([offsetSnap.key, offsetSnap.exists(), offsetSnap.val()]).toEqual([
        'serverTimeOffset',
        true,
        0,
      ]);

      const infoRootSnap = await targetDb.ref('.info').once('value');
      expect(infoRootSnap.val()).toEqual({ connected: true, serverTimeOffset: 0 });

      const unknownSnap = await targetDb.ref('/.info/unknown').once('value');
      expect([unknownSnap.exists(), unknownSnap.val()]).toEqual([false, null]);

      await expect(targetDb.ref('/.info/connected').get()).rejects.toThrow('Invalid token in path');
      await expect(targetDb.ref('/.info/serverTimeOffset').get()).rejects.toThrow(
        'Invalid token in path',
      );
    }

    db.goOffline();
    expect((await db.ref('/.info/connected').once('value')).val()).toBe(false);
    expect((await db.ref('/.info/serverTimeOffset').once('value')).val()).toBe(0);
    db.goOnline();
    expect((await db.ref('/.info/connected').once('value')).val()).toBe(true);
  });

  test('#1932: accepts primitive values at the database root across set, priority, transaction, and onDisconnect', async () => {
    const app = makeApp();
    const db = getDatabase(app);

    for (const primitive of ['hello', '', 42, 0, true, false]) {
      await db.ref().set(primitive);
      const getSnap = await db.ref().get();
      const onceSnap = await db.ref('/').once('value');
      expect([getSnap.key, getSnap.exists(), getSnap.val(), getSnap.numChildren(), getSnap.hasChildren()]).toEqual([
        null,
        true,
        primitive,
        0,
        false,
      ]);
      expect(onceSnap.val()).toBe(primitive);
    }

    await db.ref().setWithPriority('hello-prio', 5);
    const prioSnap = await db.ref().get();
    expect(prioSnap.val()).toBe('hello-prio');
    expect(prioSnap.getPriority()).toBe(5);
    expect(prioSnap.exportVal()).toEqual({ '.value': 'hello-prio', '.priority': 5 });

    await db.ref().set(10);
    await db.ref().set(ServerValue.increment(5));
    expect((await db.ref().get()).val()).toBe(15);

    const tx = await db.ref().transaction((current) => {
      if (typeof current === 'number') {
        return current + 1;
      }
      return 1;
    });
    expect(tx.committed).toBe(true);
    expect(tx.snapshot.val()).toBe(16);

    await db.ref().onDisconnect().set('offline-root');
    db.goOffline();
    db.goOnline();
    expect((await db.ref().get()).val()).toBe('offline-root');

    await db.ref('childKey').set(1);
    expect((await db.ref().get()).val()).toEqual({ childKey: 1 });

    await db.ref().set(null);
    const clearedSnap = await db.ref().get();
    expect([clearedSnap.exists(), clearedSnap.val()]).toEqual([false, null]);
  });
});

describe('#1935 admin side: AdminPathCache preserves primitive leaves on sub-path null writes', () => {
  test('leaves nested and root primitive leaves intact when recording null below them', () => {
    const cache = new AdminPathCache();
    cache.recordValue('/r', { n: 'keep', m: 1 });

    cache.recordValue('/r/n/x', null);
    expect(cache.read('/r')).toEqual({ n: 'keep', m: 1 });
    expect(cache.read('/r/n')).toBe('keep');
    expect(cache.read('/r/n/x')).toBeNull();

    cache.recordValue('/r/n/x/y/z', null);
    expect(cache.read('/r')).toEqual({ n: 'keep', m: 1 });

    cache.recordPatch('/r', { 'n/x': null });
    expect(cache.read('/r')).toEqual({ n: 'keep', m: 1 });

    cache.recordValue('/r/toString/x', null);
    expect(cache.read('/r')).toEqual({ n: 'keep', m: 1 });

    // Writing a non-null descendant still replaces the primitive leaf.
    cache.recordValue('/r/n/x', 42);
    expect(cache.read('/r')).toEqual({ n: { x: 42 }, m: 1 });

    // Removing the primitive leaf's own path still deletes it.
    cache.recordValue('/r/n', 'keep');
    cache.recordValue('/r/n', null);
    expect(cache.read('/r')).toEqual({ m: 1 });

    // Removing below a root primitive leaves the root primitive intact.
    cache.recordValue('/', 'hello-root');
    cache.recordValue('/sub/x', null);
    expect(cache.read('/')).toBe('hello-root');
  });
});
