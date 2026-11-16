import { describe, expect, test } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  endAt,
  equalTo,
  get,
  getDatabase,
  limitToFirst,
  limitToLast,
  onValue,
  orderByChild,
  orderByKey,
  orderByPriority,
  orderByValue,
  query,
  ref,
  sandbox as rtdbSandbox,
  set,
  setPriority,
  setWithPriority,
  startAt,
} from '../../src/database/index.js';

const OPEN_RULES = {
  rules: {
    '.read': true,
    '.write': true,
    items: { '.indexOn': ['score', '.value'] },
  },
};

describe('query onValue root priority notifications', () => {
  test('notifies unfiltered queries when query root .priority changes and exposes root priority on get()', async () => {
    const box = initializeSandbox();
    const db = getDatabase(box);
    rtdbSandbox.setRules(db, OPEN_RULES);
    await set(ref(db, 'items'), {
      a: { score: 1 },
      b: { score: 2 },
    });

    const recorded = {
      bare: [] as Array<string | number | null>,
      byKey: [] as Array<string | number | null>,
      byChild: [] as Array<string | number | null>,
      byPriority: [] as Array<string | number | null>,
    };
    const byKeyExportPriorities: Array<unknown> = [];

    const unsubs = [
      onValue(query(ref(db, 'items')), (snap) => {
        recorded.bare.push(snap.priority);
      }),
      onValue(query(ref(db, 'items'), orderByKey()), (snap) => {
        recorded.byKey.push(snap.priority);
        const exported = snap.exportVal() as Record<string, unknown> | null;
        byKeyExportPriorities.push(exported?.['.priority'] ?? null);
      }),
      onValue(query(ref(db, 'items'), orderByChild('score')), (snap) => {
        recorded.byChild.push(snap.priority);
      }),
      onValue(query(ref(db, 'items'), orderByPriority()), (snap) => {
        recorded.byPriority.push(snap.priority);
      }),
    ];

    try {
      await setPriority(ref(db, 'items'), 42);
      const unfilteredSnap = await get(query(ref(db, 'items'), orderByKey()));
      expect(unfilteredSnap.priority).toBe(42);
      expect((unfilteredSnap.exportVal() as Record<string, unknown>)['.priority']).toBe(42);

      await setPriority(ref(db, 'items'), 'high');
      await setPriority(ref(db, 'items'), null);

      expect(recorded.bare).toEqual([null, 42, 'high', null]);
      expect(recorded.byKey).toEqual([null, 42, 'high', null]);
      expect(recorded.byChild).toEqual([null, 42, 'high', null]);
      expect(recorded.byPriority).toEqual([null, 42, 'high', null]);
      expect(byKeyExportPriorities).toEqual([null, 42, 'high', null]);
    } finally {
      for (const unsub of unsubs) unsub();
    }
  });

  test('notifies unfiltered orderByValue() query when query root .priority changes', async () => {
    const box = initializeSandbox();
    const db = getDatabase(box);
    rtdbSandbox.setRules(db, OPEN_RULES);
    await set(ref(db, 'items'), { a: 1, b: 2 });

    const seen: Array<string | number | null> = [];
    const unsub = onValue(query(ref(db, 'items'), orderByValue()), (snap) => {
      seen.push(snap.priority);
    });

    try {
      await setPriority(ref(db, 'items'), 15);
      expect(seen).toEqual([null, 15]);
    } finally {
      unsub();
    }
  });

  test('strips root priority on filtered queries in get() and onValue() while preserving child priorities', async () => {
    const box = initializeSandbox();
    const db = getDatabase(box);
    rtdbSandbox.setRules(db, OPEN_RULES);
    await setWithPriority(ref(db, 'items'), { a: 1, b: 2, c: 3 }, 10);
    await setPriority(ref(db, 'items/a'), 3);

    const firstTwoQuery = query(ref(db, 'items'), orderByKey(), limitToFirst(2));
    const filteredQueries = [
      firstTwoQuery,
      query(ref(db, 'items'), orderByKey(), limitToLast(2)),
      query(ref(db, 'items'), orderByKey(), startAt('a')),
      query(ref(db, 'items'), orderByKey(), endAt('b')),
      query(ref(db, 'items'), orderByKey(), equalTo('a')),
    ];

    for (const q of filteredQueries) {
      const snap = await get(q);
      expect(snap.priority).toBeNull();
      const exported = snap.exportVal() as Record<string, unknown>;
      expect(Object.hasOwn(exported, '.priority')).toBe(false);
      expect(Object.hasOwn(snap.toJSON() as Record<string, unknown>, '.priority')).toBe(false);
    }

    const firstTwo = await get(firstTwoQuery);
    expect(firstTwo.exportVal()).toEqual({
      a: { '.value': 1, '.priority': 3 },
      b: 2,
    });
    expect(firstTwo.child('a').priority).toBe(3);

    const events: Array<{ priority: string | number | null; exportVal: unknown }> = [];
    const unsub = onValue(query(ref(db, 'items'), orderByKey(), limitToFirst(2)), (snap) => {
      events.push({ priority: snap.priority, exportVal: snap.exportVal() });
    });

    try {
      expect(events).toEqual([
        {
          priority: null,
          exportVal: { a: { '.value': 1, '.priority': 3 }, b: 2 },
        },
      ]);

      await setPriority(ref(db, 'items'), 42);
      expect(events.length).toBe(1);

      await set(ref(db, 'items/b'), 20);
      expect(events).toEqual([
        {
          priority: null,
          exportVal: { a: { '.value': 1, '.priority': 3 }, b: 2 },
        },
        {
          priority: null,
          exportVal: { a: { '.value': 1, '.priority': 3 }, b: 20 },
        },
      ]);
    } finally {
      unsub();
    }
  });

  test('preserves scalar leaf values and priorities on unfiltered queries while projecting null on filtered queries', async () => {
    const box = initializeSandbox();
    const db = getDatabase(box);
    rtdbSandbox.setRules(db, OPEN_RULES);
    await setWithPriority(ref(db, 'items'), 125, 7);

    const unfilteredQueries = [
      query(ref(db, 'items'), orderByPriority()),
      query(ref(db, 'items'), orderByKey()),
      query(ref(db, 'items'), orderByValue()),
      query(ref(db, 'items'), orderByChild('score')),
    ];
    for (const q of unfilteredQueries) {
      const snap = await get(q);
      expect(snap.exists()).toBe(true);
      expect(snap.val()).toBe(125);
      expect(snap.priority).toBe(7);
      expect(snap.exportVal()).toEqual({ '.value': 125, '.priority': 7 });
      expect(snap.size).toBe(0);
      expect(snap.hasChildren()).toBe(false);
    }

    const filteredQueries = [
      query(ref(db, 'items'), orderByPriority(), limitToFirst(2)),
      query(ref(db, 'items'), orderByKey(), limitToLast(1)),
      query(ref(db, 'items'), orderByPriority(), startAt(1)),
      query(ref(db, 'items'), orderByValue(), endAt(200)),
      query(ref(db, 'items'), orderByChild('score'), equalTo(1)),
    ];
    for (const q of filteredQueries) {
      const snap = await get(q);
      expect(snap.exists()).toBe(false);
      expect(snap.val()).toBeNull();
      expect(snap.priority).toBeNull();
      expect(snap.exportVal()).toBeNull();
    }

    await set(ref(db, 'items'), 125);
    const byPriorityEvents: Array<{ exists: boolean; exportVal: unknown; priority: string | number | null }> = [];
    const limitedEvents: Array<{ exists: boolean; exportVal: unknown; priority: string | number | null }> = [];
    const unsubPriority = onValue(query(ref(db, 'items'), orderByPriority()), (snap) => {
      byPriorityEvents.push({ exists: snap.exists(), exportVal: snap.exportVal(), priority: snap.priority });
    });
    const unsubLimited = onValue(query(ref(db, 'items'), orderByPriority(), limitToFirst(2)), (snap) => {
      limitedEvents.push({ exists: snap.exists(), exportVal: snap.exportVal(), priority: snap.priority });
    });

    try {
      await set(ref(db, 'items'), 200);
      await setPriority(ref(db, 'items'), 7);
      await set(ref(db, 'items'), { b: 1, a: 2 });
      await set(ref(db, 'items'), 300);
      await set(ref(db, 'items'), null);

      expect(byPriorityEvents).toEqual([
        { exists: true, exportVal: 125, priority: null },
        { exists: true, exportVal: 200, priority: null },
        { exists: true, exportVal: { '.value': 200, '.priority': 7 }, priority: 7 },
        { exists: true, exportVal: { a: 2, b: 1 }, priority: null },
        { exists: true, exportVal: 300, priority: null },
        { exists: false, exportVal: null, priority: null },
      ]);
      expect(limitedEvents).toEqual([
        { exists: false, exportVal: null, priority: null },
        { exists: true, exportVal: { a: 2, b: 1 }, priority: null },
        { exists: false, exportVal: null, priority: null },
      ]);
    } finally {
      unsubPriority();
      unsubLimited();
    }
  });
});
