/** What each delivery handed the callback, and how each path changed. */
import { describe, expect, it } from 'bun:test';
import type { SandboxEvent } from 'pyric/sandbox';
import {
  latestListenerDelivery,
  listenerDeliveryHistory,
} from './listener-delivery-docs.js';

let seq = 0;

function snapshot(
  listenerId: string,
  at: number,
  docs: Array<{ path: string; data: Record<string, unknown> | null }>,
  counts: { added: number; modified: number; removed: number } = {
    added: 0,
    modified: 0,
    removed: 0,
  },
): SandboxEvent {
  seq += 1;
  return {
    kind: 'snapshot_delivery',
    id: `s${seq}`,
    at,
    listenerId,
    target: { kind: 'query', collection: 'notes' },
    auth: null,
    addedCount: counts.added,
    modifiedCount: counts.modified,
    removedCount: counts.removed,
    size: docs.length,
    sample: { docs },
  } as unknown as SandboxEvent;
}

function dbDelivery(
  listenerId: string,
  at: number,
  path: string,
  sample: unknown,
): SandboxEvent {
  seq += 1;
  return {
    kind: 'listener',
    id: `d${seq}`,
    at,
    service: 'database',
    phase: 'delivery',
    listenerId,
    target: { kind: 'ref', path },
    auth: null,
    size: 1,
    sample,
  } as unknown as SandboxEvent;
}

function labels(docs: readonly { path: string; change: string }[]) {
  return docs.map((doc) => `${doc.path} ${doc.change}`);
}

describe('listenerDeliveryHistory, Firestore', () => {
  it('labels added, modified, removed, and unchanged across three deliveries', () => {
    const events = [
      snapshot('a', 10, [
        { path: 'notes/one', data: { title: 'one' } },
        { path: 'notes/two', data: { title: 'two' } },
      ]),
      snapshot('a', 20, [
        { path: 'notes/one', data: { title: 'one' } },
        { path: 'notes/two', data: { title: 'two, edited' } },
        { path: 'notes/three', data: { title: 'three' } },
      ]),
      snapshot('a', 30, [{ path: 'notes/one', data: { title: 'one' } }]),
    ];
    const history = listenerDeliveryHistory(events, 'a');
    expect(history).toHaveLength(3);
    expect(labels(history[0]!.docs)).toEqual(['notes/one added', 'notes/two added']);
    expect(labels(history[1]!.docs)).toEqual([
      'notes/one unchanged',
      'notes/two modified',
      'notes/three added',
    ]);
    expect(labels(history[2]!.docs)).toEqual([
      'notes/one unchanged',
      'notes/two removed',
      'notes/three removed',
    ]);
  });

  it('ignores deliveries of other listeners when comparing', () => {
    const events = [
      snapshot('a', 10, [{ path: 'notes/one', data: { n: 1 } }]),
      snapshot('b', 15, [{ path: 'notes/nine', data: { n: 9 } }]),
      snapshot('a', 20, [{ path: 'notes/one', data: { n: 1 } }]),
    ];
    expect(labels(listenerDeliveryHistory(events, 'a')[1]!.docs)).toEqual([
      'notes/one unchanged',
    ]);
  });

  it('keeps the counts the delivery event stated', () => {
    const events = [
      snapshot('a', 10, [{ path: 'notes/one', data: { n: 1 } }], {
        added: 1,
        modified: 0,
        removed: 0,
      }),
    ];
    const delivery = listenerDeliveryHistory(events, 'a')[0]!;
    expect([delivery.addedCount, delivery.modifiedCount, delivery.removedCount]).toEqual([
      1, 0, 0,
    ]);
    expect(delivery.size).toBe(1);
  });

  it('reads an empty query result as a delivery of nothing', () => {
    const history = listenerDeliveryHistory([snapshot('a', 10, [])], 'a');
    expect(history).toHaveLength(1);
    expect(history[0]!.docs).toEqual([]);
    expect(history[0]!.size).toBe(0);
  });

  it('lists a document listener as its one path', () => {
    const history = listenerDeliveryHistory(
      [snapshot('a', 10, [{ path: 'notes/one', data: { n: 1 } }])],
      'a',
    );
    expect(labels(history[0]!.docs)).toEqual(['notes/one added']);
  });
});

