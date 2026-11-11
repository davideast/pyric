import { afterEach, describe, expect, it } from 'bun:test';
import { initializeSandbox, type Sandbox } from 'pyric/sandbox';
import {
  getDatabase as getClientDatabase,
  ref as clientRef,
  sandbox as databaseSandbox,
  setPriority as clientSetPriority,
  setWithPriority as clientSetWithPriority,
  type RtdbRulesSource,
} from 'pyric/database';
import { deleteApp, getApps, initializeApp, type PyricAdminApp } from '../../src/app/index.js';
import {
  getDatabase,
  getDatabaseWithUrl,
  ServerValue,
  type DataSnapshot,
  type Query,
} from '../../src/database/index.js';
import { inProcessApp, sharedWorkerArm } from './arms.js';

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
  const localApp = initializeApp({ sandbox: localSandbox, projectId: 'demo-proj' }, 'queries-local');
  const { app: remoteApp, host: remoteHost } = sharedWorkerArm();
  return [
    { label: 'in-process', app: localApp, host: localSandbox },
    { label: 'remote', app: remoteApp, host: remoteHost },
  ];
}

function setRules(host: Sandbox, rules: RtdbRulesSource, instanceUrl?: string): void {
  databaseSandbox.setRules(getClientDatabase(host, instanceUrl), rules);
}

function keysOf(snap: DataSnapshot): string[] {
  const keys: string[] = [];
  snap.forEach((child) => {
    if (child.key !== null) keys.push(child.key);
  });
  return keys;
}

async function queryKeys(target: Query): Promise<{ getKeys: string[]; onceKeys: string[] }> {
  const [getSnap, onceSnap] = await Promise.all([target.get(), target.once('value')]);
  return { getKeys: keysOf(getSnap), onceKeys: keysOf(onceSnap) };
}

