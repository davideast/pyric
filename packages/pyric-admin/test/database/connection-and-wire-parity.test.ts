/**
 * Dual-arm backend-parity matrix (`in-process` vs `shared-worker`) verifying
 * wire query limit fidelity, `deleteApp` disconnect draining and handle
 * tombstoning, multi-app connection isolation, and `.info/connected`
 * transitions across `goOffline()` / `goOnline()`.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import {
  getDatabase as getModularDatabase,
  sandbox as databaseSandbox,
} from 'pyric/database';
import { initializeSandbox, type Sandbox } from 'pyric/sandbox';
import {
  deleteApp,
  getApps,
  initializeApp,
  type PyricAdminApp,
} from '../../src/app/index.js';
import { getDatabase } from '../../src/database/index.js';
import { sharedWorkerArm } from './arms.js';

const tick = (ms = 20): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

let seq = 0;

interface ParityArm {
  readonly app: PyricAdminApp;
  readonly host: Sandbox;
  readonly sharedSandbox: Sandbox;
  readonly inspectHostState?: () => { readonly queuedScopes: number; readonly offlineScopes: number };
  readonly simulatePortClose?: () => Promise<void>;
}

const ARMS: ReadonlyArray<{ name: string; make: () => ParityArm }> = [
  {
    name: 'in-process',
    make: () => {
      const host = initializeSandbox({ projectId: 'demo-org' });
      databaseSandbox.setDefaultPolicy(getModularDatabase(host), 'allow');
      const app = initializeApp(
        {
          sandbox: host,
          projectId: 'demo-org',
          databaseURL: 'https://demo-org-default-rtdb.firebaseio.com',
        },
        `wire-parity-local-${++seq}`,
      );
      return { app, host, sharedSandbox: host };
    },
  },
  {
    name: 'shared-worker',
    make: () => {
      const { app: baseApp, host, inspectHostState, simulatePortClose } = sharedWorkerArm();
      const sharedSandbox = baseApp.sandbox;
      const app = initializeApp(
        {
          sandbox: sharedSandbox,
          projectId: 'demo-org',
          databaseURL: 'https://demo-org-default-rtdb.firebaseio.com',
        },
        `wire-parity-remote-${++seq}`,
      );
      return { app, host, sharedSandbox, inspectHostState, simulatePortClose };
    },
  },
];

afterEach(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app)));
});

describe.each(ARMS)('pyric-admin/database dual-arm connection & wire parity ($name)', ({ make }) => {
  test('preserves limitToFirst(+Infinity) and limitToLast(+Infinity) as constrained queries on scalar leaves across get, once, and on', async () => {
    const { app } = make();
    const db = getDatabase(app);
    await db.ref('orgs/o1/status').set('ready');

    const firstGet = await db.ref('orgs/o1/status').limitToFirst(Number.POSITIVE_INFINITY).get();
    const lastGet = await db.ref('orgs/o1/status').limitToLast(Number.POSITIVE_INFINITY).get();
    const firstOnce = await db.ref('orgs/o1/status').limitToFirst(Number.POSITIVE_INFINITY).once('value');
    const lastOnce = await db.ref('orgs/o1/status').limitToLast(Number.POSITIVE_INFINITY).once('value');

    const observedValues: Array<{ exists: boolean; val: unknown }> = [];
    const onTarget = db.ref('orgs/o1/status').limitToFirst(Number.POSITIVE_INFINITY);
    const cb = onTarget.on('value', (snap) => {
      observedValues.push({ exists: snap.exists(), val: snap.val() });
    });
    await tick();
    onTarget.off('value', cb);

    expect([firstGet.exists(), firstGet.val()]).toEqual([false, null]);
    expect([lastGet.exists(), lastGet.val()]).toEqual([false, null]);
    expect([firstOnce.exists(), firstOnce.val()]).toEqual([false, null]);
    expect([lastOnce.exists(), lastOnce.val()]).toEqual([false, null]);
    expect(observedValues).toEqual([{ exists: false, val: null }]);
  });

  test('isolates onDisconnect queues, cancel(), and goOffline() across multiple PyricAdminApp instances sharing one sandbox', async () => {
    const { app: appA, sharedSandbox } = make();
    const appB = initializeApp(
      {
        sandbox: sharedSandbox,
        projectId: 'demo-org',
        databaseURL: 'https://demo-org-default-rtdb.firebaseio.com',
      },
      `wire-parity-peer-${++seq}`,
    );
    const dbA = getDatabase(appA);
    const dbB = getDatabase(appB);

    await dbA.ref('teams').set({ a: 'online', b: 'online', shared: 'live' });
    await dbA.ref('teams/a').onDisconnect().set('offline');
    await dbA.ref('teams/shared').onDisconnect().set('from-a');
    await dbB.ref('teams/b').onDisconnect().set('offline');

    // Cancelling on dbB must NOT cancel dbA's pending onDisconnect at the same path.
    await dbB.ref('teams/shared').onDisconnect().cancel();

    // Taking dbA offline drains only dbA's queue; dbB stays online with its queue intact.
    dbA.goOffline();
    await tick();
    expect((await dbB.ref('teams').get()).val()).toEqual({
      a: 'offline',
      b: 'online',
      shared: 'from-a',
    });

    // While dbA remains offline, taking dbB offline must still drain dbB's queue.
    dbB.goOffline();
    await tick();
    expect((await dbB.ref('teams').get()).val()).toEqual({
      a: 'offline',
      b: 'offline',
      shared: 'from-a',
    });

    dbA.goOnline();
    dbB.goOnline();
  });

  test('transitions .info/connected and .info across goOffline() and goOnline(), resolves offline once("value") as false, and isolates per app', async () => {
    const { app: appA, sharedSandbox } = make();
    const appB = initializeApp(
      {
        sandbox: sharedSandbox,
        projectId: 'demo-org',
        databaseURL: 'https://demo-org-default-rtdb.firebaseio.com',
      },
      `wire-parity-info-peer-${++seq}`,
    );
    const dbA = getDatabase(appA);
    const dbB = getDatabase(appB);

    const transitionsA: unknown[] = [];
    const transitionsB: unknown[] = [];
    const rootInfoChanged: Array<[string | null, unknown]> = [];
    dbA.ref('.info/connected').on('value', (snap) => transitionsA.push(snap.val()));
    dbB.ref('.info/connected').on('value', (snap) => transitionsB.push(snap.val()));
    dbA.ref('.info').on('child_changed', (snap) => rootInfoChanged.push([snap.key, snap.val()]));
    await tick();

    dbA.goOffline();
    await tick();
    const offlineOnceA = (await dbA.ref('.info/connected').once('value')).val();
    const onlineOnceB = (await dbB.ref('.info/connected').once('value')).val();

    dbA.goOnline();
    await tick();
    const onlineOnceA = (await dbA.ref('.info/connected').once('value')).val();

    dbA.ref('.info/connected').off();
    dbB.ref('.info/connected').off();
    dbA.ref('.info').off();

    expect(transitionsA).toEqual([true, false, true]);
    expect(transitionsB).toEqual([true]);
    expect(offlineOnceA).toBe(false);
    expect(onlineOnceB).toBe(true);
    expect(onlineOnceA).toBe(true);
    expect(rootInfoChanged).toEqual([
      ['connected', false],
      ['connected', true],
    ]);
  });

  test('deleteApp(app) drains pending onDisconnect operations across both arms, tombstones Database and Reference/Query/OnDisconnect handles, and fires zero post-delete deliveries', async () => {
    const { app: workerApp, host, sharedSandbox, simulatePortClose } = make();
    const observerApp = initializeApp(
      {
        sandbox: sharedSandbox,
        projectId: 'demo-org',
        databaseURL: 'https://demo-org-default-rtdb.firebaseio.com',
      },
      `wire-parity-observer-${++seq}`,
    );
    const workerDb = getDatabase(workerApp);
    const observerDb = getDatabase(observerApp);
    const preDeleteRef = workerDb.ref('users/u1/status');
    const preDeleteQuery = workerDb.ref('users/u1').orderByKey();
    const preDeleteDisconnect = preDeleteRef.onDisconnect();

    await workerDb.ref('users/u1/status').set('online');
    await observerDb.ref('users/u2/status').set('online');
    await workerDb.ref('users/u1/status').onDisconnect().set('offline');
    await observerDb.ref('users/u2/status').onDisconnect().set('offline');

    await deleteApp(workerApp);

    // 1. workerApp's pending onDisconnect drained before deleteApp resolved; observerApp's stayed queued.
    expect((await observerDb.ref('users/u1/status').get()).val()).toBe('offline');
    expect((await observerDb.ref('users/u2/status').get()).val()).toBe('online');

    // 2. Pre-existing Database handle methods throw the exact firebase-admin deleted-database errors.
    expect(() => workerDb.ref('users/u1/status')).toThrow(
      'FIREBASE FATAL ERROR: Cannot call ref on a deleted database. ',
    );
    expect(() =>
      workerDb.refFromURL('https://demo-org-default-rtdb.firebaseio.com/users/u1/status'),
    ).toThrow('FIREBASE FATAL ERROR: Cannot call refFromURL on a deleted database. ');
    expect(() => workerDb.goOffline()).toThrow(
      'FIREBASE FATAL ERROR: Cannot call goOffline on a deleted database. ',
    );
    expect(() => workerDb.goOnline()).toThrow(
      'FIREBASE FATAL ERROR: Cannot call goOnline on a deleted database. ',
    );

    // 3. Synchronous invalid-argument checks still run first on retained handles.
    expect(() => preDeleteRef.set('stale', 'not-a-fn' as never)).toThrow(
      'Reference.set failed: onComplete argument must be a valid function.',
    );

    // 4. Retained Reference, Query, and OnDisconnect handles reject I/O with app/app-deleted
    //    without mutating state, firing initial snapshots, or queueing post-delete disconnects.
    const postDeleteLeaks: unknown[] = [];
    expect(() =>
      preDeleteRef.on('value', (snap) => {
        postDeleteLeaks.push(snap.val());
      }),
    ).toThrow(/has already been deleted/);
    expect(postDeleteLeaks).toEqual([]);

    await expect(preDeleteRef.get()).rejects.toMatchObject({ code: 'app/app-deleted' });
    await expect(preDeleteQuery.get()).rejects.toMatchObject({ code: 'app/app-deleted' });
    await expect(preDeleteRef.once('value', (snap) => postDeleteLeaks.push(snap.val()))).rejects.toMatchObject({
      code: 'app/app-deleted',
    });
    await expect(preDeleteRef.set('stale-set')).rejects.toMatchObject({ code: 'app/app-deleted' });
    await expect(preDeleteRef.parent!.update({ status: 'stale-update' })).rejects.toMatchObject({
      code: 'app/app-deleted',
    });
    await expect(preDeleteRef.remove()).rejects.toMatchObject({ code: 'app/app-deleted' });
    await expect(Promise.resolve(preDeleteRef.push('stale-push'))).rejects.toMatchObject({
      code: 'app/app-deleted',
    });
    await expect(preDeleteDisconnect.set('ghost-disconnect')).rejects.toMatchObject({
      code: 'app/app-deleted',
    });
    await expect(preDeleteDisconnect.setWithPriority('ghost', 1)).rejects.toMatchObject({
      code: 'app/app-deleted',
    });
    await expect(preDeleteDisconnect.update({ nested: 'ghost' })).rejects.toMatchObject({
      code: 'app/app-deleted',
    });
    await expect(preDeleteDisconnect.remove()).rejects.toMatchObject({ code: 'app/app-deleted' });
    await expect(preDeleteDisconnect.cancel()).rejects.toMatchObject({ code: 'app/app-deleted' });

    await observerDb.ref('users/u1/status').set('updated-after-delete');
    await tick();
    expect(postDeleteLeaks).toEqual([]);
    expect((await observerDb.ref('users/u1/status').get()).val()).toBe('updated-after-delete');

    // Cancel observerApp's own disconnect before simulating port close to verify zero ghost ops from preDeleteDisconnect.
    await observerDb.ref('users/u2/status').onDisconnect().cancel();
    if (simulatePortClose !== undefined) {
      await simulatePortClose();
      const hostVerifyApp = initializeApp(
        {
          sandbox: host,
          projectId: 'demo-org',
          databaseURL: 'https://demo-org-default-rtdb.firebaseio.com',
        },
        `wire-parity-host-verify-${++seq}`,
      );
      expect((await getDatabase(hostVerifyApp).ref('users/u1/status').get()).val()).toBe(
        'updated-after-delete',
      );
    }
  });

  test('drains offline-queued onDisconnect writes on deleteApp without leaving ghost ops on port close, and keeps host per-app connection state bounded across cycles', async () => {
    const { app: initialApp, host, sharedSandbox, inspectHostState, simulatePortClose } = make();
    await deleteApp(initialApp);

    // 1. Repeated initializeApp / deleteApp cycles across goOffline, queued onDisconnect, and cancel must not grow host state.
    for (let cycle = 0; cycle < 8; cycle++) {
      const cycleApp = initializeApp(
        {
          sandbox: sharedSandbox,
          projectId: 'demo-org',
          databaseURL: 'https://demo-org-default-rtdb.firebaseio.com',
        },
        `wire-parity-cycle-${cycle}-${++seq}`,
      );
      const cycleDb = getDatabase(cycleApp);
      await cycleDb.ref(`orgs/c${cycle}/state`).set('active');
      if (cycle % 3 === 0) {
        // Offline -> queue onDisconnect -> deleteApp while still offline!
        cycleDb.goOffline();
        await cycleDb.ref(`orgs/c${cycle}/state`).onDisconnect().set('drained-from-offline');
      } else if (cycle % 3 === 1) {
        // Offline only (no onDisconnect queued) -> deleteApp!
        cycleDb.goOffline();
      } else {
        // Cancel without prior queue, then queue + cancel -> deleteApp!
        await cycleDb.ref(`orgs/c${cycle}/unused`).onDisconnect().cancel();
        await cycleDb.ref(`orgs/c${cycle}/state`).onDisconnect().set('cancelled');
        await cycleDb.ref(`orgs/c${cycle}/state`).onDisconnect().cancel();
      }
      await deleteApp(cycleApp);

      if (inspectHostState !== undefined) {
        expect(inspectHostState()).toEqual({ queuedScopes: 0, offlineScopes: 0 });
      }
    }

    // 2. Verify cycle 0's offline-queued onDisconnect drained during deleteApp, and overwrite it to verify zero ghost op on port close.
    const checkApp = initializeApp(
      {
        sandbox: host,
        projectId: 'demo-org',
        databaseURL: 'https://demo-org-default-rtdb.firebaseio.com',
      },
      `wire-parity-cycle-check-${++seq}`,
    );
    const checkDb = getDatabase(checkApp);
    expect((await checkDb.ref('orgs/c0/state').get()).val()).toBe('drained-from-offline');
    expect((await checkDb.ref('orgs/c2/state').get()).val()).toBe('active');

    await checkDb.ref('orgs/c0/state').set('clean-after-delete');
    if (simulatePortClose !== undefined) {
      await simulatePortClose();
      expect((await checkDb.ref('orgs/c0/state').get()).val()).toBe('clean-after-delete');
    }
  });
});
