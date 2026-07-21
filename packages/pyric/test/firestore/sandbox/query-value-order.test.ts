/**
 * FS-B3 — canonical Firestore value comparator + cross-type orderBy.
 *
 * The old query comparator fell back to `String(a).localeCompare(String(b))`,
 * which mis-ordered cross-type values (a number `10` sorted before `2` as
 * a string; a timestamp sorted as `[object Object]`), broke NaN, and
 * sorted missing-field docs into orderBy results. These probes lock the
 * canonical type order
 *   null < boolean < number < timestamp < string < bytes < ref < geopoint
 *   < array < map
 * and the missing-field exclusion, mirroring
 * `clones/firebase-js-sdk/packages/firestore/src/model/{type_order,values}.ts`.
 */
import { describe, it, expect } from 'bun:test';
import { LocalEnvironment } from 'pyric/sandbox/internal';
import { createCompatFirestore } from '../../../src/firestore/sandbox/admin-compat/index.js';
import {
  compareValues,
  typeOrderRank,
  TypeRank,
} from '../../../src/firestore/sandbox/query-value-order.js';

const ts = (s: number, n = 0) => ({ seconds: s, nanos: n });
const geo = (lat: number, lng: number) => ({ latitude: lat, longitude: lng });
const bytes = (...b: number[]) => ({ data: new Uint8Array(b) });
const ref = (path: string) => ({ path });

describe('FS-B3 — canonical type order ranking', () => {
  it('ranks types in the Firestore canonical order', () => {
    const ascending: unknown[] = [
      null,
      true,
      1,
      ts(100),
      'z',
      bytes(1),
      ref('a/b'),
      geo(0, 0),
      [1],
      { k: 1 },
    ];
    const ranks = ascending.map(typeOrderRank);
    // Strictly increasing — each type sorts after the previous.
    for (let i = 1; i < ranks.length; i++) {
      expect(ranks[i]).toBeGreaterThan(ranks[i - 1]);
    }
    expect(typeOrderRank(null)).toBe(TypeRank.Null);
    expect(typeOrderRank({ k: 1 })).toBe(TypeRank.Map);
  });

  it('cross-type compare follows type order, not String()', () => {
    // A number is always < a string (pre-fix `String(10) < String('2')`
    // gave the wrong intra-string answer; the real rule is type-first).
    expect(compareValues(10, '2')).toBeLessThan(0);
    expect(compareValues(ts(5), 'a')).toBeLessThan(0); // timestamp < string
    expect(compareValues(false, 0)).toBeLessThan(0);    // bool < number
    expect(compareValues(null, false)).toBeLessThan(0); // null < bool
  });

  it('numbers compare numerically (not lexicographically)', () => {
    expect(compareValues(2, 10)).toBeLessThan(0); // pre-fix: '10' < '2'
    expect(compareValues(10, 2)).toBeGreaterThan(0);
  });

  it('NaN sorts as the smallest number', () => {
    expect(compareValues(NaN, -Infinity)).toBeLessThan(0);
    expect(compareValues(NaN, NaN)).toBe(0);
    expect(compareValues(5, NaN)).toBeGreaterThan(0);
  });

  it('timestamps compare by seconds then nanos', () => {
    expect(compareValues(ts(100, 0), ts(100, 500))).toBeLessThan(0);
    expect(compareValues(ts(200), ts(100))).toBeGreaterThan(0);
    // Mixed nanos/nanoseconds field names both work.
    expect(compareValues({ seconds: 1, nanoseconds: 5 }, ts(1, 5))).toBe(0);
  });

  it('arrays compare element-wise then by length', () => {
    expect(compareValues([1, 2], [1, 3])).toBeLessThan(0);
    expect(compareValues([1], [1, 2])).toBeLessThan(0);
    expect(compareValues([1, 2], [1, 2])).toBe(0);
  });
});

describe('FS-B3 — orderBy over a heterogeneous + missing-field collection', () => {
  function db() {
    const env = new LocalEnvironment();
    env.seed({
      rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /{document=**} { allow read, write: if true; }
  }
}`,
      documents: {
        'items/a': { v: 10 },
        'items/b': { v: 2 },
        'items/c': { v: 'apple' },
        'items/d': { v: null },
        'items/e': { other: 1 }, // missing `v`
      },
    });
    return createCompatFirestore(env, { auth: { uid: 'u' } });
  }

  it('orders by canonical type then value, excluding the missing-field doc', async () => {
    const snap = await db().collection('items').orderBy('v').get();
    // null < number(2,10) < string('apple'); missing-`v` doc excluded.
    const ids = snap.docs.map((d) => d.id);
    expect(ids).toEqual(['d', 'b', 'a', 'c']);
    // The doc with no `v` field is not present.
    expect(ids).not.toContain('e');
  });

  it('numeric orderBy sorts numerically not lexicographically', async () => {
    const snap = await db().collection('items')
      .where('v', '>=', 2)
      .orderBy('v')
      .get();
    // 2 then 10 (lexicographic would invert these).
    expect(snap.docs.map((d) => (d.data() as { v: number }).v)).toEqual([2, 10]);
  });
});
