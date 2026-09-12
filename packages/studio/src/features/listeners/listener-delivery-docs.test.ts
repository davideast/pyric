/** What each delivery handed the callback, and how each path changed. */
import { describe, expect, it } from 'bun:test';
import type { SandboxEvent } from 'pyric/sandbox';
import {
  deliveredDocumentReads,
  deliveredPathCounts,
  distinctDeliveredPaths,
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

describe('distinctDeliveredPaths', () => {
  it('counts a path once however many deliveries carried it', () => {
    const events = [
      snapshot('a', 10, [{ path: 'notes/one', data: { n: 1 } }]),
      snapshot('a', 20, [
        { path: 'notes/one', data: { n: 2 } },
        { path: 'notes/two', data: { n: 2 } },
      ]),
    ];
    expect(distinctDeliveredPaths(listenerDeliveryHistory(events, 'a'))).toBe(2);
  });

  it('is zero without deliveries', () => {
    expect(distinctDeliveredPaths([])).toBe(0);
  });
});

describe('the first delivery', () => {
  it('is the only one marked initial', () => {
    const events = [
      snapshot('a', 10, [{ path: 'notes/one', data: { n: 1 } }]),
      snapshot('a', 20, [{ path: 'notes/one', data: { n: 2 } }]),
    ];
    expect(listenerDeliveryHistory(events, 'a').map((d) => d.initial)).toEqual([true, false]);
  });
});

describe('deliveredDocumentReads', () => {
  it('sums every snapshot’s size, so a path in two snapshots is two reads', () => {
    const events = [
      snapshot('a', 10, [{ path: 'notes/one', data: { n: 1 } }]),
      snapshot('a', 20, [
        { path: 'notes/one', data: { n: 2 } },
        { path: 'notes/two', data: { n: 2 } },
      ]),
    ];
    expect(deliveredDocumentReads(listenerDeliveryHistory(events, 'a'))).toBe(3);
    expect(deliveredDocumentReads([])).toBe(0);
  });
});

describe('deliveredPathCounts', () => {
  it('counts the deliveries that changed each path, most-changed first', () => {
    const events = [
      snapshot('a', 10, [{ path: 'notes/one', data: { n: 1 } }]),
      snapshot('a', 20, [
        { path: 'notes/one', data: { n: 2 } },
        { path: 'notes/two', data: { n: 2 } },
      ]),
      snapshot('a', 30, [
        { path: 'notes/one', data: { n: 3 } },
        { path: 'notes/two', data: { n: 2 } },
      ]),
    ];
    expect(deliveredPathCounts(listenerDeliveryHistory(events, 'a'))).toEqual([
      { path: 'notes/one', changes: 3 },
      { path: 'notes/two', changes: 1 },
    ]);
  });

  it('orders equal counts by path', () => {
    const events = [
      snapshot('a', 10, [
        { path: 'notes/b', data: { n: 1 } },
        { path: 'notes/a', data: { n: 1 } },
      ]),
    ];
    expect(deliveredPathCounts(listenerDeliveryHistory(events, 'a')).map((c) => c.path)).toEqual([
      'notes/a',
      'notes/b',
    ]);
  });
});
