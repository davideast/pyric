import { describe, expect, test } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  endAt,
  equalTo,
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
  test('notifies unfiltered queries when query root .priority changes', async () => {
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

  test('suppresses root-priority-only updates on filtered queries with limits or bounds', async () => {
    const box = initializeSandbox();
    const db = getDatabase(box);
    rtdbSandbox.setRules(db, OPEN_RULES);
    await set(ref(db, 'items'), { a: 1, b: 2 });

    const counts = {
      first: 0,
      last: 0,
      start: 0,
      end: 0,
      eq: 0,
    };

    const unsubs = [
      onValue(query(ref(db, 'items'), orderByKey(), limitToFirst(5)), () => {
        counts.first += 1;
      }),
      onValue(query(ref(db, 'items'), orderByKey(), limitToLast(5)), () => {
        counts.last += 1;
      }),
      onValue(query(ref(db, 'items'), orderByKey(), startAt('a')), () => {
        counts.start += 1;
      }),
      onValue(query(ref(db, 'items'), orderByKey(), endAt('z')), () => {
        counts.end += 1;
      }),
      onValue(query(ref(db, 'items'), orderByKey(), equalTo('a')), () => {
        counts.eq += 1;
      }),
    ];

    try {
      expect(counts).toEqual({ first: 1, last: 1, start: 1, end: 1, eq: 1 });
      await setPriority(ref(db, 'items'), 42);
      expect(counts).toEqual({ first: 1, last: 1, start: 1, end: 1, eq: 1 });
    } finally {
      for (const unsub of unsubs) unsub();
    }
  });
});
