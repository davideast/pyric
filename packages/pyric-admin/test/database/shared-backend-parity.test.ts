import { afterEach, describe, expect, it } from 'bun:test';
import { captureFullState, discard, fork, initializeSandbox } from 'pyric/sandbox';
import { setRules as setDatabaseRules } from 'pyric/sandbox/database';
import {
  get as clientGet,
  getDatabase as getClientDatabase,
  onValue as clientOnValue,
  ref as clientRef,
  remove as clientRemove,
  set as clientSet,
  setPriority as clientSetPriority,
  setWithPriority as clientSetWithPriority,
  update as clientUpdate,
} from 'pyric/database';
import { deleteApp, getApps, initializeApp } from '../../src/app/index.js';
import { getDatabase, getDatabaseWithUrl, ServerValue } from '../../src/database/index.js';
import { sharedWorkerArm } from './arms.js';

afterEach(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app)));
});

describe('pyric-admin/database shared backend parity with pyric/database', () => {
  it('shares state, root.child(...) rule evaluation, and client listeners in-process just like remote', async () => {
    const rules = {
      rules: {
        orgs: {
          $orgId: {
            items: {
              '.read': 'auth != null && root.child("orgs").child($orgId).child("members").child(auth.uid).val() === true',
              '.write': 'auth != null && root.child("orgs").child($orgId).child("members").child(auth.uid).val() === true',
            },
          },
        },
      },
    };

    const localSandbox = initializeSandbox({ projectId: 'proj-1' });
    setDatabaseRules(localSandbox, rules);
    const localAdminApp = initializeApp({ sandbox: localSandbox, projectId: 'proj-1' }, 'local-admin');

    const { app: remoteAdminApp, host: remoteHost } = sharedWorkerArm();
    setDatabaseRules(remoteHost, rules);

    for (const { label, adminApp, hostSandbox } of [
      { label: 'in-process', adminApp: localAdminApp, hostSandbox: localSandbox },
      { label: 'remote', adminApp: remoteAdminApp, hostSandbox: remoteHost },
    ]) {
      const adminDb = getDatabase(adminApp);
      const clientDb = getClientDatabase(hostSandbox.withAuth({ uid: 'u1', token: {} }));

      await adminDb.ref('orgs/org-1/members/u1').set(true);
      await adminDb.ref('orgs/org-1/items/i1').set({ title: 'seeded-by-admin', count: 1 });

      const observed: unknown[] = [];
      const unsubscribe = clientOnValue(clientRef(clientDb, 'orgs/org-1/items/i1'), (snap) => {
        observed.push(snap.val());
      });

      try {
        const clientSnap = await clientGet(clientRef(clientDb, 'orgs/org-1/items/i1'));
        expect({ label, val: clientSnap.val() }).toEqual({
          label,
          val: { title: 'seeded-by-admin', count: 1 },
        });

        await adminDb.ref('orgs/org-1/items/i1').update({ count: 2 });
        expect({ label, latest: observed.at(-1) }).toEqual({
          label,
          latest: { title: 'seeded-by-admin', count: 2 },
        });

        await clientSet(clientRef(clientDb, 'orgs/org-1/items/i2'), { title: 'written-by-client' });
        await clientUpdate(clientRef(clientDb, 'orgs/org-1/items/i2'), { reviewed: true });
        expect((await adminDb.ref('orgs/org-1/items/i2').get()).val()).toEqual({
          title: 'written-by-client',
          reviewed: true,
        });
        expect((await adminDb.ref('orgs/org-1/items/i2').once('value')).val()).toEqual({
          title: 'written-by-client',
          reviewed: true,
        });

        const pushed = await adminDb.ref('orgs/org-1/items').push({ title: 'pushed-by-admin' });
        expect((await clientGet(clientRef(clientDb, `orgs/org-1/items/${pushed.key}`))).val()).toEqual({
          title: 'pushed-by-admin',
        });

        await clientRemove(clientRef(clientDb, 'orgs/org-1/items/i2'));
        expect((await adminDb.ref('orgs/org-1/items/i2').get()).exists()).toBe(false);

        await adminDb.ref('orgs/org-1/items/i1').remove();
        expect((await clientGet(clientRef(clientDb, 'orgs/org-1/items/i1'))).exists()).toBe(false);
      } finally {
        unsubscribe();
      }
    }
  });

  it('shares named database instances and participates in default-instance fork, snapshots, and reset', async () => {
    const shardUrl = 'https://proj-1-shard.firebaseio.com';
    const sandbox = initializeSandbox({ projectId: 'proj-1' });
    setDatabaseRules(sandbox, { rules: { '.read': true, '.write': true } });
    const adminApp = initializeApp({ sandbox, projectId: 'proj-1' }, 'shard-admin');

    const adminDefault = getDatabase(adminApp);
    const adminShard = getDatabaseWithUrl(shardUrl, adminApp);
    const clientShard = getClientDatabase(sandbox, shardUrl);
    setDatabaseRules(clientShard, { rules: { '.read': true, '.write': true } });

    await adminDefault.ref('items/d1').set({ defaultInstance: true });
    await adminShard.ref('items/s1').set({ shard: true });
    expect((await clientGet(clientRef(clientShard, 'items/s1'))).val()).toEqual({ shard: true });
    expect((await adminDefault.ref('items/s1').get()).exists()).toBe(false);

    const savedSnapshot = sandbox.snapshot();

    const branch = await fork(await captureFullState(sandbox));
    try {
      const forkAdminApp = initializeApp({ sandbox: branch.sandbox, projectId: 'proj-1' }, 'fork-admin');
      expect((await getDatabase(forkAdminApp).ref('items/d1').get()).val()).toEqual({ defaultInstance: true });

      await getDatabase(forkAdminApp).ref('items/d1').set({ defaultInstance: false });
      expect((await adminDefault.ref('items/d1').get()).val()).toEqual({ defaultInstance: true });
    } finally {
      discard(branch);
    }

    sandbox.reset();
    expect((await adminDefault.ref('items/d1').get()).exists()).toBe(false);
    expect((await adminShard.ref('items/s1').get()).exists()).toBe(false);

    sandbox.loadSnapshot(savedSnapshot);
    expect((await adminDefault.ref('items/d1').get()).val()).toEqual({ defaultInstance: true });
    expect((await adminShard.ref('items/s1').get()).val()).toEqual({ shard: true });
  });

  it('does not reset RTDB state or emit spurious null snapshots when sandbox.dispose() is called', async () => {
    const sandbox = initializeSandbox({ projectId: 'proj-1' });
    setDatabaseRules(sandbox, { rules: { '.read': true, '.write': true } });
    const adminApp = initializeApp({ sandbox, projectId: 'proj-1' }, 'dispose-admin');
    const adminDb = getDatabase(adminApp);
    const clientDb = getClientDatabase(sandbox);

    await adminDb.ref('items/keep').set({ label: 'preserved' });

    const observed: unknown[] = [];
    const unsubscribe = clientOnValue(clientRef(clientDb, 'items/keep'), (snap) => {
      observed.push(snap.val());
    });
    expect(observed).toEqual([{ label: 'preserved' }]);

    sandbox.dispose();

    expect(observed).toEqual([{ label: 'preserved' }]);
    expect((await adminDb.ref('items/keep').get()).val()).toEqual({ label: 'preserved' });
    unsubscribe();
  });

  it('preserves priorities in exportVal() and getPriority() across in-process and remote arms', async () => {
    const localSandbox = initializeSandbox({ projectId: 'proj-1' });
    setDatabaseRules(localSandbox, { rules: { '.read': true, '.write': true } });
    const localAdminApp = initializeApp({ sandbox: localSandbox, projectId: 'proj-1' }, 'prio-local');

    const { app: remoteAdminApp, host: remoteHost } = sharedWorkerArm();
    setDatabaseRules(remoteHost, { rules: { '.read': true, '.write': true } });

    for (const { label, adminApp, hostSandbox } of [
      { label: 'in-process', adminApp: localAdminApp, hostSandbox: localSandbox },
      { label: 'remote', adminApp: remoteAdminApp, hostSandbox: remoteHost },
    ]) {
      const adminDb = getDatabase(adminApp);
      const clientDb = getClientDatabase(hostSandbox);

      await clientSetWithPriority(clientRef(clientDb, 'ranked/leaf'), 'alpha', 10);
      await clientSetWithPriority(clientRef(clientDb, 'ranked/node'), { title: 'beta' }, 'high');
      await clientSetPriority(clientRef(clientDb, 'ranked/node/title'), 5);

      const leafGet = await adminDb.ref('ranked/leaf').get();
      expect({ label, val: leafGet.val(), prio: leafGet.getPriority(), exp: leafGet.exportVal() }).toEqual({
        label,
        val: 'alpha',
        prio: 10,
        exp: { '.value': 'alpha', '.priority': 10 },
      });

      const nodeOnce = await adminDb.ref('ranked/node').once('value');
      expect({ label, prio: nodeOnce.getPriority(), exp: nodeOnce.exportVal() }).toEqual({
        label,
        prio: 'high',
        exp: {
          '.priority': 'high',
          title: { '.value': 'beta', '.priority': 5 },
        },
      });

      const childSnap = nodeOnce.child('title');
      expect({ label, prio: childSnap.getPriority(), exp: childSnap.exportVal() }).toEqual({
        label,
        prio: 5,
        exp: { '.value': 'beta', '.priority': 5 },
      });

      const missingChild = nodeOnce.child('absent');
      expect(missingChild.exists()).toBe(false);
      expect(missingChild.getPriority()).toBeNull();
      expect(missingChild.exportVal()).toBeNull();
    }
  });

  it('resolves ServerValue sentinels in set, update, and push without emitting extra rtdb get events', async () => {
    const sandbox = initializeSandbox({ projectId: 'proj-1' });
    const adminApp = initializeApp({ sandbox, projectId: 'proj-1' }, 'no-extra-get-admin');
    const adminDb = getDatabase(adminApp);

    await adminDb.ref('counters/c1').set({
      hits: ServerValue.increment(3),
      updatedAt: ServerValue.TIMESTAMP,
    });
    await adminDb.ref('counters/c1').update({
      hits: ServerValue.increment(2),
    });
    const pushed = await adminDb.ref('counters/logs').push({
      seq: ServerValue.increment(1),
      at: ServerValue.TIMESTAMP,
    });

    const rtdbGets = sandbox
      .history()
      .filter(
        (ev) =>
          (ev as { service?: unknown }).service === 'rtdb' &&
          (ev as { kind?: unknown; op?: unknown }).op === 'get',
      );
    const anyReadEvents = sandbox
      .history()
      .filter(
        (ev) =>
          (ev as { service?: unknown }).service === 'rtdb' &&
          ((ev as { kind?: string }).kind?.includes('read') ||
            (ev as { method?: string }).method === 'get'),
      );
    expect(rtdbGets).toEqual([]);
    expect(anyReadEvents).toEqual([]);

    const c1 = (await adminDb.ref('counters/c1').get()).val() as { hits: number; updatedAt: number };
    expect(c1.hits).toBe(5);
    expect(typeof c1.updatedAt).toBe('number');
    const pushedVal = (await pushed.get()).val() as { seq: number; at: number };
    expect(pushedVal.seq).toBe(1);
    expect(typeof pushedVal.at).toBe('number');
  });
});
