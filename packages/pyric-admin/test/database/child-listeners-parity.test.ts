/**
 * Dual-arm parity tests for `pyric-admin/database` child listeners:
 * `child_added`, `child_changed`, `child_removed`, and `child_moved` across
 * `on`, `off`, and `once` on both `Reference` and `Query`, plus remote
 * reconnect delta suppression.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import {
  getDatabase as getModularDatabase,
  ref as clientRef,
  sandbox as databaseSandbox,
  setPriority as clientSetPriority,
  setWithPriority as clientSetWithPriority,
} from 'pyric/database';
import { getFirestore } from 'pyric/firestore';
import { initializeSandbox, type RemoteSandbox, type Sandbox } from 'pyric/sandbox';
import { createBridge } from '../../../cli/src/bridge/server/bridge.js';
import { createConsumerSession } from '../../../cli/src/bridge/server/peer.js';
import { WORKER_RELAY_CAPABILITY, type BridgeMessage } from '../../../cli/src/bridge/protocol.js';
import {
  createLazyRemoteSandbox,
  createRemoteSandboxCore,
  createRemoteSandboxHandle,
  type ReleasedOp,
} from '../../../cli/src/remote/index.js';
import { handleMessage, type HostCtx, type PortLike } from '../../../cli/src/serve/worker/host.js';
import type { InboundMessage, OutboundMessage } from '../../../cli/src/serve/worker/protocol.js';
import { deleteApp, getApps, initializeApp, type PyricAdminApp } from '../../src/app/index.js';
import {
  getDatabase,
  getDatabaseWithUrl,
  type DataSnapshot,
  type EventType,
} from '../../src/database/index.js';
import { sharedWorkerArm } from './arms.js';

interface ArmContext {
  readonly app: PyricAdminApp;
  readonly host: Sandbox;
}

const ARMS: ReadonlyArray<{ name: string; make: () => ArmContext }> = [
  {
    name: 'in-process',
    make: () => {
      const host = initializeSandbox();
      databaseSandbox.setDefaultPolicy(getModularDatabase(host), 'allow');
      const app = initializeApp(
        { sandbox: host, projectId: 'demo-child-listeners' },
        `child-listeners-local-${Math.random().toString(36).slice(2)}`,
      );
      return { app, host };
    },
  },
  { name: 'remote (SharedWorker bridge)', make: () => sharedWorkerArm() },
];

const tick = (ms = 25): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const overWire = <T>(frame: T): T => JSON.parse(JSON.stringify(frame)) as T;

function setRules(host: Sandbox, rules: { rules: Record<string, unknown> }, url?: string): void {
  databaseSandbox.setRules(getModularDatabase(host, url), rules);
}

function attachSandboxHostToBridge(sandbox: Sandbox, bridge: ReturnType<typeof createBridge>): () => void {
  const ctx: HostCtx = {
    db: getFirestore(sandbox),
    sandbox,
    instanceId: 'child-reconnect-host',
    subs: new Map(),
    flushPersistence: async () => {},
  };
  let generation = 0;
  let active = true;
  const tab: PortLike = {
    postMessage(raw: unknown) {
      if (!active) return;
      const msg = raw as OutboundMessage;
      if (msg.t === 'res') {
        const reply = msg.ok
          ? { type: 'worker-res', id: msg.id, ok: true, value: msg.value }
          : { type: 'worker-res', id: msg.id, ok: false, error: msg.error };
        bridge.handleSandboxMessage(overWire(reply) as BridgeMessage, generation);
      } else if (msg.t === 'snap') {
        const snapMsg = { type: 'worker-snap', subId: msg.subId, value: msg.value };
        bridge.handleSandboxMessage(overWire(snapMsg) as BridgeMessage, generation);
      }
    },
  };
  const detachPeer = bridge.registerSandboxPeer(
    (message: BridgeMessage) => {
      if (!active) return;
      if (generation === 0) generation = bridge.peerGeneration();
      const wire = overWire(message);
      if (wire.type === 'worker-op') {
        void handleMessage(ctx, tab, { ...wire.op, t: 'op', id: wire.id } as InboundMessage);
      } else if (wire.type === 'worker-sub') {
        void handleMessage(ctx, tab, { ...wire.sub, t: 'sub', subId: wire.subId } as InboundMessage);
      } else if (wire.type === 'worker-unsub') {
        void handleMessage(ctx, tab, { t: 'unsub', subId: wire.subId } as InboundMessage);
      }
    },
    [],
    'child-reconnect-tab',
    [WORKER_RELAY_CAPABILITY],
  );
  return () => {
    active = false;
    detachPeer();
  };
}

afterEach(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app)));
});

describe.each(ARMS)('pyric-admin/database child listeners [$name]', ({ make }) => {
  test('delivers initial child_added burst in query order with exact previousChildName and child refs, while other child events stay quiet on attach', async () => {
    const { app, host } = make();
    const db = getDatabase(app);

    expect(() => db.ref('bad').on('invalid' as EventType, () => {})).toThrow(/valid event type/);
    expect(() => db.ref('bad').off('invalid' as EventType)).toThrow(/valid event type/);
    expect(() => db.ref('bad').once('invalid' as EventType)).toThrow(/valid event type/);

    // Empty collection emits zero initial child_added events.
    const emptySeen: string[] = [];
    const emptyCb = db.ref('emptyItems').on('child_added', (snap) => emptySeen.push(String(snap.key)));
    await tick();
    expect(emptySeen).toEqual([]);
    db.ref('emptyItems').off('child_added', emptyCb);

    await db.ref('items').set({
      '10': { rank: 30, meta: { score: 2 } },
      '2': { rank: 10, meta: { score: 3 } },
      alpha: { rank: 20, meta: { score: 1 } },
    });

    const plainAdded: Array<{ key: string | null; prev: string | null; path: string; rank: number }> = [];
    const quietOnAttach: string[] = [];
    const itemsRef = db.ref('items');
    itemsRef.on('child_added', (snap, prev) => {
      const rank = (snap.val() as { rank: number }).rank;
      plainAdded.push({ key: snap.key, prev: prev ?? null, path: snap.ref.toString(), rank });
    });
    itemsRef.on('child_changed', (snap) => quietOnAttach.push(`c:${String(snap.key)}`));
    itemsRef.on('child_removed', (snap) => quietOnAttach.push(`r:${String(snap.key)}`));
    itemsRef.on('child_moved', (snap) => quietOnAttach.push(`m:${String(snap.key)}`));
    await tick();

    expect(plainAdded).toEqual([
      { key: '2', prev: null, path: itemsRef.child('2').toString(), rank: 10 },
      { key: '10', prev: '2', path: itemsRef.child('10').toString(), rank: 30 },
      { key: 'alpha', prev: '10', path: itemsRef.child('alpha').toString(), rank: 20 },
    ]);
    expect(quietOnAttach).toEqual([]);
    itemsRef.off();

    const byNested: Array<[string | null, string | null]> = [];
    const nestedQ = itemsRef.orderByChild('meta/score');
    nestedQ.on('child_added', (snap, prev) => byNested.push([snap.key, prev ?? null]));
    await tick();
    expect(byNested).toEqual([['alpha', null], ['10', 'alpha'], ['2', '10']]);
    nestedQ.off();

    await db.ref('scores').set({ c: 30, a: 10, b: 20 });
    const byValue: Array<[string | null, string | null, unknown]> = [];
    const valQ = db.ref('scores').orderByValue();
    valQ.on('child_added', (snap, prev) => byValue.push([snap.key, prev ?? null, snap.val()]));
    await tick();
    expect(byValue).toEqual([['a', null, 10], ['b', 'a', 20], ['c', 'b', 30]]);
    valQ.off();

    const modDb = getModularDatabase(host);
    await clientSetWithPriority(clientRef(modDb, 'ranked/low'), { label: 'L' }, 50);
    await clientSetWithPriority(clientRef(modDb, 'ranked/high'), { label: 'H' }, 5);
    const byPrio: Array<[string | null, string | null, string | number | null]> = [];
    const prioQ = db.ref('ranked').orderByPriority();
    prioQ.on('child_added', (snap, prev) => byPrio.push([snap.key, prev ?? null, snap.getPriority()]));
    await tick();
    expect(byPrio).toEqual([['high', null, 5], ['low', 'high', 50]]);
    prioQ.off();
  });

  test('tracks window push-in, eviction, pull-in on delete, and out-of-window silence for limited and bounded queries', async () => {
    const { app, host } = make();
    const db = getDatabase(app);
    const modDb = getModularDatabase(host);

    await clientSetWithPriority(clientRef(modDb, 'feed/m1'), { text: 'one' }, 10);
    await clientSetWithPriority(clientRef(modDb, 'feed/m2'), { text: 'two' }, 20);
    await clientSetWithPriority(clientRef(modDb, 'feed/m3'), { text: 'three' }, 30);

    const lastTwo = db.ref('feed').orderByKey().limitToLast(2);
    const events: Array<{
      type: string;
      key: string | null;
      prev: string | null;
      val: unknown;
      prio: string | number | null;
    }> = [];
    const record = (type: string) => (snap: DataSnapshot, prev?: string | null) => {
      events.push({ type, key: snap.key, prev: prev ?? null, val: snap.val(), prio: snap.getPriority() });
    };
    lastTwo.on('child_added', record('added'));
    lastTwo.on('child_removed', record('removed'));
    lastTwo.on('child_changed', record('changed'));
    await tick();

    expect(events).toEqual([
      { type: 'added', key: 'm2', prev: null, val: { text: 'two' }, prio: 20 },
      { type: 'added', key: 'm3', prev: 'm2', val: { text: 'three' }, prio: 30 },
    ]);

    // Mutating m1 outside the limitToLast(2) window emits nothing.
    events.length = 0;
    await db.ref('feed/m1').set({ text: 'one-edited' });
    await tick();
    expect(events).toEqual([]);

    // Appending m4 enters limitToLast(2) and evicts m2 (carrying m2's prior value + priority, prev = null).
    await clientSetWithPriority(clientRef(modDb, 'feed/m4'), { text: 'four' }, 40);
    await tick();
    expect(events.filter((e) => e.type === 'removed')).toEqual([
      { type: 'removed', key: 'm2', prev: null, val: { text: 'two' }, prio: 20 },
    ]);
    expect(events.filter((e) => e.type === 'added')).toEqual([
      { type: 'added', key: 'm4', prev: 'm3', val: { text: 'four' }, prio: 40 },
    ]);

    // Deleting in-window m4 removes m4 and pulls m2 back into the head of the window.
    events.length = 0;
    await db.ref('feed/m4').remove();
    await tick();
    expect(events.filter((e) => e.type === 'removed')).toEqual([
      { type: 'removed', key: 'm4', prev: null, val: { text: 'four' }, prio: 40 },
    ]);
    expect(events.filter((e) => e.type === 'added')).toEqual([
      { type: 'added', key: 'm2', prev: null, val: { text: 'two' }, prio: 20 },
    ]);
    lastTwo.off();

    // Bounded query: leaving and entering [10, 20] triggers child_removed / child_added.
    await db.ref('tasks').set({ t1: { dueAt: 12 }, t2: { dueAt: 18 }, t3: { dueAt: 35 } });
    const bounded = db.ref('tasks').orderByChild('dueAt').startAt(10).endAt(20);
    const boundLog: Array<[string, string | null, string | null]> = [];
    bounded.on('child_added', (s, p) => boundLog.push(['added', s.key, p ?? null]));
    bounded.on('child_removed', (s, p) => boundLog.push(['removed', s.key, p ?? null]));
    await tick();
    expect(boundLog).toEqual([
      ['added', 't1', null],
      ['added', 't2', 't1'],
    ]);

    boundLog.length = 0;
    await db.ref('tasks/t1').update({ dueAt: 50 });
    await tick();
    expect(boundLog).toEqual([['removed', 't1', null]]);

    boundLog.length = 0;
    await db.ref('tasks/t3').update({ dueAt: 15 });
    await tick();
    expect(boundLog).toEqual([['added', 't3', null]]);
    bounded.off();
  });

  test('emits child_changed and child_moved with accurate previousChildName (including rank-preserving index change, and no child_moved under orderByKey)', async () => {
    const { app, host } = make();
    const db = getDatabase(app);
    const modDb = getModularDatabase(host);

    await db.ref('board').set({
      u1: { score: 10, label: 'first' },
      u2: { score: 20, label: 'second' },
      u3: { score: 30, label: 'third' },
    });

    const q = db.ref('board').orderByChild('score');
    const changed: Array<[string | null, string | null, unknown]> = [];
    const moved: Array<[string | null, string | null, unknown]> = [];
    const keyMoved: string[] = [];

    q.on('child_changed', (s, prev) => changed.push([s.key, prev ?? null, s.val()]));
    q.on('child_moved', (s, prev) => moved.push([s.key, prev ?? null, s.val()]));
    db.ref('board').orderByKey().on('child_moved', (s) => keyMoved.push(String(s.key)));
    await tick();

    // Non-indexed field edit -> child_changed only.
    await db.ref('board/u2').update({ label: 'second-edited' });
    await tick();
    expect(changed).toEqual([['u2', 'u1', { score: 20, label: 'second-edited' }]]);
    expect(moved).toEqual([]);

    // Indexed score edit moving u1 past u3 -> both child_moved and child_changed with prev = 'u3'.
    changed.length = 0;
    await db.ref('board/u1').update({ score: 99 });
    await tick();
    expect(changed).toEqual([['u1', 'u3', { score: 99, label: 'first' }]]);
    expect(moved).toEqual([['u1', 'u3', { score: 99, label: 'first' }]]);

    // Rank-preserving indexed change (u2: 20 -> 25 stays ahead of u3=30, u1=99) still emits child_moved.
    changed.length = 0;
    moved.length = 0;
    await db.ref('board/u2').update({ score: 25 });
    await tick();
    expect(changed).toEqual([['u2', null, { score: 25, label: 'second-edited' }]]);
    expect(moved).toEqual([['u2', null, { score: 25, label: 'second-edited' }]]);
    expect(keyMoved).toEqual([]);
    q.off();
    db.ref('board').off();

    // Plain ref orders by priority: changing priority emits child_moved + child_changed.
    await clientSetWithPriority(clientRef(modDb, 'prioPlain/a'), 'alpha', 1);
    await clientSetWithPriority(clientRef(modDb, 'prioPlain/b'), 'beta', 2);
    const plainMoved: Array<[string | null, string | null]> = [];
    const plainChanged: Array<[string | null, string | null]> = [];
    db.ref('prioPlain').on('child_moved', (s, p) => plainMoved.push([s.key, p ?? null]));
    db.ref('prioPlain').on('child_changed', (s, p) => plainChanged.push([s.key, p ?? null]));
    await tick();

    await clientSetPriority(clientRef(modDb, 'prioPlain/a'), 10);
    await tick();
    expect(plainMoved).toEqual([['a', 'b']]);
    expect(plainChanged).toEqual([['a', 'b']]);
    db.ref('prioPlain').off();
  });

  test('supports once() for child_added, child_changed, child_removed, and child_moved with context binding and single fire', async () => {
    const { app } = make();
    const db = getDatabase(app);
    await db.ref('onceSeeded').set({ b: { rank: 20 }, c: { rank: 30 }, a: { rank: 10 } });

    const cbCalls: Array<{ tag: string; key: string | null; prev: string | null }> = [];
    const firstSnap = await db
      .ref('onceSeeded')
      .orderByChild('rank')
      .once(
        'child_added',
        function onFirst(this: { tag: string }, snap, prev) {
          cbCalls.push({ tag: this.tag, key: snap.key, prev: prev ?? null });
        },
        { tag: 'once-ctx' },
      );
    expect(firstSnap.key).toBe('a');
    expect(firstSnap.val()).toEqual({ rank: 10 });
    expect(cbCalls).toEqual([{ tag: 'once-ctx', key: 'a', prev: null }]);

    await db.ref('onceSeeded/z').set({ rank: 1 });
    await tick();
    expect(cbCalls).toHaveLength(1);

    // Empty path waits until the first child arrives.
    const pendingAdded = db.ref('onceEmpty').once('child_added');
    await tick();
    await db.ref('onceEmpty/first').set({ ready: true });
    const addedLater = await pendingAdded;
    expect(addedLater.key).toBe('first');
    expect(addedLater.val()).toEqual({ ready: true });

    const changedKeys: Array<[string | null, string | null]> = [];
    const movedKeys: Array<[string | null, string | null]> = [];
    const rankedSeed = db.ref('onceSeeded').orderByChild('rank');
    const changedPromise = rankedSeed.once('child_changed', (s, p) => changedKeys.push([s.key, p ?? null]));
    const movedPromise = rankedSeed.once('child_moved', (s, p) => movedKeys.push([s.key, p ?? null]));
    await tick();

    await db.ref('onceSeeded/c').set({ rank: 5 }); // moves between z (1) and a (10)
    const [changedSnap, movedSnap] = await Promise.all([changedPromise, movedPromise]);
    expect([changedSnap.key, movedSnap.key]).toEqual(['c', 'c']);
    expect(changedKeys).toEqual([['c', 'z']]);
    expect(movedKeys).toEqual([['c', 'z']]);

    await db.ref('onceSeeded/c').set({ rank: 99 });
    await tick();
    expect([changedKeys.length, movedKeys.length]).toEqual([1, 1]);

    const removedArgs: Array<[string | null, string | null]> = [];
    const removedPromise = db.ref('onceSeeded').once('child_removed', (s, p) => {
      removedArgs.push([s.key, p ?? null]);
    });
    await tick();
    await db.ref('onceSeeded/b').remove();
    const removedSnap = await removedPromise;
    expect(removedSnap.key).toBe('b');
    expect(removedSnap.val()).toEqual({ rank: 20 });
    expect(removedArgs).toEqual([['b', null]]);
  });

  test('supports synchronous re-entrant off() mid-initial-burst, context-scoped off(), and sibling event/query isolation', async () => {
    const { app } = make();
    const db = getDatabase(app);
    await db.ref('burst').set({ a: 1, b: 2, c: 3 });

    const burstKeys: Array<string | null> = [];
    const burstRef = db.ref('burst');
    const selfDetaching = (snap: DataSnapshot): void => {
      burstKeys.push(snap.key);
      burstRef.off('child_added', selfDetaching);
    };
    expect(burstRef.on('child_added', selfDetaching)).toBe(selfDetaching);
    await tick();
    expect(burstKeys).toEqual(['a']);
    await burstRef.child('d').set(4);
    await tick();
    expect(burstKeys).toEqual(['a']);

    const qFirst = burstRef.orderByKey().limitToFirst(2);
    const qLast = burstRef.orderByKey().limitToLast(2);
    const firstAdded: string[] = [];
    const lastAdded: string[] = [];
    const valueSnaps: unknown[] = [];
    const changedCtxA: string[] = [];
    const changedCtxB: string[] = [];
    const ctxA = { id: 'A' };
    const ctxB = { id: 'B' };
    function onChanged(this: { id: string }, snap: DataSnapshot): void {
      if (this.id === 'A') changedCtxA.push(String(snap.key));
      else changedCtxB.push(String(snap.key));
    }

    qFirst.on('child_added', (s) => firstAdded.push(String(s.key)));
    qLast.on('child_added', (s) => lastAdded.push(String(s.key)));
    qLast.on('value', (s) => valueSnaps.push(s.val()));
    burstRef.on('child_changed', onChanged, ctxA);
    burstRef.on('child_changed', onChanged, ctxB);
    await tick();
    expect([firstAdded, lastAdded]).toEqual([['a', 'b'], ['c', 'd']]);

    qFirst.off('child_added');
    burstRef.off('child_changed', onChanged, ctxA);

    await burstRef.child('0').set(0);
    await burstRef.child('z').set(9);
    await burstRef.child('c').set(33);
    await tick();

    expect(firstAdded).toEqual(['a', 'b']);
    expect(lastAdded).toEqual(['c', 'd', 'z']);
    expect(valueSnaps[valueSnaps.length - 1]).toEqual({ d: 4, z: 9 });
    expect([changedCtxA, changedCtxB]).toEqual([[], ['c']]);

    // Plain ref.off('child_added') clears child_added across query views while keeping value & child_changed.
    burstRef.off('child_added');
    const lastAddedBefore = lastAdded.length;
    const valueBefore = valueSnaps.length;
    await burstRef.child('zz').set(10);
    await burstRef.child('z').set(99);
    await tick();

    expect(lastAdded).toHaveLength(lastAddedBefore);
    expect(valueSnaps.length).toBeGreaterThan(valueBefore);
    expect(changedCtxB).toEqual(['c', 'z']);
    burstRef.off();
  });

  test('bypasses .read: false security rules, tolerates unindexed orderByChild listeners, and isolates multi-instance shards', async () => {
    const { app, host } = make();
    const shardUrl = 'https://demo-child-shard.firebaseio.com';
    const primary = getDatabase(app);
    const shard = getDatabaseWithUrl(shardUrl, app);

    await primary.ref('events').set({ e1: { priority: 2 }, e2: { priority: 1 } });
    await shard.ref('events').set({ e1: { priority: 99 } });

    setRules(host, { rules: { '.read': false, '.write': false } });
    setRules(host, { rules: { '.read': false, '.write': false } }, shardUrl);

    const primaryAdded: Array<[string | null, unknown]> = [];
    const shardAdded: Array<[string | null, unknown]> = [];

    primary
      .ref('events')
      .orderByChild('priority')
      .limitToFirst(2)
      .on('child_added', (s) => primaryAdded.push([s.key, s.val()]));
    shard.ref('events').orderByChild('priority').on('child_added', (s) => shardAdded.push([s.key, s.val()]));
    await tick();

    expect(primaryAdded).toEqual([
      ['e2', { priority: 1 }],
      ['e1', { priority: 2 }],
    ]);
    expect(shardAdded).toEqual([['e1', { priority: 99 }]]);

    await shard.ref('events/e3').set({ priority: 5 });
    await tick();
    expect(primaryAdded).toHaveLength(2);
    expect(shardAdded).toEqual([
      ['e1', { priority: 99 }],
      ['e3', { priority: 5 }],
    ]);

    primary.ref('events').off();
    shard.ref('events').off();
  });
});

describe('pyric-admin/database remote child listener reconnect deduplication', () => {
  test('suppresses duplicate child_added on clean reconnect AND emits only true deltas when data mutated during disconnect', async () => {
    const host = initializeSandbox();
    databaseSandbox.setDefaultPolicy(getModularDatabase(host), 'allow');

    let dropCurrentConnection: ((reason: string) => void) | undefined;
    const warnings: string[] = [];

    const lazyRemote = createLazyRemoteSandbox(
      async (onConnectionLost: (reason: string, resend?: ReleasedOp[]) => void): Promise<RemoteSandbox> => {
        const bridge = createBridge({ mode: 'sandbox', version: 'test' });
        const detachHost = attachSandboxHostToBridge(host, bridge);
        let deliver: (message: BridgeMessage) => void = () => {};
        const session = createConsumerSession(bridge, (message) => deliver(overWire(message)));
        const core = createRemoteSandboxCore(
          { send: (message) => session.handleMessage(overWire(message)) },
          { serveUrl: 'http://localhost:5000' },
        );
        deliver = core.handleMessage;
        core.start();
        await core.ready;

        dropCurrentConnection = (reason: string) => {
          const released = core.releaseInFlight(reason);
          session.detach();
          detachHost();
          onConnectionLost(reason, released);
        };
        return createRemoteSandboxHandle({
          channel: core.channel,
          serveUrl: 'http://localhost:5000',
          close: () => {
            core.dispose('closed');
            session.detach();
            detachHost();
          },
        });
      },
      { url: 'http://localhost:5000', warn: (msg) => warnings.push(msg) },
    );

    const app = initializeApp({ sandbox: lazyRemote }, 'child-reconnect-app');
    const db = getDatabase(app);
    await db.ref('queue').set({
      a: { step: 1, text: 'alpha' },
      b: { step: 2, text: 'beta' },
      c: { step: 3, text: 'gamma' },
    });

    const added: Array<[string | null, string | null, unknown]> = [];
    const changed: Array<[string | null, string | null, unknown]> = [];
    const removed: Array<[string | null, string | null, unknown]> = [];

    const q = db.ref('queue').orderByChild('step');
    q.on('child_added', (s, p) => added.push([s.key, p ?? null, s.val()]));
    q.on('child_changed', (s, p) => changed.push([s.key, p ?? null, s.val()]));
    q.on('child_removed', (s, p) => removed.push([s.key, p ?? null, s.val()]));
    await tick(40);

    expect(added).toEqual([
      ['a', null, { step: 1, text: 'alpha' }],
      ['b', 'a', { step: 2, text: 'beta' }],
      ['c', 'b', { step: 3, text: 'gamma' }],
    ]);

    // 1. Reconnect with unchanged host state -> zero duplicate child_added.
    added.length = 0;
    dropCurrentConnection!('simulated transport blip 1');
    await db.ref('ping').get();
    await tick(40);
    expect([added, changed, removed]).toEqual([[], [], []]);

    // 2. Drop connection, mutate host while disconnected, then reconnect -> only true deltas fire.
    dropCurrentConnection!('simulated transport blip 2');
    const localHostApp = initializeApp({ sandbox: host }, 'host-mutator-app');
    const hostAdminDb = getDatabase(localHostApp);
    await hostAdminDb.ref('queue/a').remove();
    await hostAdminDb.ref('queue/b').update({ text: 'beta-updated' });
    await hostAdminDb.ref('queue/d').set({ step: 4, text: 'delta' });

    await db.ref('ping').get();
    await tick(50);

    expect(removed).toEqual([['a', null, { step: 1, text: 'alpha' }]]);
    expect(changed).toEqual([['b', null, { step: 2, text: 'beta-updated' }]]);
    expect(added).toEqual([['d', 'c', { step: 4, text: 'delta' }]]);

    q.off();
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    lazyRemote.close();
  });
});
