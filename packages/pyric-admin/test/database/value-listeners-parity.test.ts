import { afterEach, describe, expect, it } from 'bun:test';
import { initializeSandbox, type Sandbox } from 'pyric/sandbox';
import {
  getDatabase as getClientDatabase,
  ref as clientRef,
  sandbox as databaseSandbox,
  set as clientSet,
  setWithPriority as clientSetWithPriority,
  type RtdbRulesSource,
} from 'pyric/database';
import { deleteApp, getApps, initializeApp, type PyricAdminApp } from '../../src/app/index.js';
import {
  getDatabase,
  getDatabaseWithUrl,
  type DataSnapshot,
} from '../../src/database/index.js';
import { sharedWorkerArm } from './arms.js';

function tick(ms = 25): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

afterEach(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app)));
});

interface ArmHarness {
  readonly label: 'in-process' | 'remote';
  readonly app: PyricAdminApp;
  readonly host: Sandbox;
}

function createArms(): ArmHarness[] {
  const localSandbox = initializeSandbox({ projectId: 'demo-proj' });
  databaseSandbox.setDefaultPolicy(getClientDatabase(localSandbox), 'allow');
  const localApp = initializeApp({ sandbox: localSandbox, projectId: 'demo-proj' }, 'val-listen-local');
  const { app: remoteApp, host: remoteHost } = sharedWorkerArm();
  return [
    { label: 'in-process', app: localApp, host: localSandbox },
    { label: 'remote', app: remoteApp, host: remoteHost },
  ];
}

function setRules(host: Sandbox, rules: RtdbRulesSource): void {
  databaseSandbox.setRules(getClientDatabase(host), rules);
}

function keysOf(snap: DataSnapshot): string[] {
  const out: string[] = [];
  snap.forEach((child) => {
    if (child.key !== null) out.push(child.key);
  });
  return out;
}

