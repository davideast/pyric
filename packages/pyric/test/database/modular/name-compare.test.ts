/**
 * RTDB modular SDK — nameCompare key ordering probes (T4-2 / DB-B4).
 *
 * RTDB orders keys numeric-first: integer-looking keys sort numerically
 * BEFORE non-integer keys (which sort lexicographically). Plain
 * lexicographic compare put `"10"` before `"2"`.
 *
 * Confirmed against the upstream clone `core/util/util.ts:253-276`
 * (`nameCompare`) + `:511-520` (`tryParseInt`).
 */
import { describe, it, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  getDatabase,
  ref,
  set,
  get,
  query,
  orderByKey,
  startAt,
  endAt,
} from '../../../src/database/index.js';

function setup() {
  const sandbox = initializeSandbox();
  const db = getDatabase(sandbox.withAuth({ uid: 'alice' }));
  return { sandbox, db };
}

describe('DB-B4 — nameCompare (numeric-keys-first) ordering', () => {
  it('orderByKey sorts integer keys numerically, before non-integer keys', async () => {
    const { db } = setup();
    await set(ref(db, 'col'), { '10': 'j', '2': 'b', '1': 'a', b: 'z' });
    const snap = await get(query(ref(db, 'col'), orderByKey()));
    const order: string[] = [];
    snap.forEach((c) => {
      order.push(c.key as string);
    });
    // Pre-fix (lexicographic): ['1','10','2','b'].
    expect(order).toEqual(['1', '2', '10', 'b']);
  });

  it('orderByKey window with a numeric-key cursor uses nameCompare bounds', async () => {
    const { db } = setup();
    await set(ref(db, 'col'), {
      '1': 'a',
      '2': 'b',
      '10': 'j',
      '20': 't',
    });
    // startAt('2') endAt('10') — under nameCompare this is keys 2..10
    // (numerically), i.e. {2, 10}. Lexicographically '2' > '10' so the
    // pre-fix window would have been empty / wrong.
    const snap = await get(
      query(ref(db, 'col'), orderByKey(), startAt('2'), endAt('10')),
    );
    const order: string[] = [];
    snap.forEach((c) => {
      order.push(c.key as string);
    });
    expect(order).toEqual(['2', '10']);
  });
});