describe('pyric-admin/database — queries and one-shot reads parity', () => {
  it('orders and filters with orderByChild (including nested paths, nulls, ties, bounds, and limits) across get() and once("value")', async () => {
    for (const { app, host } of createArms()) {
      setRules(host, {
        rules: {
          '.read': true,
          '.write': true,
          items: { '.indexOn': ['score', 'meta/rank'] },
        },
      });
      const db = getDatabase(app);
      await db.ref('items').set({
        d: { score: 20, meta: { rank: 2 } },
        b: { score: 10, meta: { rank: 4 } },
        a: { score: 20, meta: { rank: 1 } },
        c: { meta: { rank: 3 } },
        e: { score: 30, meta: { rank: 5 } },
      });

      const base = db.ref('items');

      // Full child order: missing field sorts as null first, ties break by key ('a' before 'd').
      expect(await queryKeys(base.orderByChild('score'))).toEqual({
        getKeys: ['c', 'b', 'a', 'd', 'e'],
        onceKeys: ['c', 'b', 'a', 'd', 'e'],
      });

      // Nested child path ordering.
      expect(await queryKeys(base.orderByChild('meta/rank'))).toEqual({
        getKeys: ['a', 'd', 'c', 'b', 'e'],
        onceKeys: ['a', 'd', 'c', 'b', 'e'],
      });

      // Inclusive range: startAt + endAt.
      expect(await queryKeys(base.orderByChild('score').startAt(10).endAt(20))).toEqual({
        getKeys: ['b', 'a', 'd'],
        onceKeys: ['b', 'a', 'd'],
      });

      // Exclusive range: startAfter + endBefore.
      expect(await queryKeys(base.orderByChild('score').startAfter(10).endBefore(30))).toEqual({
        getKeys: ['a', 'd'],
        onceKeys: ['a', 'd'],
      });

      // Two-argument cursor key tie-breaking on tied child values (score === 20 for 'a' and 'd').
      expect(await queryKeys(base.orderByChild('score').startAt(20, 'd'))).toEqual({
        getKeys: ['d', 'e'],
        onceKeys: ['d', 'e'],
      });
      expect(await queryKeys(base.orderByChild('score').startAfter(20, 'a'))).toEqual({
        getKeys: ['d', 'e'],
        onceKeys: ['d', 'e'],
      });
      expect(await queryKeys(base.orderByChild('score').endAt(20, 'a'))).toEqual({
        getKeys: ['c', 'b', 'a'],
        onceKeys: ['c', 'b', 'a'],
      });
      expect(await queryKeys(base.orderByChild('score').endBefore(20, 'd'))).toEqual({
        getKeys: ['c', 'b', 'a'],
        onceKeys: ['c', 'b', 'a'],
      });

      // equalTo(value) returns all matching children; equalTo(value, key) narrows to exact cursor.
      expect(await queryKeys(base.orderByChild('score').equalTo(20))).toEqual({
        getKeys: ['a', 'd'],
        onceKeys: ['a', 'd'],
      });
      expect(await queryKeys(base.orderByChild('score').equalTo(20, 'd'))).toEqual({
        getKeys: ['d'],
        onceKeys: ['d'],
      });

      // limitToFirst and limitToLast preserve ascending query order within the truncated window.
      expect(await queryKeys(base.orderByChild('meta/rank').limitToFirst(2))).toEqual({
        getKeys: ['a', 'd'],
        onceKeys: ['a', 'd'],
      });
      expect(await queryKeys(base.orderByChild('meta/rank').limitToLast(2))).toEqual({
        getKeys: ['b', 'e'],
        onceKeys: ['b', 'e'],
      });

      // Positive Infinity limits are accepted and keep the entire matching window over wire and locally.
      expect(await queryKeys(base.orderByChild('meta/rank').limitToFirst(Number.POSITIVE_INFINITY))).toEqual({
        getKeys: ['a', 'd', 'c', 'b', 'e'],
        onceKeys: ['a', 'd', 'c', 'b', 'e'],
      });
      expect(await queryKeys(base.orderByChild('meta/rank').limitToLast(Number.POSITIVE_INFINITY))).toEqual({
        getKeys: ['a', 'd', 'c', 'b', 'e'],
        onceKeys: ['a', 'd', 'c', 'b', 'e'],
      });

      // Undefined on startAt / endAt normalizes to null lower/upper endpoints.
      expect(await queryKeys(base.orderByChild('score').startAt(undefined).endAt(10))).toEqual({
        getKeys: ['c', 'b'],
        onceKeys: ['c', 'b'],
      });
      expect(await queryKeys(base.orderByChild('score').startAt(20).endAt(undefined))).toEqual({
        getKeys: [],
        onceKeys: [],
      });
    }
  });

  it('orders with orderByKey (numeric keys before lexical keys), orderByValue, orderByPriority, and default priority order', async () => {
    for (const { app, host } of createArms()) {
      setRules(host, {
        rules: {
          '.read': true,
          '.write': true,
          scores: { '.indexOn': '.value' },
        },
      });
      const db = getDatabase(app);

      // orderByKey: canonical 32-bit integer keys sort numerically before lexicographic string keys.
      await db.ref('byKey').set({ b: 1, '10': 2, '2': 3, a: 4, c: 5 });
      expect(await queryKeys(db.ref('byKey').orderByKey())).toEqual({
        getKeys: ['2', '10', 'a', 'b', 'c'],
        onceKeys: ['2', '10', 'a', 'b', 'c'],
      });
      expect(await queryKeys(db.ref('byKey').orderByKey().startAfter('2').endBefore('c'))).toEqual({
        getKeys: ['10', 'a', 'b'],
        onceKeys: ['10', 'a', 'b'],
      });
      expect(await queryKeys(db.ref('byKey').orderByKey().equalTo('a'))).toEqual({
        getKeys: ['a'],
        onceKeys: ['a'],
      });

      // orderByValue: boolean < number < string, ties broken by key.
      await db.ref('scores').set({
        s2: 'beta',
        n2: 5,
        b1: false,
        n1: 5,
        s1: 'alpha',
        b2: true,
        n0: -3,
      });
      expect(await queryKeys(db.ref('scores').orderByValue())).toEqual({
        getKeys: ['b1', 'b2', 'n0', 'n1', 'n2', 's1', 's2'],
        onceKeys: ['b1', 'b2', 'n0', 'n1', 'n2', 's1', 's2'],
      });
      expect(await queryKeys(db.ref('scores').orderByValue().equalTo(5))).toEqual({
        getKeys: ['n1', 'n2'],
        onceKeys: ['n1', 'n2'],
      });
      expect(await queryKeys(db.ref('scores').orderByValue().startAt(5, 'n2').limitToFirst(2))).toEqual({
        getKeys: ['n2', 's1'],
        onceKeys: ['n2', 's1'],
      });

      // orderByPriority and default order (limit without explicit orderBy*) using client-seeded priorities.
      const clientDb = getClientDatabase(host);
      await clientSetWithPriority(clientRef(clientDb, 'ranked/k1'), { label: 'one' }, 30);
      await clientSetWithPriority(clientRef(clientDb, 'ranked/k2'), { label: 'two' }, 10);
      await db.ref('ranked/k3').set({ label: 'no-prio' });
      await clientSetWithPriority(clientRef(clientDb, 'ranked/k4'), { label: 'str-prio' }, 'high');
      await clientSetPriority(clientRef(clientDb, 'ranked'), 'root-prio');

      expect(await queryKeys(db.ref('ranked').orderByPriority())).toEqual({
        getKeys: ['k3', 'k2', 'k1', 'k4'],
        onceKeys: ['k3', 'k2', 'k1', 'k4'],
      });
      expect(await queryKeys(db.ref('ranked').orderByPriority().startAt(10).endAt(30))).toEqual({
        getKeys: ['k2', 'k1'],
        onceKeys: ['k2', 'k1'],
      });
      expect(await queryKeys(db.ref('ranked').limitToFirst(2))).toEqual({
        getKeys: ['k3', 'k2'],
        onceKeys: ['k3', 'k2'],
      });

      const windowed = await db.ref('ranked').orderByPriority().startAt(10).limitToFirst(1).get();
      expect(windowed.getPriority()).toBe('root-prio');
      expect(windowed.exportVal()).toEqual({
        '.priority': 'root-prio',
        k2: { '.priority': 10, label: 'two' },
      });
      expect(windowed.child('k2').getPriority()).toBe(10);
      expect(windowed.child('k1').exists()).toBe(false);
    }
  });

  it('produces query-ordered DataSnapshots with windowed child/exportVal/val semantics, early-exit forEach, and empty-window parity', async () => {
    for (const { app, host } of createArms()) {
      setRules(host, {
        rules: {
          '.read': true,
          '.write': true,
          indexed: { '.indexOn': ['weight'] },
        },
      });
      const db = getDatabase(app);

      // Integer-looking keys ordered by child field: forEach follows query order while val() renders windowed children.
      await db.ref('indexed').set({
        0: { weight: 30 },
        1: { weight: 10 },
        2: { weight: 20 },
        3: { weight: 40 },
      });

      const q = db.ref('indexed').orderByChild('weight').limitToFirst(3);
      const snap = await q.get();
      expect(snap.key).toBe('indexed');
      expect(snap.exists()).toBe(true);
      expect(snap.hasChildren()).toBe(true);
      expect(snap.numChildren()).toBe(3);
      expect(snap.hasChild('1')).toBe(true);
      expect(snap.hasChild('3')).toBe(false);
      expect(snap.child('3').exists()).toBe(false);
      expect(snap.child('1/weight').val()).toBe(10);
      expect(snap.val()).toEqual([{ weight: 30 }, { weight: 10 }, { weight: 20 }]);
      expect(snap.exportVal()).toEqual({
        0: { weight: 30 },
        1: { weight: 10 },
        2: { weight: 20 },
      });
      expect(keysOf(snap)).toEqual(['1', '2', '0']);

      // Early exit when forEach callback returns strict true.
      const visited: string[] = [];
      const canceled = snap.forEach((child) => {
        visited.push(child.key!);
        return child.key === '2';
      });
      expect(canceled).toBe(true);
      expect(visited).toEqual(['1', '2']);
      expect(snap.forEach(() => false)).toBe(false);

      // snap.ref is a plain Reference at the queried location, not the constrained Query.
      expect(snap.ref.isEqual(db.ref('indexed'))).toBe(true);
      expect(snap.ref.isEqual(q)).toBe(false);
      await snap.ref.child('4').set({ weight: 5 });

      // once('value') invokes success callback with bound context and resolves the same ordered snapshot.
      const ctx = { prefix: 'seen' };
      const callbackKeys: string[] = [];
      const onceSnap = await db.ref('indexed').orderByChild('weight').limitToFirst(2).once(
        'value',
        function onSnap(s) {
          s.forEach((c) => {
            callbackKeys.push(`${this.prefix}:${c.key}`);
          });
        },
        ctx,
      );
      expect(callbackKeys).toEqual(['seen:4', 'seen:1']);
      expect(keysOf(onceSnap)).toEqual(['4', '1']);

      // Empty query window produces a non-existent null snapshot.
      const empty = await db.ref('indexed').orderByChild('weight').equalTo(999).get();
      expect(empty.key).toBe('indexed');
      expect(empty.exists()).toBe(false);
      expect(empty.val()).toBeNull();
      expect(empty.exportVal()).toBeNull();
      expect(empty.getPriority()).toBeNull();
      expect(empty.numChildren()).toBe(0);
      expect(empty.hasChildren()).toBe(false);
      expect(empty.forEach(() => true)).toBe(false);
    }
  });

  it('keeps Query chains immutable and enforces Reference/Query isEqual, ref, toString, and toJSON contracts', async () => {
    for (const { label, app, host } of createArms()) {
      setRules(host, {
        rules: { '.read': true, '.write': true, tasks: { '.indexOn': ['step'] } },
      });
      const db = getDatabase(app);
      await db.ref('tasks').set({
        t1: { step: 1 },
        t2: { step: 2 },
        t3: { step: 3 },
      });

      const base = db.ref('tasks');
      const ordered = base.orderByChild('step');
      const firstOne = ordered.limitToFirst(1);
      const lastOne = ordered.limitToLast(1);

      // Chaining never mutates the base Reference or intermediate Query.
      expect(keysOf(await base.get())).toEqual(['t1', 't2', 't3']);
      expect(keysOf(await ordered.get())).toEqual(['t1', 't2', 't3']);
      expect(keysOf(await firstOne.get())).toEqual(['t1']);
      expect(keysOf(await lastOne.get())).toEqual(['t3']);

      // .ref returns an unconstrained Reference, .toString() / .toJSON() preserve the location URL.
      expect(firstOne.ref.isEqual(base)).toBe(true);
      expect(firstOne.ref.isEqual(firstOne)).toBe(false);
      expect(firstOne.toString()).toBe(base.toString());
      expect(firstOne.toJSON()).toBe(base.toJSON());

      // Query objects expose only Query surface, not Reference write methods.
      expect('set' in firstOne).toBe(false);
      expect('child' in firstOne).toBe(false);
      expect(typeof firstOne.ref.set).toBe('function');

      // isEqual ignores bound/orderBy/limit application order when specs match, and distinguishes distinct specs/paths/shards.
      const qA = base.orderByChild('step').startAt(1).endAt(3).limitToFirst(2);
      const qB = base.endAt(3).limitToFirst(2).startAt(1).orderByChild('step');
      expect(qA.isEqual(qB)).toBe(true);
      expect(qA.isEqual(base.orderByChild('step').startAt(1).endAt(3).limitToLast(2))).toBe(false);
      expect(base.isEqual(base.orderByKey())).toBe(false);
      expect(base.isEqual(base.orderByPriority())).toBe(false);
      expect(base.isEqual(db.ref('other'))).toBe(false);
      expect(base.isEqual(null)).toBe(false);

      const shard = getDatabaseWithUrl('https://demo-proj-shard.firebaseio.com', app);
      expect(base.isEqual(shard.ref('tasks'))).toBe(false);

      const secondAppSameSandbox = initializeApp(
        { sandbox: app.sandbox, projectId: app.options.projectId },
        `same-sandbox-${label}`,
      );
      expect(base.isEqual(getDatabase(secondAppSameSandbox).ref('tasks'))).toBe(true);

      const otherApp = inProcessApp();
      expect(base.isEqual(getDatabase(otherApp).ref('tasks'))).toBe(false);
    }
  });

  it('throws synchronously on invalid arguments and conflicting constraints across both arms', () => {
    for (const { app } of createArms()) {
      const ref = getDatabase(app).ref('items');

      // Conflicting orderings, bounds, and limits.
      expect(() => ref.orderByKey().orderByValue()).toThrow(/can't combine multiple orderBy/);
      expect(() => ref.orderByChild('a').orderByPriority()).toThrow(/can't combine multiple orderBy/);
      expect(() => ref.limitToFirst(1).limitToLast(1)).toThrow(/Limit was already set/);
      expect(() => ref.limitToFirst(1).limitToFirst(2)).toThrow(/Limit was already set/);
      expect(() => ref.startAt('a').startAfter('b')).toThrow(/Starting point was already set/);
      expect(() => ref.startAt('a').equalTo('a')).toThrow(/Starting point was already set/);
      expect(() => ref.endAt('z').endBefore('y')).toThrow(/Starting point was already set/);
      expect(() => ref.endAt('z').equalTo('z')).toThrow(/Ending point was already set/);

      // Invalid limits.
      for (const bad of [0, -1, 1.5, Number.NaN, Number.NEGATIVE_INFINITY, '2' as unknown as number]) {
        expect(() => ref.limitToFirst(bad)).toThrow(/First argument must be a positive integer/);
        expect(() => ref.limitToLast(bad)).toThrow(/First argument must be a positive integer/);
      }

      // Invalid orderByChild paths.
      expect(() => ref.orderByChild('$key')).toThrow(/Use orderByKey\(\) instead/);
      expect(() => ref.orderByChild('$value')).toThrow(/Use orderByValue\(\) instead/);
      expect(() => ref.orderByChild('$priority')).toThrow(/Use orderByPriority\(\) instead/);
      expect(() => ref.orderByChild('/')).toThrow(/cannot pass in empty path/);
      for (const badPath of ['', 'a.b', 'a#b', 'a$b', 'a[b', 'a]b']) {
        expect(() => ref.orderByChild(badPath)).toThrow(/invalid path/);
      }

      // Invalid cursor keys.
      for (const badKey of ['', 'bad/key', 'bad.key', 'bad$key']) {
        expect(() => ref.startAt('v', badKey)).toThrow(/invalid key/);
        expect(() => ref.startAfter('v', badKey)).toThrow(/invalid key/);
        expect(() => ref.endAt('v', badKey)).toThrow(/invalid key/);
        expect(() => ref.endBefore('v', badKey)).toThrow(/invalid key/);
        expect(() => ref.equalTo('v', badKey)).toThrow(/invalid key/);
      }

      // orderByKey endpoint restrictions independent of constraint chaining order.
      expect(() => ref.orderByKey().startAt(1)).toThrow(/must be a string/);
      expect(() => ref.startAt(1).orderByKey()).toThrow(/must be a string/);
      expect(() => ref.orderByKey().startAt('a', 'b')).toThrow(/only pass one argument/);
      expect(() => ref.startAt('a', 'b').orderByKey()).toThrow(/only pass one argument/);

      // Undefined and non-primitive endpoint rules.
      expect(() => ref.startAfter(undefined)).toThrow(/contains undefined/);
      expect(() => ref.endBefore(undefined)).toThrow(/contains undefined/);
      expect(() => ref.equalTo(undefined)).toThrow(/contains undefined/);
      expect(() => ref.orderByChild('x').startAt({ nested: 1 })).toThrow(/cannot be an object/);
      expect(() => ref.orderByValue().endAt({ nested: 1 })).toThrow(/cannot be an object/);
      expect(() => ref.orderByValue().startAt(Number.NaN)).toThrow();
      expect(() => ref.orderByPriority().startAt(false)).toThrow(/valid priority value/);
      expect(() => ref.orderByPriority().startAt(ServerValue.TIMESTAMP)).not.toThrow();
    }
  });

  it('bypasses .read: false while enforcing .indexOn on get() and delivering filtered windows on once("value")', async () => {
    for (const { app, host } of createArms()) {
      const db = getDatabase(app);
      await db.ref('items').set({
        a: { pos: 3 },
        b: { pos: 1 },
        c: { pos: 2 },
      });
      await db.ref('metrics').set({ m1: 9, m2: 2, m3: 5 });

      // Deny-all rules WITH no .indexOn declared.
      setRules(host, { rules: { '.read': false, '.write': false } });

      // get() rejects missing .indexOn on orderByChild and orderByValue (limited or unlimited), with no error.code.
      for (const unindexed of [
        db.ref('items').orderByChild('pos'),
        db.ref('items').orderByChild('pos').limitToFirst(2),
      ]) {
        const err = await unindexed.get().then(() => null, (caught: Error & { code?: unknown }) => caught);
        expect(err).toBeInstanceOf(Error);
        expect(err?.code).toBeUndefined();
        expect(err?.message).toBe('Index not defined, add ".indexOn": "pos", for path "/items", to the rules');
      }

      const valueErr = await db
        .ref('metrics')
        .orderByValue()
        .get()
        .then(() => null, (caught: Error & { code?: unknown }) => caught);
      expect(valueErr?.code).toBeUndefined();
      expect(valueErr?.message).toBe('Index not defined, add ".indexOn": ".value", for path "/metrics", to the rules');

      // orderByKey, orderByPriority, and default-order limits bypass .read: false and require no .indexOn.
      expect(keysOf(await db.ref('items').orderByKey().limitToLast(2).get())).toEqual(['b', 'c']);
      expect(keysOf(await db.ref('items').orderByPriority().limitToFirst(2).get())).toEqual(['a', 'b']);
      expect(keysOf(await db.ref('items').limitToFirst(2).get())).toEqual(['a', 'b']);

      // once('value') is a one-shot listen: it bypasses .read: false and resolves the filtered window even without .indexOn.
      const onceSnap = await db.ref('items').orderByChild('pos').limitToFirst(2).once('value');
      expect(keysOf(onceSnap)).toEqual(['b', 'c']);

      // Once .indexOn is added (still under .read: false), get() bypasses .read and succeeds!
      setRules(host, {
        rules: {
          '.read': false,
          '.write': false,
          items: { '.indexOn': ['pos'] },
          metrics: { '.indexOn': '.value' },
        },
      });
      expect(keysOf(await db.ref('items').orderByChild('pos').limitToFirst(2).get())).toEqual(['b', 'c']);
      expect(keysOf(await db.ref('metrics').orderByValue().limitToFirst(2).get())).toEqual(['m2', 'm3']);
    }
  });

  it('isolates queried reads across default and getDatabaseWithUrl shard instances', async () => {
    const shardUrl = 'https://demo-proj-shard.firebaseio.com';
    for (const { app, host } of createArms()) {
      const primary = getDatabase(app);
      const shard = getDatabaseWithUrl(shardUrl, app);

      await primary.ref('items').set({ p2: { n: 20 }, p1: { n: 10 } });
      await shard.ref('items').set({ s2: { n: 2 }, s1: { n: 1 } });

      setRules(host, { rules: { items: { '.indexOn': ['n'] } } });
      setRules(host, { rules: { items: { '.indexOn': ['n'] } } }, shardUrl);

      expect(await queryKeys(primary.ref('items').orderByChild('n'))).toEqual({
        getKeys: ['p1', 'p2'],
        onceKeys: ['p1', 'p2'],
      });
      expect(await queryKeys(shard.ref('items').orderByChild('n'))).toEqual({
        getKeys: ['s1', 's2'],
        onceKeys: ['s1', 's2'],
      });
    }
  });
});