describe('listenerDeliveryHistory, database', () => {
  it('names each child key as a path under the target', () => {
    const events = [
      dbDelivery('r', 10, 'rooms/lobby', { alice: { at: 1 }, bob: { at: 2 } }),
      dbDelivery('r', 20, 'rooms/lobby', { alice: { at: 1 }, carol: { at: 3 } }),
    ];
    const history = listenerDeliveryHistory(events, 'r');
    expect(labels(history[0]!.docs)).toEqual([
      'rooms/lobby/alice added',
      'rooms/lobby/bob added',
    ]);
    expect(labels(history[1]!.docs)).toEqual([
      'rooms/lobby/alice unchanged',
      'rooms/lobby/carol added',
      'rooms/lobby/bob removed',
    ]);
  });

  it('derives the counts a database delivery does not state', () => {
    const events = [
      dbDelivery('r', 10, 'rooms/lobby', { alice: 1, bob: 2 }),
      dbDelivery('r', 20, 'rooms/lobby', { alice: 9 }),
    ];
    const second = listenerDeliveryHistory(events, 'r')[1]!;
    expect([second.addedCount, second.modifiedCount, second.removedCount]).toEqual([0, 1, 1]);
  });

  it('lists a primitive value as the target path itself', () => {
    const events = [
      dbDelivery('r', 10, 'counters/visits', 4),
      dbDelivery('r', 20, 'counters/visits', 5),
    ];
    const history = listenerDeliveryHistory(events, 'r');
    expect(labels(history[0]!.docs)).toEqual(['counters/visits added']);
    expect(labels(history[1]!.docs)).toEqual(['counters/visits modified']);
  });

  it('delivers nothing when the value at the path is null', () => {
    const history = listenerDeliveryHistory([dbDelivery('r', 10, 'rooms/lobby', null)], 'r');
    expect(history[0]!.docs).toEqual([]);
  });
});

describe('latestListenerDelivery', () => {
  it('is the newest delivery', () => {
    const events = [
      snapshot('a', 10, [{ path: 'notes/one', data: { n: 1 } }]),
      snapshot('a', 20, [{ path: 'notes/two', data: { n: 2 } }]),
    ];
    expect(latestListenerDelivery(events, 'a')?.at).toBe(20);
  });

  it('is nothing for a listener that has never delivered', () => {
    expect(latestListenerDelivery([snapshot('a', 10, [])], 'b')).toBeUndefined();
  });
});

