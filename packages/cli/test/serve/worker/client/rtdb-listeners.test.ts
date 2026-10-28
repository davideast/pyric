/**
 * RTDB worker-client value and child listener behavior.
 *
 * A check that nothing more was delivered waits on an answered call, never on
 * a delay. The host runs each message's RTDB work synchronously as the message
 * arrives (`dispatchMessage` in host/dispatch.ts): a `sub` posts its initial
 * snapshot from `handleRtdbSub`, and a write fans out to every listener inside
 * the sandbox write (`changed()` in pyric's write-plane) before `handleRtdbOp`
 * posts its reply. Each fake port delivers in FIFO order, and the client hands
 * a snapshot to its listener synchronously in `wirePort`'s onmessage. So once
 * a write or a later read is answered, every snapshot an earlier call caused
 * has already reached the application's callbacks.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  getDatabase,
  sandbox as databaseSandbox,
  limitToFirst as rtdbLimitToFirst,
  orderByChild as rtdbOrderByChild,
  orderByPriority as rtdbOrderByPriority,
  query as buildRtdbQuery,
} from 'pyric/database';
import * as client from '../../../../src/serve/worker/index.js';
import { connectClient, until } from '../integration-support.js';

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
    await until(() => added.length === 1, 'initial child_added');
    await client.rtdbGet(scores); // answered after the child_changed listener's initial snapshot

    expect(added).toEqual([{ key: 'ada', value: { value: 7 } }]);
    expect(changed).toEqual([]);

    await client.rtdbSet(client.rtdbChild(scores, 'grace'), { value: 9 });
    await until(() => added.length === 2, 'grace child_added');
    expect(added.at(-1)).toEqual({ key: 'grace', value: { value: 9 } });
    expect(changed).toEqual([]);

    await client.rtdbSet(client.rtdbChild(scores, 'ada'), { value: 8 });
    await until(() => changed.length >= 1, 'ada child_changed');
    expect(changed).toEqual([{ key: 'ada', value: { value: 8 } }]);

    await client.rtdbRemove(client.rtdbChild(scores, 'grace'));
    // Nothing to wait for: the awaited write's reply follows its fan-out (see the header).
    expect(changed).toEqual([{ key: 'ada', value: { value: 8 } }]);

    unsubscribeAdded();
    unsubscribeChanged();
    await client.rtdbSet(client.rtdbChild(scores, 'lin'), { value: 10 });
    await client.rtdbSet(client.rtdbChild(scores, 'ada'), { value: 11 });
    // Unsubscribing removed both listeners on the client synchronously; no snapshot reaches them.
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
    await until(() => added.length >= 3, 'initial numeric child_added');
    expect(added).toEqual(['0', '1', '2']);

    await client.rtdbSet(client.rtdbChild(rows, '1'), { a: 1, b: 2 });
    await until(() => changed.length >= 1, 'row 1 child_changed');
    expect(changed).toEqual([{ a: 1, b: 2 }]);
    await client.rtdbSet(client.rtdbChild(rows, '1'), { b: 2, a: 1 });
    // Nothing to wait for: the awaited write's reply follows its fan-out (see the header).
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
    await until(() => seen.length >= 2, 'initial onlyOnce child_added batch');
    await client.rtdbSet(client.rtdbChild(rows, 'c'), 3);
    // Nothing to wait for: the awaited write's reply follows its fan-out (see the header).

    expect(seen).toEqual(['b', 'a']);
    expect(seen).not.toContain('c');

    const deliveredDespiteThrow: string[] = [];
    client.rtdbOnChildAdded(rows, (snapshot) => {
      deliveredDespiteThrow.push(snapshot.key!);
      throw new Error('listener failure');
    }, { onlyOnce: true });
    await until(() => deliveredDespiteThrow.length >= 3, 'throwing onlyOnce child_added batch');
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
    await until(() => delivered.length >= 1, 'initial control value');
    await client.rtdbSet(target, 1);
    await until(() => delivered.length >= 2, 'control value after set');

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
    await until(() => values.length >= 2, 'initial duplicate values');
    await client.rtdbSet(target, 1);
    await until(() => values.length >= 4, 'duplicate values after set');
    client.rtdbOff(target, 'value', callback);
    await client.rtdbSet(target, 2);
    await until(() => values.length >= 5, 'remaining registration value');
    client.rtdbOff(target, 'value', callback);
    await client.rtdbSet(target, 3);
    // Nothing to wait for: the awaited write's reply follows its fan-out (see the header).
    expect(values).toEqual([0, 0, 1, 1, 2]);

    const rows = client.rtdbRef(rtdb, 'off-semantics/rows');
    await client.rtdbSet(rows, { a: { rank: 1 }, b: { rank: 2 } });
    const ordered = buildRtdbQuery(rows as never, rtdbOrderByChild('rank'), rtdbLimitToFirst(2));
    const reorderedEquivalent = buildRtdbQuery(rows as never, rtdbLimitToFirst(2), rtdbOrderByChild('rank'));
    const defaultValues: unknown[] = [];
    const orderedValues: unknown[] = [];
    client.rtdbOnValue(rows, (snapshot) => defaultValues.push(snapshot.val()));
    client.rtdbOnValue(ordered as never, (snapshot) => orderedValues.push(snapshot.val()));
    await until(() => defaultValues.length >= 1 && orderedValues.length >= 1, 'initial default and ordered values');
    client.rtdbOff(reorderedEquivalent as never);
    await client.rtdbSet(client.rtdbChild(rows, 'c'), { rank: 3 });
    await until(() => defaultValues.length >= 2, 'default value after set');
    expect(defaultValues).toHaveLength(2);
    expect(orderedValues).toHaveLength(1);

    const defaultQuery = buildRtdbQuery(rows as never);
    client.rtdbOnValue(rows, (snapshot) => defaultValues.push(snapshot.val()));
    await until(() => defaultValues.length >= 3, 'second default listener initial value');
    client.rtdbOff(defaultQuery as never);
    await client.rtdbSet(client.rtdbChild(rows, 'default-query-control'), true);
    // Nothing to wait for: the awaited write's reply follows its fan-out (see the header).
    expect(defaultValues).toHaveLength(3);
    client.rtdbOff(rows);
    await client.rtdbSet(client.rtdbChild(rows, 'd'), { rank: 4 });
    // Nothing to wait for: the awaited write's reply follows its fan-out (see the header).
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
    await until(() => valueWindows.length >= 1, 'initial priority window');

    await client.rtdbSetPriority(client.rtdbChild(scores, 'ada'), 5);
    await until(() => moved.length >= 1, 'ada child_moved');
    expect(valueWindows.at(-1)).toEqual(['ada', 'grace']);
    expect(moved).toEqual([{ key: 'ada', previous: null }]);

    await client.rtdbSetPriority(client.rtdbChild(scores, 'lin'), 25);
    await until(() => moved.length >= 2, 'lin child_moved');
    expect(moved).toEqual([
      { key: 'ada', previous: null },
      { key: 'lin', previous: 'grace' },
    ]);

    await client.rtdbRemove(client.rtdbChild(scores, 'grace'));
    await until(() => removed.length >= 1, 'grace child_removed');
    expect(removed).toEqual([{ key: 'grace', value: { score: 9 }, previous: null }]);

    stopValue();
    stopMoved();
    stopRemoved();
  });

  it('rejects an unindexed get, delivers the listener, and logs the index warning in the page', async () => {
    const { ctx, db } = await connectClient();
    databaseSandbox.setRules(getDatabase(ctx.sandbox), { rules: { scores: { '.read': true, '.write': true } } });
    const rtdb = client.rtdbGetDatabase(db);
    const scores = client.rtdbRef(rtdb, 'scores');
    await client.rtdbSet(scores, { ada: { pos: 3 }, grace: { pos: 1 }, lin: { pos: 2 } });
    const limited = buildRtdbQuery(scores as never, rtdbOrderByChild('pos'), rtdbLimitToFirst(2));

    let error: (Error & { code?: unknown }) | undefined;
    try { await client.rtdbGet(limited as never); } catch (caught) { error = caught as Error; }
    expect(error?.message).toBe('Index not defined, add ".indexOn": "pos", for path "/scores", to the rules');

    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args); };
    try {
      const windows: string[][] = [];
      const stopLimited = client.rtdbOnValue(limited as never, (snap) => {
        const keys: string[] = [];
        snap.forEach((child) => { keys.push(child.key!); return false; });
        windows.push(keys);
      });
      await until(() => windows.length >= 1, 'initial limited window');
      await client.rtdbSet(client.rtdbChild(scores, 'ada'), { pos: 0 });
      await until(() => windows.length >= 2, 'limited window after set');
      stopLimited();
      expect(windows).toEqual([['grace', 'lin'], ['ada', 'grace']]);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]![0]).toMatch(/^\[[^\]]+\] {2}@firebase\/database:$/);
      expect(warnings[0]![1]).toBe('FIREBASE WARNING: Using an unspecified index. Your data will be downloaded and filtered on the client. Consider adding ".indexOn": "pos" at /scores to your security rules for better performance. ');

      warnings.length = 0;
      let unlimitedDeliveries = 0;
      const stopUnlimited = client.rtdbOnValue(buildRtdbQuery(scores as never, rtdbOrderByChild('pos')) as never, () => { unlimitedDeliveries += 1; });
      // The warning rides on the listener's first snapshot and is logged before its callback runs.
      await until(() => unlimitedDeliveries >= 1, 'unlimited listener first snapshot');
      stopUnlimited();
      expect(warnings).toEqual([]);
    } finally {
      console.warn = originalWarn;
    }
  });
});
