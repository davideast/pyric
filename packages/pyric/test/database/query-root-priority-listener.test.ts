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
});