describe("pyric-admin/database — on('value') and off() parity", () => {
  it('delivers initial state (absent and present) and subsequent admin + client mutations on plain refs', async () => {
    for (const { app, host } of createArms()) {
      const db = getDatabase(app);
      const clientDb = getClientDatabase(host);
      const ref = db.ref('counters/main');

      const seen: Array<{ exists: boolean; val: unknown }> = [];
      const handler = (snap: DataSnapshot): void => {
        seen.push({ exists: snap.exists(), val: snap.val() });
      };

      const returned = ref.on('value', handler);
      expect(returned).toBe(handler);
      await tick();
      expect(seen).toEqual([{ exists: false, val: null }]);

      await ref.set({ count: 1 });
      await tick();
      await ref.update({ count: 2, tag: 'v2' });
      await tick();
      await clientSet(clientRef(clientDb, 'counters/main/count'), 3);
      await tick();
      await ref.remove();
      await tick();

      expect(seen).toEqual([
        { exists: false, val: null },
        { exists: true, val: { count: 1 } },
        { exists: true, val: { count: 2, tag: 'v2' } },
        { exists: true, val: { count: 3, tag: 'v2' } },
        { exists: false, val: null },
      ]);

      ref.off('value', handler);
      await ref.set({ count: 99 });
      await tick();
      expect(seen).toHaveLength(5);
    }
  });

  it('delivers query-ordered snapshots on queried value listeners and ignores writes outside the active window', async () => {
    for (const { app, host } of createArms()) {
      const db = getDatabase(app);
      const clientDb = getClientDatabase(host);
      await db.ref('items').set({
        a: { score: 10 },
        b: { score: 30 },
        c: { score: 20 },
      });

      const q = db.ref('items').orderByChild('score').limitToFirst(2);
      const windows: string[][] = [];
      const cb = q.on('value', (snap) => {
        windows.push(keysOf(snap));
      });
      await tick();
      expect(windows).toEqual([['a', 'c']]);

      // Write outside the top-2 lowest-score window: must NOT re-fire.
      await db.ref('items/d').set({ score: 50 });
      await db.ref('items/b').update({ score: 40 });
      await tick();
      expect(windows).toEqual([['a', 'c']]);

      // Write that enters and reorders the window: MUST re-fire with new query order.
      await db.ref('items/e').set({ score: 5 });
      await tick();
      expect(windows).toEqual([
        ['a', 'c'],
        ['e', 'a'],
      ]);

      // Priority-ordered query listener reflects priorities cleanly.
      await clientSetWithPriority(clientRef(clientDb, 'ranked/x'), 'first', 20);
      await clientSetWithPriority(clientRef(clientDb, 'ranked/y'), 'second', 5);
      const prioWindows: string[][] = [];
      const prioQuery = db.ref('ranked').orderByPriority();
      prioQuery.on('value', (snap) => {
        prioWindows.push(keysOf(snap));
      });
      await tick();
      expect(prioWindows).toEqual([['y', 'x']]);

      q.off('value', cb);
      prioQuery.off('value');
    }
  });

  it('isolates queries across all four off() overloads while preserving plain-ref clear-all semantics', async () => {
    for (const { app } of createArms()) {
      const db = getDatabase(app);
      const base = db.ref('tasks');
      await base.set({
        t1: { rank: 1 },
        t2: { rank: 2 },
        t3: { rank: 3 },
      });

      const qFirst = base.orderByChild('rank').limitToFirst(2);
      const qFirstEquivalent = base.limitToFirst(2).orderByChild('rank');
      const qLast = base.orderByChild('rank').limitToLast(2);

      // Overload 4: off('value', callback, context) — scoped to (path, queryId, eventType, cb, ctx).
      const ctxA = { id: 'A' };
      const ctxB = { id: 'B' };
      const hits: string[] = [];
      function shared(this: { id?: string } | undefined, snap: DataSnapshot): void {
        hits.push(`${this?.id ?? 'none'}:${keysOf(snap).join(',')}`);
      }

      qFirst.on('value', shared, ctxA);
      qFirst.on('value', shared, ctxB);
      qLast.on('value', shared, ctxA);
      await tick();
      hits.length = 0;

      // Detach (shared, ctxA) ONLY on qFirst; (shared, ctxB) on qFirst and (shared, ctxA) on qLast remain!
      qFirst.off('value', shared, ctxA);
      await base.child('t1').update({ rank: 0 });
      await base.child('t3').update({ rank: 4 });
      await tick();
      expect(hits.filter((h) => h.startsWith('A:t1,t2'))).toEqual([]);
      expect(hits.some((h) => h.startsWith('B:t1,t2'))).toBe(true);
      expect(hits.some((h) => h.startsWith('A:t2,t3'))).toBe(true);

      // Overload 3: off('value', callback) (no context) — detaches context-bound + context-less cb on qFirst only.
      qFirst.on('value', shared);
      const otherFirstHits: number[] = [];
      const otherCb = (): void => {
        otherFirstHits.push(1);
      };
      qFirst.on('value', otherCb);
      await tick();
      hits.length = 0;
      otherFirstHits.length = 0;

      qFirst.off('value', shared);
      await base.child('t1').update({ rank: -1 });
      await base.child('t3').update({ rank: 5 });
      await tick();
      // Neither ctxB nor context-less `shared` on qFirst fired, while `otherCb` on qFirst and `shared` on qLast still fired!
      expect(hits.every((h) => h.startsWith('A:t2,t3'))).toBe(true);
      expect(hits.length).toBeGreaterThan(0);
      expect(otherFirstHits.length).toBeGreaterThan(0);

      // Overload 2: q.off('value') (via constraint-order-equivalent query) detaches qFirst only, leaving qLast and base active!
      const baseHits: number[] = [];
      base.on('value', () => {
        baseHits.push(1);
      });
      await tick();
      hits.length = 0;
      otherFirstHits.length = 0;
      baseHits.length = 0;

      qFirstEquivalent.off('value');
      await base.child('t1').update({ rank: -2 });
      await base.child('t3').update({ rank: 6 });
      await tick();
      expect(otherFirstHits).toEqual([]);
      expect(hits.length).toBeGreaterThan(0);
      expect(baseHits.length).toBeGreaterThan(0);

      // Overload 1 on a constrained query: qLast.off() detaches qLast only, leaving base active!
      hits.length = 0;
      baseHits.length = 0;
      qLast.off();
      await base.child('t3').update({ rank: 7 });
      await tick();
      expect(hits).toEqual([]);
      expect(baseHits.length).toBeGreaterThan(0);

      // Plain unconstrained ref.off() clears listeners across ALL query views at that path (upstream Firebase contract).
      const reattachedQueryHits: number[] = [];
      qFirst.on('value', () => {
        reattachedQueryHits.push(1);
      });
      await tick();
      reattachedQueryHits.length = 0;
      baseHits.length = 0;

      base.off();
      await base.child('t1').update({ rank: -3 });
      await tick();
      expect(reattachedQueryHits).toEqual([]);
      expect(baseHits).toEqual([]);
    }
  });

  it('supports 3-arg and 4-arg context binding and synchronous re-entrant off() inside callbacks', async () => {
    for (const { app } of createArms()) {
      const db = getDatabase(app);
      const ref = db.ref('reentrant/item');
      await ref.set({ step: 1 });

      // 4-arg on('value', cb, cancelCb, ctx) binds `this` on the value callback.
      const ctx4 = { label: 'four-arg' };
      const observed4: string[] = [];
      const cb4 = ref.on(
        'value',
        function onVal(this: { label?: string } | undefined, snap: DataSnapshot) {
          observed4.push(`${this?.label}:${(snap.val() as { step: number }).step}`);
        },
        function onCancel() {},
        ctx4,
      );
      await tick();
      expect(observed4).toEqual(['four-arg:1']);
      ref.off('value', cb4, ctx4);

      // Re-entrant off() inside initial fire prevents any subsequent delivery.
      const selfDetachingHits: unknown[] = [];
      const selfCb = (snap: DataSnapshot): void => {
        selfDetachingHits.push(snap.val());
        ref.off('value', selfCb);
      };
      ref.on('value', selfCb);
      await tick();
      await ref.set({ step: 2 });
      await tick();
      expect(selfDetachingHits).toEqual([{ step: 1 }]);

      // If callback A synchronously calls off() for sibling callback B during a fanout, B does not receive that update.
      const order: string[] = [];
      const cbB = (): void => {
        order.push('B');
      };
      const cbA = (snap: DataSnapshot): void => {
        const val = snap.val() as { step: number } | null;
        order.push(`A:${val?.step}`);
        if (val?.step === 3) {
          ref.off('value', cbB);
        }
      };
      ref.on('value', cbA);
      ref.on('value', cbB);
      await tick();
      order.length = 0;

      await ref.set({ step: 3 });
      await tick();
      expect(order).toEqual(['A:3']);
      ref.off();
    }
  });

  it('bypasses .read: false rules (including unindexed query listeners) and isolates shard instances', async () => {
    const shardUrl = 'https://demo-proj-shard.firebaseio.com';
    for (const { app, host } of createArms()) {
      const primary = getDatabase(app);
      const shard = getDatabaseWithUrl(shardUrl, app);

      await primary.ref('items').set({ a: { score: 2 }, b: { score: 1 } });
      await shard.ref('items').set({ s1: { score: 10 } });
      setRules(host, { rules: { '.read': false, '.write': false } });

      const primarySeen: string[][] = [];
      const shardSeen: string[][] = [];
      const primaryQ = primary.ref('items').orderByChild('score').limitToFirst(1);
      const shardRef = shard.ref('items');

      primaryQ.on('value', (s) => primarySeen.push(keysOf(s)));
      shardRef.on('value', (s) => shardSeen.push(keysOf(s)));
      await tick();

      expect(primarySeen).toEqual([['b']]);
      expect(shardSeen).toEqual([['s1']]);

      // Mutating shard does not wake primary listener, and mutating primary does not wake shard listener.
      await shard.ref('items/s2').set({ score: 5 });
      await tick();
      expect(primarySeen).toEqual([['b']]);
      expect(shardSeen).toEqual([['s1'], ['s1', 's2']]);

      await primary.ref('items/c').set({ score: 0 });
      await tick();
      expect(primarySeen).toEqual([['b'], ['c']]);
      expect(shardSeen).toEqual([['s1'], ['s1', 's2']]);

      primaryQ.off();
      shardRef.off();
    }
  });
});