describe('listenerDeliveryHistory, live observed operations', () => {
  function liveOp(
    listenerId: string,
    at: number,
    service: 'firestore' | 'rtdb',
    method: string,
    path: string,
    delivery?: { mode: 'snapshot' | 'delta'; size: number; paths: string[]; removedPaths?: string[] },
    billedDocuments?: number,
  ): SandboxEvent {
    seq += 1;
    const production: Record<string, unknown> = { outcome: { status: 'ok' } };
    if (billedDocuments !== undefined) production.billedDocuments = billedDocuments;
    const detail: Record<string, unknown> = { listenerId };
    if (delivery !== undefined) detail.delivery = delivery;
    return {
      kind: 'operation',
      id: `live-${seq}`,
      at,
      service,
      method,
      path,
      auth: null,
      result: 'allow',
      production,
      detail,
    } as unknown as SandboxEvent;
  }

  it('folds live Firestore delta deliveries and preserves uncapped >64 snapshot counts', () => {
    const cappedPaths = Array.from({ length: 64 }, (_, i) => `rooms/r-${i + 1}`);
    const events = [
      liveOp('page:t1:fs', 10, 'firestore', 'onSnapshot', 'rooms', {
        mode: 'delta',
        size: 80,
        paths: cappedPaths,
      }, 80),
      liveOp('page:t1:fs', 20, 'firestore', 'onSnapshot', 'rooms', {
        mode: 'delta',
        size: 2,
        paths: ['rooms/r-2', 'rooms/r-81'],
      }, 2),
      liveOp('page:t1:fs', 30, 'firestore', 'onSnapshot', 'rooms/r-1', {
        mode: 'delta',
        size: 0,
        paths: [],
        removedPaths: ['rooms/r-1'],
      }, 0),
    ];
    const history = listenerDeliveryHistory(events, 'page:t1:fs');
    expect(history).toHaveLength(3);
    expect(history[0]).toMatchObject({
      initial: true,
      addedCount: 80,
      modifiedCount: 0,
      removedCount: 0,
      size: 80,
      billedDocuments: 80,
    });
    expect(history[1]).toMatchObject({
      initial: false,
      addedCount: 1,
      modifiedCount: 1,
      removedCount: 0,
      size: 81,
      billedDocuments: 2,
    });
    expect(labels(history[1]!.docs)).toContain('rooms/r-2 modified');
    expect(labels(history[1]!.docs)).toContain('rooms/r-81 added');
    expect(history[2]).toMatchObject({
      initial: false,
      addedCount: 0,
      modifiedCount: 0,
      removedCount: 1,
      size: 80,
      billedDocuments: 0,
    });
    expect(labels(history[2]!.docs)).toContain('rooms/r-1 removed');
  });

  it('subtracts removals beyond the 64-path cap from uncapped size and falls back to billedDocuments on empty summaries', () => {
    const cappedPaths = Array.from({ length: 64 }, (_, i) => `rooms/r-${i + 1}`);
    const overCapHistory = listenerDeliveryHistory(
      [
        liveOp('page:t1:overcap', 10, 'firestore', 'onSnapshot', 'rooms', {
          mode: 'delta',
          size: 80,
          paths: cappedPaths,
        }, 80),
        liveOp('page:t1:overcap', 20, 'firestore', 'onSnapshot', 'rooms', {
          mode: 'delta',
          size: 0,
          paths: [],
          removedPaths: ['rooms/r-75'],
        }, 0),
      ],
      'page:t1:overcap',
    );
    expect(overCapHistory[1]).toMatchObject({
      removedCount: 1,
      size: 79,
    });
    expect(labels(overCapHistory[1]!.docs)).toContain('rooms/r-75 removed');

    const emptySummaryHistory = listenerDeliveryHistory(
      [
        liveOp('page:t1:empty-summary', 10, 'firestore', 'onSnapshot', 'rooms', {
          mode: 'delta',
          size: 0,
          paths: [],
        }, 3),
      ],
      'page:t1:empty-summary',
    );
    expect(emptySummaryHistory[0]).toMatchObject({
      initial: true,
      addedCount: 3,
      size: 3,
      billedDocuments: 3,
    });
  });

  it('folds live RTDB onChild* delta deliveries and removes deleted children cleanly', () => {
    const events = [
      liveOp('page:t1:child', 10, 'rtdb', 'onChildAdded', 'items', {
        mode: 'delta',
        size: 1,
        paths: ['items/i1'],
      }),
      liveOp('page:t1:child', 20, 'rtdb', 'onChildAdded', 'items', {
        mode: 'delta',
        size: 1,
        paths: ['items/i2'],
      }),
      liveOp('page:t1:child', 30, 'rtdb', 'onChildChanged', 'items', {
        mode: 'delta',
        size: 1,
        paths: ['items/i1'],
      }),
      liveOp('page:t1:child', 40, 'rtdb', 'onChildRemoved', 'items', {
        mode: 'delta',
        size: 0,
        paths: [],
        removedPaths: ['items/i1'],
      }),
    ];
    const history = listenerDeliveryHistory(events, 'page:t1:child');
    expect(history).toHaveLength(4);
    expect(history[1]).toMatchObject({ addedCount: 1, size: 2 });
    expect(history[2]).toMatchObject({ modifiedCount: 1, size: 2 });
    expect(history[3]).toMatchObject({ removedCount: 1, size: 1 });
    expect(labels(history[3]!.docs)).toEqual(['items/i2 unchanged', 'items/i1 removed']);
  });

  it('folds live RTDB onValue full-node snapshots with unchanged keys rather than speculating modified', () => {
    const events = [
      liveOp('page:t1:rt', 10, 'rtdb', 'onValue', 'rooms/lobby', {
        mode: 'snapshot',
        size: 2,
        paths: ['rooms/lobby/alpha', 'rooms/lobby/beta'],
      }),
      liveOp('page:t1:rt', 20, 'rtdb', 'onValue', 'rooms/lobby', {
        mode: 'snapshot',
        size: 2,
        paths: ['rooms/lobby/alpha', 'rooms/lobby/gamma'],
      }),
      liveOp('page:t1:rt', 30, 'rtdb', 'onValue', 'rooms/lobby', {
        mode: 'snapshot',
        size: 2,
        paths: ['rooms/lobby/alpha', 'rooms/lobby/gamma'],
      }),
    ];
    const history = listenerDeliveryHistory(events, 'page:t1:rt');
    expect(history).toHaveLength(3);
    expect(labels(history[0]!.docs)).toEqual([
      'rooms/lobby/alpha added',
      'rooms/lobby/beta added',
    ]);
    expect(labels(history[1]!.docs)).toEqual([
      'rooms/lobby/alpha unchanged',
      'rooms/lobby/gamma added',
      'rooms/lobby/beta removed',
    ]);
    expect(history[2]!.modifiedCount).toBe(0);
    expect(labels(history[2]!.docs)).toEqual([
      'rooms/lobby/alpha unchanged',
      'rooms/lobby/gamma unchanged',
    ]);
  });
});
