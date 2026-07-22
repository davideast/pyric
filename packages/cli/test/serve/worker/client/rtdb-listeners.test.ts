/** RTDB worker-client value and child listener behavior. */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  limitToFirst as rtdbLimitToFirst,
  orderByChild as rtdbOrderByChild,
  orderByPriority as rtdbOrderByPriority,
  query as buildRtdbQuery,
} from 'pyric/database';
import * as client from '../../../../src/serve/worker/index.js';
import { connectClient, sleep } from '../integration-support.js';

describe('RTDB worker listeners', () => {
  let restoreSW: () => void;

  beforeEach(() => {
    const previous = (globalThis as { SharedWorker?: unknown }).SharedWorker;
    restoreSW = () => { (globalThis as { SharedWorker?: unknown }).SharedWorker = previous; };
  });
  afterEach(() => restoreSW());

  it('derives child_added and child_changed through the shared-worker client', async () => {
    const { db } = await connectClient();
    const rtdb = client.rtdbGetDatabase(db);
    const scores = client.rtdbRef(rtdb, 'scores');
    await client.rtdbSet(scores, { ada: { value: 7 } });

    const added: Array<{ key: string | null; value: unknown }> = [];
    const changed: Array<{ key: string | null; value: unknown }> = [];
    const unsubscribeAdded = client.rtdbOnChildAdded(scores, (snap) => {
      added.push({ key: snap.key, value: snap.val() });
    });
    const unsubscribeChanged = client.rtdbOnChildChanged(scores, (snap) => {
      changed.push({ key: snap.key, value: snap.val() });
    });
    await sleep();

    expect(added).toEqual([{ key: 'ada', value: { value: 7 } }]);
    expect(changed).toEqual([]);

    await client.rtdbSet(client.rtdbChild(scores, 'grace'), { value: 9 });
    await sleep();
    expect(added.at(-1)).toEqual({ key: 'grace', value: { value: 9 } });
    expect(changed).toEqual([]);

    await client.rtdbSet(client.rtdbChild(scores, 'ada'), { value: 8 });
    await sleep();
    expect(changed).toEqual([{ key: 'ada', value: { value: 8 } }]);

    await client.rtdbRemove(client.rtdbChild(scores, 'grace'));
    await sleep();
    expect(changed).toEqual([{ key: 'ada', value: { value: 8 } }]);

    unsubscribeAdded();
    unsubscribeChanged();
    await client.rtdbSet(client.rtdbChild(scores, 'lin'), { value: 10 });
    await client.rtdbSet(client.rtdbChild(scores, 'ada'), { value: 11 });
    await sleep();
    expect(added).toHaveLength(2);
    expect(changed).toHaveLength(1);
  });

  it('preserves numeric children and ignores object field order', async () => {
    const { db } = await connectClient();
    const rtdb = client.rtdbGetDatabase(db);
    const rows = client.rtdbRef(rtdb, 'rows');
    await client.rtdbSet(rows, ['zero', 'one', 'two']);

    const added: string[] = [];
    const changed: unknown[] = [];
    const unsubscribeAdded = client.rtdbOnChildAdded(rows, (snap) => added.push(snap.key ?? ''));
    const unsubscribeChanged = client.rtdbOnChildChanged(rows, (snap) => changed.push(snap.val()));
    await sleep();
    expect(added).toEqual(['0', '1', '2']);

    await client.rtdbSet(client.rtdbChild(rows, '1'), { a: 1, b: 2 });
    await sleep();
    expect(changed).toEqual([{ a: 1, b: 2 }]);
    await client.rtdbSet(client.rtdbChild(rows, '1'), { b: 2, a: 1 });
    await sleep();
    expect(changed).toHaveLength(1);

    unsubscribeAdded();
    unsubscribeChanged();
  });

  it('delivers the complete initial child_added batch for onlyOnce', async () => {
    const { db } = await connectClient();
    const rtdb = client.rtdbGetDatabase(db);
    const rows = client.rtdbRef(rtdb, 'only-once-rows');
    await client.rtdbSet(rows, { a: 1, b: 2 });

    const seen: string[] = [];
    client.rtdbOnChildAdded(rows, (snapshot) => seen.push(snapshot.key!), { onlyOnce: true });
    await sleep();
    await client.rtdbSet(client.rtdbChild(rows, 'c'), 3);
    await sleep();

    expect(seen).toEqual(['b', 'a']);
    expect(seen).not.toContain('c');

    const deliveredDespiteThrow: string[] = [];
    client.rtdbOnChildAdded(rows, (snapshot) => {
      deliveredDespiteThrow.push(snapshot.key!);
      throw new Error('listener failure');
    }, { onlyOnce: true });
    await sleep();
    expect(deliveredDespiteThrow).toEqual(['c', 'b', 'a']);
  });

  it('isolates thrown value callbacks from sibling listeners', async () => {
    const { db } = await connectClient();
    const target = client.rtdbRef(client.rtdbGetDatabase(db), 'value-callback-isolation');
    await client.rtdbSet(target, 0);

    const delivered: unknown[] = [];
    const stopThrowing = client.rtdbOnValue(target, () => {
      throw new Error('listener failure');
    });
    const stopControl = client.rtdbOnValue(target, (snapshot) => delivered.push(snapshot.val()));
    await sleep();
    await client.rtdbSet(target, 1);
    await sleep();

    expect(delivered).toEqual([0, 1]);
    stopThrowing();
    stopControl();
  });

  it('removes duplicate callbacks one registration at a time and scopes query off', async () => {
    const { db } = await connectClient();
    const rtdb = client.rtdbGetDatabase(db);
    const target = client.rtdbRef(rtdb, 'off-semantics/value');
    await client.rtdbSet(target, 0);
    const values: unknown[] = [];
    const callback = (snapshot: client.RtdbDataSnapshot) => values.push(snapshot.val());
    client.rtdbOnValue(target, callback);
    client.rtdbOnValue(target, callback);
    await sleep();
    await client.rtdbSet(target, 1);
    await sleep();
    client.rtdbOff(target, 'value', callback);
    await client.rtdbSet(target, 2);
    await sleep();
    client.rtdbOff(target, 'value', callback);
    await client.rtdbSet(target, 3);
    await sleep();
    expect(values).toEqual([0, 0, 1, 1, 2]);

    const rows = client.rtdbRef(rtdb, 'off-semantics/rows');
    await client.rtdbSet(rows, { a: { rank: 1 }, b: { rank: 2 } });
    const ordered = buildRtdbQuery(rows as never, rtdbOrderByChild('rank'), rtdbLimitToFirst(2));
    const reorderedEquivalent = buildRtdbQuery(rows as never, rtdbLimitToFirst(2), rtdbOrderByChild('rank'));
    const defaultValues: unknown[] = [];
    const orderedValues: unknown[] = [];
    client.rtdbOnValue(rows, (snapshot) => defaultValues.push(snapshot.val()));
    client.rtdbOnValue(ordered as never, (snapshot) => orderedValues.push(snapshot.val()));
    await sleep();
    client.rtdbOff(reorderedEquivalent as never);
    await client.rtdbSet(client.rtdbChild(rows, 'c'), { rank: 3 });
    await sleep();
    expect(defaultValues).toHaveLength(2);
    expect(orderedValues).toHaveLength(1);

    const defaultQuery = buildRtdbQuery(rows as never);
    client.rtdbOnValue(rows, (snapshot) => defaultValues.push(snapshot.val()));
    await sleep();
    client.rtdbOff(defaultQuery as never);
    await client.rtdbSet(client.rtdbChild(rows, 'default-query-control'), true);
    await sleep();
    expect(defaultValues).toHaveLength(3);
    client.rtdbOff(rows);
    await client.rtdbSet(client.rtdbChild(rows, 'd'), { rank: 4 });
    await sleep();
    expect(defaultValues).toHaveLength(3);
  });

  it('reports priority window changes, child movement, and removed snapshots', async () => {
    const { db } = await connectClient();
    const rtdb = client.rtdbGetDatabase(db);
    const scores = client.rtdbRef(rtdb, 'listener-priorities');
    await client.rtdbSetWithPriority(client.rtdbChild(scores, 'ada'), { score: 7 }, 20);
    await client.rtdbSetWithPriority(client.rtdbChild(scores, 'grace'), { score: 9 }, 10);
    await client.rtdbSetWithPriority(client.rtdbChild(scores, 'lin'), { score: 11 }, 30);

    const priorityWindow = buildRtdbQuery(scores as never, rtdbOrderByPriority(), rtdbLimitToFirst(2));
    const valueWindows: string[][] = [];
    const moved: Array<{ key: string | null; previous: string | null }> = [];
    const removed: Array<{ key: string | null; value: unknown; previous: string | null }> = [];
    const stopValue = client.rtdbOnValue(priorityWindow as never, (snapshot) => {
      const keys: string[] = [];
      snapshot.forEach((child) => { keys.push(child.key!); });
      valueWindows.push(keys);
    });
    const priorityOrder = buildRtdbQuery(scores as never, rtdbOrderByPriority());
    const stopMoved = client.rtdbOnChildMoved(
      priorityOrder as never,
      (snapshot, previous) => moved.push({ key: snapshot.key, previous }),
    );
    const stopRemoved = client.rtdbOnChildRemoved(scores, (snapshot, previous) => removed.push({
      key: snapshot.key, value: snapshot.val(), previous,
    }));
    await sleep();

    await client.rtdbSetPriority(client.rtdbChild(scores, 'ada'), 5);
    await sleep();
    expect(valueWindows.at(-1)).toEqual(['ada', 'grace']);
    expect(moved).toEqual([{ key: 'ada', previous: null }]);

    await client.rtdbSetPriority(client.rtdbChild(scores, 'lin'), 25);
    await sleep();
    expect(moved).toEqual([
      { key: 'ada', previous: null },
      { key: 'lin', previous: 'grace' },
    ]);

    await client.rtdbRemove(client.rtdbChild(scores, 'grace'));
    await sleep();
    expect(removed).toEqual([{ key: 'grace', value: { score: 9 }, previous: 'ada' }]);

    stopValue();
    stopMoved();
    stopRemoved();
  });
});
