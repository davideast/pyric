/**
 * Dual-arm adversarial parity regression suite for `pyric-admin/database`
 * covering lazy-remote subscription teardown, `deleteApp` listener cleanup,
 * `RT-7` snapshot key/priority ordering, multi-app sandbox isolation,
 * `goOffline()`/`goOnline()` relay ordering, `.info/*` listener reads,
 * optional `startAfter`/`endBefore` endpoints, and listener/`OnDisconnect`
 * synchronous argument validation and callback delivery contracts.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import {
  getDatabase as getModularDatabase,
  ref as modularRef,
  sandbox as databaseSandbox,
  setPriority as modularSetPriority,
  setWithPriority as modularSetWithPriority,
} from 'pyric/database';
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
import { getFirestore } from 'pyric/firestore';
import { deleteApp, getApps, initializeApp, type PyricAdminApp } from '../../src/app/index.js';
import {
  getDatabase,
  ServerValue,
  type DataSnapshot,
  type EventType,
} from '../../src/database/index.js';
import { sharedWorkerArm } from './arms.js';

const tick = (ms = 15): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const overWire = <T>(frame: T): T => JSON.parse(JSON.stringify(frame)) as T;

let seq = 0;

interface ArmBundle {
  readonly app: PyricAdminApp;
  readonly host: Sandbox;
  readonly sharedSandboxForSecondApp: Sandbox;
}

const ARMS: ReadonlyArray<{ name: string; make: () => ArmBundle }> = [
  {
    name: 'in-process',
    make: () => {
      const host = initializeSandbox();
      databaseSandbox.setDefaultPolicy(getModularDatabase(host), 'allow');
      const app = initializeApp({ sandbox: host, projectId: 'demo-parity' }, `adv-local-${++seq}`);
      return { app, host, sharedSandboxForSecondApp: host };
    },
  },
  {
    name: 'shared-worker',
    make: () => {
      const { app, host } = sharedWorkerArm();
      return { app, host, sharedSandboxForSecondApp: app.sandbox };
    },
  },
];

function countHostSubs(ctx: HostCtx): number {
  let total = 0;
  for (const portSubs of ctx.subs.values()) total += portSubs.size;
  return total;
}

function makeInspectableLazyRemote(): {
  host: Sandbox;
  ctx: HostCtx;
  lazy: RemoteSandbox;
  loopHoldCount: () => number;
  closeAll: () => void;
} {
  const host = initializeSandbox();
  databaseSandbox.setDefaultPolicy(getModularDatabase(host), 'allow');
  const ctx: HostCtx = {
    db: getFirestore(host),
    sandbox: host,
    instanceId: `adv-lazy-host-${++seq}`,
    subs: new Map(),
    flushPersistence: async () => {},
  };
  let loopHolds = 0;
  const cleanups: Array<() => void> = [];

  const lazy = createLazyRemoteSandbox(
    async (onConnectionLost: (reason: string, resend?: ReleasedOp[]) => void) => {
      const bridge = createBridge({ mode: 'sandbox', version: 'test' });
      let generation = 0;
      const tab: PortLike = {
        postMessage(raw: unknown) {
          const msg = raw as OutboundMessage;
          if (msg.t === 'res') {
            let reply: Record<string, unknown>;
            if (msg.ok) {
              reply = { type: 'worker-res', id: msg.id, ok: true, value: msg.value };
            } else {
              reply = { type: 'worker-res', id: msg.id, ok: false, error: msg.error };
            }
            bridge.handleSandboxMessage(overWire(reply) as BridgeMessage, generation);
          } else if (msg.t === 'snap') {
            const snapFrame = { type: 'worker-snap', subId: msg.subId, value: msg.value };
            bridge.handleSandboxMessage(overWire(snapFrame) as BridgeMessage, generation);
          }
        },
      };
      const detachPeer = bridge.registerSandboxPeer((message: BridgeMessage) => {
        if (generation === 0) generation = bridge.peerGeneration();
        const wire = overWire(message);
        if (wire.type === 'worker-op') {
          void handleMessage(ctx, tab, { ...wire.op, t: 'op', id: wire.id } as InboundMessage);
        } else if (wire.type === 'worker-sub') {
          void handleMessage(ctx, tab, { ...wire.sub, t: 'sub', subId: wire.subId } as InboundMessage);
        } else if (wire.type === 'worker-unsub') {
          void handleMessage(ctx, tab, { t: 'unsub', subId: wire.subId } as InboundMessage);
        }
      }, [], 'lazy-tab', [WORKER_RELAY_CAPABILITY]);

      let deliver: (message: BridgeMessage) => void = () => {};
      const session = createConsumerSession(bridge, (msg) => deliver(overWire(msg)));
      const core = createRemoteSandboxCore(
        {
          send: (msg) => session.handleMessage(overWire(msg)),
          ref: () => { loopHolds += 1; },
          unref: () => { loopHolds -= 1; },
        },
        { serveUrl: 'http://localhost:5000' },
      );
      deliver = core.handleMessage;
      core.start();
      await core.ready;
      const teardown = (): void => {
        core.dispose('closed');
        session.detach();
        detachPeer();
      };
      cleanups.push(teardown);
      void onConnectionLost;
      return createRemoteSandboxHandle({ channel: core.channel, serveUrl: 'http://localhost:5000', close: teardown });
    },
    { url: 'http://localhost:5000' },
  );

  return {
    host,
    ctx,
    lazy,
    loopHoldCount: () => loopHolds,
    closeAll: () => {
      lazy.close();
      for (const fn of cleanups) fn();
    },
  };
}

afterEach(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app)));
});

describe('pyric-admin/database lazy-remote subscription hygiene & deleteApp cleanup', () => {
  test('once(), initial re-entrant off(), pre-attach off(), and deleteApp() leave 0 leaked host subs or loop holds', async () => {
    const { ctx, lazy, loopHoldCount, closeAll } = makeInspectableLazyRemote();
    try {
      // Pre-attach synchronous on() + off() before ensure() resolves never leaks.
      const preApp = initializeApp({ sandbox: lazy, projectId: 'demo-lazy' }, `lazy-pre-${++seq}`);
      const preDb = getDatabase(preApp);
      const preCb = preDb.ref('items').on('value', () => {});
      preDb.ref('items').off('value', preCb);

      // Seed data (attaches lazy handle).
      const app = initializeApp({ sandbox: lazy, projectId: 'demo-lazy' }, `lazy-main-${++seq}`);
      const db = getDatabase(app);
      await db.ref('items').set({ x: 1, y: 2 });
      expect(countHostSubs(ctx)).toBe(0);
      expect(loopHoldCount()).toBe(0);

      // once('value') and once('child_added') under createLazyRemoteSandbox must clean up completely.
      const vSnap = await db.ref('items').once('value');
      const cSnap = await db.ref('items').once('child_added');
      await Promise.resolve();
      expect(vSnap.val()).toEqual({ x: 1, y: 2 });
      expect([cSnap.key, cSnap.val()]).toEqual(['x', 1]);
      expect(countHostSubs(ctx)).toBe(0);
      expect(loopHoldCount()).toBe(0);

      // Initial-callback re-entrant off() on both value and child_added must send worker-unsub.
      const seenReentry: string[] = [];
      const selfValue = (snap: DataSnapshot): void => {
        seenReentry.push(`v:${JSON.stringify(snap.val())}`);
        db.ref('items').off('value', selfValue);
      };
      const selfChild = (snap: DataSnapshot): void => {
        seenReentry.push(`c:${String(snap.key)}`);
        db.ref('items').off('child_added', selfChild);
      };
      db.ref('items').on('value', selfValue);
      db.ref('items').on('child_added', selfChild);
      await tick();
      expect(seenReentry).toEqual(['v:{"x":1,"y":2}', 'c:x']);
      expect(countHostSubs(ctx)).toBe(0);
      expect(loopHoldCount()).toBe(0);

      // Active listeners remain registered while app lives, then detach on deleteApp(app).
      const postDeleteEvents: unknown[] = [];
      db.ref('items').on('value', (s) => postDeleteEvents.push(s.val()));
      db.ref('items').on('child_added', (s) => postDeleteEvents.push(s.key));
      db.ref('items').on('child_changed', (s) => postDeleteEvents.push(s.key));
      db.ref('items').orderByKey().limitToFirst(1).on('value', (s) => postDeleteEvents.push(s.val()));
      await tick();
      expect(countHostSubs(ctx)).toBe(4);
      expect(loopHoldCount()).toBe(1);

      postDeleteEvents.length = 0;
      await deleteApp(app);
      await tick();
      expect(countHostSubs(ctx)).toBe(0);
      expect(loopHoldCount()).toBe(0);

      await preDb.ref('items/x').set(99);
      await preDb.ref('items/z').set(3);
      await tick();
      expect(postDeleteEvents).toEqual([]);
    } finally {
      closeAll();
    }
  });
});

describe.each(ARMS)('pyric-admin/database adversarial parity regressions ($name)', ({ make }) => {
  test('deleteApp(app) detaches active local and remote listeners so later mutations never invoke them', async () => {
    const { app, sharedSandboxForSecondApp } = make();
    const writerApp = initializeApp(
      { sandbox: sharedSandboxForSecondApp, projectId: 'demo-parity' },
      `adv-writer-${++seq}`,
    );
    const db = getDatabase(app);
    const writerDb = getDatabase(writerApp);
    await db.ref('tasks').set({ t1: 'open' });

    const hits: string[] = [];
    db.ref('tasks').on('value', (s) => hits.push(`val:${JSON.stringify(s.val())}`));
    db.ref('tasks').on('child_added', (s) => hits.push(`add:${String(s.key)}`));
    db.ref('tasks').on('child_changed', (s) => hits.push(`chg:${String(s.key)}`));
    await tick();
    expect(hits.length).toBeGreaterThanOrEqual(2);

    hits.length = 0;
    await deleteApp(app);
    await writerDb.ref('tasks/t1').set('closed');
    await writerDb.ref('tasks/t2').set('open');
    await tick();
    expect(hits).toEqual([]);
  });

  test('RT-7 orders val(), exportVal(), and toJSON() keys by (priority, nameCompare) across queried, incremental, and prioritized nodes', async () => {
    const { app, host } = make();
    const db = getDatabase(app);

    // 1. Queried get / once('value') / on('value'): val/exportVal/toJSON sort by (priority, key), forEach uses query order.
    await db.ref('scores').set({ a: { score: 30 }, b: { score: 10 }, c: { score: 20 } });
    const q = db.ref('scores').orderByChild('score');
    const getSnap = await q.get();
    const onceSnap = await q.once('value');
    let onSnap: DataSnapshot | undefined;
    const onCb = q.on('value', (s) => { onSnap = s; });
    await tick();
    q.off('value', onCb);

    for (const snap of [getSnap, onceSnap, onSnap!]) {
      expect(Object.keys(snap.val() as object)).toEqual(['a', 'b', 'c']);
      expect(Object.keys(snap.exportVal() as object)).toEqual(['a', 'b', 'c']);
      expect(Object.keys(snap.toJSON() as object)).toEqual(['a', 'b', 'c']);
      const walked: string[] = [];
      snap.forEach((child) => { walked.push(String(child.key)); });
      expect(walked).toEqual(['b', 'c', 'a']);
    }

    // 2. Incremental plain writes do not leak JS property insertion order.
    await db.ref('session').set({ x: 1 });
    await db.ref('session/status').set('offline');
    const incSnap = await db.ref('session').get();
    expect(Object.keys(incSnap.val() as object)).toEqual(['status', 'x']);
    expect(Object.keys(incSnap.exportVal() as object)).toEqual(['status', 'x']);
    expect(Object.keys(incSnap.toJSON() as object)).toEqual(['status', 'x']);

    // 3. Client-seeded priorities drive val(), exportVal(), toJSON(), snap.forEach, and rootSnap.child().forEach.
    const clientDb = getModularDatabase(host);
    await modularSetWithPriority(modularRef(clientDb, 'prio/a'), 'alpha', 30);
    await modularSetWithPriority(modularRef(clientDb, 'prio/b'), 'beta', 10);
    await modularSetWithPriority(modularRef(clientDb, 'prio/c'), 'gamma', 20);
    await modularSetPriority(modularRef(clientDb, 'prio'), 'top-prio');

    const prioSnap = await db.ref('prio').get();
    const prioOnce = await db.ref('prio').once('value');
    for (const snap of [prioSnap, prioOnce]) {
      expect(snap.getPriority()).toBe('top-prio');
      expect(Object.keys(snap.val() as object)).toEqual(['b', 'c', 'a']);
      expect(Object.keys(snap.exportVal() as object)).toEqual(['b', 'c', 'a', '.priority']);
      expect(Object.keys(snap.toJSON() as object)).toEqual(['b', 'c', 'a', '.priority']);
      const walked: Array<[string | null, unknown, string | number | null]> = [];
      snap.forEach((child) => {
        walked.push([child.key, child.val(), child.getPriority()]);
      });
      expect(walked).toEqual([
        ['b', 'beta', 10],
        ['c', 'gamma', 20],
        ['a', 'alpha', 30],
      ]);
    }

    const rootSnap = await db.ref('/').get();
    const subSnap = rootSnap.child('prio');
    expect(subSnap.getPriority()).toBe('top-prio');
    expect(Object.keys(subSnap.val() as object)).toEqual(['b', 'c', 'a']);
    const subWalked: Array<[string | null, string | number | null]> = [];
    subSnap.forEach((child) => {
      subWalked.push([child.key, child.getPriority()]);
    });
    expect(subWalked).toEqual([
      ['b', 10],
      ['c', 20],
      ['a', 30],
    ]);
  });

  test('isolates isEqual, off(), and local goOffline() across two PyricAdminApps sharing a sandbox while sharing data', async () => {
    const { app: app1, sharedSandboxForSecondApp } = make();
    const app2 = initializeApp(
      { sandbox: sharedSandboxForSecondApp, projectId: 'demo-parity' },
      `adv-peer-${++seq}`,
    );
    const db1 = getDatabase(app1);
    const db2 = getDatabase(app2);

    expect(db1.ref('items').isEqual(db1.ref('items'))).toBe(true);
    expect(db1.ref('items').isEqual(db2.ref('items'))).toBe(false);
    expect(
      db1.ref('items').orderByChild('n').isEqual(db2.ref('items').orderByChild('n')),
    ).toBe(false);

    await db1.ref('items').set({ k1: 1 });
    const app1Values: unknown[] = [];
    db1.ref('items').on('value', (s) => app1Values.push(s.val()));
    await tick();
    expect(app1Values).toEqual([{ k1: 1 }]);

    // Calling off() on app2 must NOT detach app1's listeners, while writes share the data tree.
    db2.ref('items').off();
    db2.ref('items').off('value');
    await db2.ref('items/k2').set(2);
    await tick();
    expect(app1Values).toEqual([{ k1: 1 }, { k1: 1, k2: 2 }]);
    db1.ref('items').off();

    await db1.ref('presence').set({ app1: 'online', app2: 'online' });
    await db1.ref('presence/app1').onDisconnect().set('offline');
    await db2.ref('presence/app2').onDisconnect().set('offline');

    db1.goOffline();
    expect((await db2.ref('presence').get()).val()).toEqual({ app1: 'offline', app2: 'online' });
    db2.goOffline();
    expect((await db1.ref('presence').get()).val()).toEqual({ app1: 'offline', app2: 'offline' });
    db1.goOnline();
    db2.goOnline();
  });

  test('goOffline(); goOnline(); immediately awaited get() and once("value") observe fully drained multi-op state', async () => {
    const { app } = make();
    const db = getDatabase(app);

    await db.ref('od').set({ a: 0, b: 'live' });
    await db.ref('od/a').onDisconnect().set(10);
    await db.ref('od/b').onDisconnect().set('drained');
    await db.ref('od').onDisconnect().update({
      a: ServerValue.increment(5),
      c: 'added',
    });

    db.goOffline();
    db.goOnline();
    const afterGet = (await db.ref('od').get()).val();
    expect(afterGet).toEqual({ a: 15, b: 'drained', c: 'added' });

    await db.ref('od/step').onDisconnect().set(1);
    await db.ref('od').onDisconnect().update({ step: ServerValue.increment(2) });
    db.goOffline();
    db.goOnline();
    const afterOnce = (await db.ref('od').once('value')).val();
    expect(afterOnce).toEqual({ a: 15, b: 'drained', c: 'added', step: 3 });
  });

  test('supports once/on on .info/connected and .info across both arms while get() rejects .info/*', async () => {
    const { app } = make();
    const db = getDatabase(app);

    await expect(db.ref('.info/connected').get()).rejects.toThrow(/Invalid token in path/);
    await expect(db.ref('.info').get()).rejects.toThrow(/Invalid token in path/);

    const connSnap = await db.ref('.info/connected').once('value');
    expect([connSnap.key, connSnap.exists(), connSnap.val()]).toEqual(['connected', true, true]);
    const offsetSnap = await db.ref('.info/serverTimeOffset').once('value');
    expect([offsetSnap.key, offsetSnap.exists(), offsetSnap.val()]).toEqual(['serverTimeOffset', true, 0]);
    const infoSnap = await db.ref('.info').once('value');
    expect(infoSnap.val()).toEqual({ connected: true, serverTimeOffset: 0 });

    const infoChildren: Array<[string | null, unknown, string | null]> = [];
    const childCb = db.ref('.info').on('child_added', (s, prev) => {
      infoChildren.push([s.key, s.val(), prev ?? null]);
    });
    await tick();
    db.ref('.info').off('child_added', childCb);
    expect(infoChildren).toEqual([
      ['connected', true, null],
      ['serverTimeOffset', 0, 'connected'],
    ]);

    const transitions: unknown[] = [];
    const connCb = db.ref('.info/connected').on('value', (s) => transitions.push(s.val()));
    await tick();
    expect(transitions).toEqual([true]);
    db.goOffline();
    db.goOnline();
    expect(transitions).toEqual([true, false, true]);
    db.ref('.info/connected').off('value', connCb);
  });

  test('defaults omitted/undefined startAfter() and endBefore() to null except under orderByKey()', async () => {
    const { app } = make();
    const db = getDatabase(app);
    await db.ref('entries').set({
      unset: { label: 'none' },
      low: { label: 'low', rank: 10 },
      high: { label: 'high', rank: 20 },
    });

    for (const q of [
      db.ref('entries').orderByChild('rank').startAfter(),
      db.ref('entries').orderByChild('rank').startAfter(undefined),
    ]) {
      const keys: string[] = [];
      (await q.get()).forEach((child) => { keys.push(String(child.key)); });
      expect(keys).toEqual(['low', 'high']);
    }

    for (const q of [
      db.ref('entries').orderByChild('rank').endBefore(),
      db.ref('entries').orderByChild('rank').endBefore(undefined),
    ]) {
      const snap = await q.get();
      expect([snap.exists(), snap.val()]).toEqual([false, null]);
    }

    expect(() => db.ref('entries').orderByKey().startAfter()).toThrow(/must be a string/);
    expect(() => db.ref('entries').orderByKey().startAfter(undefined)).toThrow(/must be a string/);
    expect(() => db.ref('entries').orderByKey().endBefore()).toThrow(/must be a string/);
    expect(() => db.ref('entries').orderByKey().endBefore(undefined)).toThrow(/must be a string/);
    expect(() => db.ref('entries').orderByChild('rank').startAfter(Number.NaN)).toThrow(/NaN/);
    expect(() => db.ref('entries').orderByChild('rank').startAfter({ nested: 1 })).toThrow(/cannot be an object/);
  });

  test('validates listener and OnDisconnect callbacks/contexts synchronously, passes 1 arg to value listeners, and isolates throws', async () => {
    const { app } = make();
    const db = getDatabase(app);
    const ref = db.ref('validated');
    await ref.set({ a: 1 });

    // 1. Synchronous invalid event type on on / off / once (not rejected promise).
    expect(() => ref.once('bogus' as EventType)).toThrow(/Query\.once failed: eventType/);
    expect(() => ref.on('bogus' as EventType, () => {})).toThrow(/Query\.on failed: eventType/);
    expect(() => ref.off('bogus' as EventType)).toThrow(/Query\.off failed: eventType/);

    // 2. Callback validation on on (required) and once / off (optional: null & undefined allowed).
    const validFnMsg = /callback argument must be a valid function\./;
    for (const bad of [null, undefined, false, 'str', 123, {}, []]) {
      expect(() => ref.on('value', bad as never)).toThrow(validFnMsg);
    }
    for (const bad of [false, true, 'str', 123, {}, []]) {
      expect(() => ref.once('value', bad as never)).toThrow(validFnMsg);
      expect(() => ref.off('value', bad as never)).toThrow(validFnMsg);
    }
    expect((await ref.once('value', null as never)).val()).toEqual({ a: 1 });
    expect(() => ref.off('value', null as never)).not.toThrow();

    // 3. cancelCallbackOrContext and context validation on on / once / off.
    const noop = (): void => {};
    for (const bad3 of [42, 'bad', true, []]) {
      expect(() => ref.on('value', noop, bad3 as never)).toThrow(/cancelOrContext/);
      expect(() => ref.once('value', noop, bad3 as never)).toThrow(/cancelOrContext/);
    }
    for (const badCtx of [42, 'bad', true, [], () => {}]) {
      expect(() => ref.on('value', noop, noop, badCtx as never)).toThrow(/context argument/);
      expect(() => ref.on('value', noop, null, badCtx as never)).toThrow(/context argument/);
      expect(() => ref.once('value', noop, noop, badCtx as never)).toThrow(/context argument/);
      expect(() => ref.once('value', noop, undefined, badCtx as never)).toThrow(/context argument/);
      expect(() => ref.off('value', noop, badCtx as never)).toThrow(/context argument must be a valid context object/);
    }
    expect(() => ref.on('value', noop, {} as never, {})).toThrow(/cancel argument must be a valid function/);
    expect(() => ref.once('value', noop, {} as never, {})).toThrow(/cancel argument must be a valid function/);

    // 4. OnDisconnect onComplete validation throws synchronously before queueing.
    const od = db.ref('odGuard').onDisconnect();
    const badOnCompleteMsg = /onComplete argument must be a valid function\./;
    for (const badCb of ['str', 123, true, {}, []]) {
      expect(() => od.set('bad', badCb as never)).toThrow(badOnCompleteMsg);
      expect(() => od.setWithPriority('bad', 1, badCb as never)).toThrow(badOnCompleteMsg);
      expect(() => od.update({ k: 'bad' }, badCb as never)).toThrow(badOnCompleteMsg);
      expect(() => od.remove(badCb as never)).toThrow(badOnCompleteMsg);
      expect(() => od.cancel(badCb as never)).toThrow(badOnCompleteMsg);
    }
    db.goOffline();
    db.goOnline();
    expect((await db.ref('odGuard').get()).val()).toBeNull();

    // 5. 'value' callbacks receive 1 arg (2nd param is undefined), and throws are isolated from siblings.
    const argCounts: Array<[string, number, unknown]> = [];
    await ref.once('value', function (...args: unknown[]) {
      argCounts.push(['once-plain', args.length, args[1]]);
    });
    await ref.orderByKey().once('value', function (...args: unknown[]) {
      argCounts.push(['once-query', args.length, args[1]]);
    });

    const siblingVals: unknown[] = [];
    ref.on('value', (...args: unknown[]) => {
      argCounts.push(['on-thrower', args.length, args[1]]);
      throw new Error('boom inside listener');
    });
    ref.on('value', (s) => {
      siblingVals.push(s.val());
    });
    await tick();
    await ref.set({ a: 2 });
    await tick();
    ref.off('value');

    expect(argCounts.slice(0, 3)).toEqual([
      ['once-plain', 1, undefined],
      ['once-query', 1, undefined],
      ['on-thrower', 1, undefined],
    ]);
    expect(siblingVals).toEqual([{ a: 1 }, { a: 2 }]);

    // 6. Pair (callback, context) on off(eventType, cb, ctx?) matching firebase-admin.
    const ctxSeen: string[] = [];
    const ctx1 = { tag: 'c1' };
    const ctx2 = { tag: 'c2' };
    const ctx3 = { tag: 'c3' };
    function taggedCb(this: { tag?: string } | undefined): void {
      ctxSeen.push(this?.tag ?? 'unbound');
    }
    ref.on('value', taggedCb, ctx1);
    ref.on('value', taggedCb, ctx2);
    ref.on('value', taggedCb, ctx3);
    ref.on('value', taggedCb);
    await tick();
    ctxSeen.length = 0;

    ref.off('value', taggedCb, ctx1);
    await ref.set({ a: 3 });
    await tick();
    expect(ctxSeen).toEqual(['c2', 'c3', 'unbound']);

    ctxSeen.length = 0;
    ref.off('value', taggedCb);
    await ref.set({ a: 4 });
    await tick();
    expect(ctxSeen).toEqual(['c2', 'c3']);
    ref.off('value');
  });
});
