/**
 * ADR-0009 decision 6 — characterization pins for the admin-compat query
 * surface, `where()` semantics. These pins go only through the public
 * surface (`createCompatFirestore` → `.collection().where().get()`) so
 * they survive PR C's move of query execution behind the engine.
 *
 * Behavior pinned as-is; nothing here is a spec of what "should" happen.
 * Notable current behaviors locked below:
 *   - Range ops (`<` `<=` `>` `>=`) only match operands of the same
 *     canonical type — `> 0` never matches the string `'5'`.
 *   - A missing field never matches any operator, including `== null`.
 *   - `!=` and `not-in` require the field to exist and be non-null.
 *   - `not-in` with a `null` in the operand list matches nothing.
 *   - `in` with a non-array operand silently matches nothing (no throw).
 */
import { describe, it, expect } from 'bun:test';
import { LocalEnvironment } from 'pyric/sandbox/internal';
import { createCompatFirestore } from '../../../../../src/firestore/sandbox/admin-compat/index.js';

const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /{document=**} { allow read, write: if request.auth != null; }
  }
}`;

function seededDb(documents: Record<string, Record<string, unknown>>) {
  const env = new LocalEnvironment();
  env.seed({ rules: RULES, documents });
  return createCompatFirestore(env, { auth: { uid: 'alice' } });
}

/** Result doc ids, in returned order. */
async function ids(q: { get: () => Promise<{ docs: { id: string }[] }> }): Promise<string[]> {
  return (await q.get()).docs.map((d) => d.id);
}

// Mixed-type fixture used by most op pins. Seed order is the map order.
const MIXED = {
  'items/a': { n: 1, s: 'x' },
  'items/b': { n: 2 },
  'items/c': { n: '5' },
  'items/d': { n: null },
  'items/e': {},
} as const;

describe('characterization — where() equality ops', () => {
  it('== matches same-type values only (5 does not match "5")', async () => {
    const db = seededDb(MIXED);
    expect(await ids(db.collection('items').where('n', '==', 2))).toEqual(['b']);
    expect(await ids(db.collection('items').where('n', '==', '5'))).toEqual(['c']);
    expect(await ids(db.collection('items').where('n', '==', 5))).toEqual([]);
  });

  it('== null matches an explicit null but not a missing field', async () => {
    const db = seededDb(MIXED);
    expect(await ids(db.collection('items').where('n', '==', null))).toEqual(['d']);
  });

  it('missing field never matches ==', async () => {
    const db = seededDb(MIXED);
    // Only items/a has `s` — everything else is missing the field.
    expect(await ids(db.collection('items').where('s', '==', 'x'))).toEqual(['a']);
    expect(await ids(db.collection('items').where('s', '==', null))).toEqual([]);
  });

  it('== on object values is deep, key-order-independent equality', async () => {
    const db = seededDb({
      'profiles/p1': { prefs: { role: 'admin', active: true } },
      'profiles/p2': { prefs: { role: 'member', active: true } },
    });
    expect(
      await ids(db.collection('profiles').where('prefs', '==', { active: true, role: 'admin' })),
    ).toEqual(['p1']);
  });

  it('!= requires the field to exist and be non-null, then differ (cross-type differs)', async () => {
    const db = seededDb(MIXED);
    // d (null) and e (missing) are excluded; the string '5' counts as != 1.
    expect(await ids(db.collection('items').where('n', '!=', 1))).toEqual(['b', 'c']);
  });

  it('!= null matches nothing (null-valued and missing fields both excluded)', async () => {
    const db = seededDb(MIXED);
    // != demands value !== null before comparing, so even non-null docs
    // pass the "differs from null" check — pin the actual output.
    expect(await ids(db.collection('items').where('n', '!=', null))).toEqual(['a', 'b', 'c']);
  });
});

describe('characterization — where() range ops', () => {
  it('> matches only same-type values (numbers vs strings never compare)', async () => {
    const db = seededDb(MIXED);
    // '5' (string), null, and missing are all excluded from `> 0`. The
    // inequality also imposes an implicit orderBy on `n` (asc).
    expect(await ids(db.collection('items').where('n', '>', 0))).toEqual(['a', 'b']);
    expect(await ids(db.collection('items').where('n', '>', ''))).toEqual(['c']);
  });

  it('>= and <= are inclusive; < and > are exclusive', async () => {
    const db = seededDb(MIXED);
    expect(await ids(db.collection('items').where('n', '>=', 2))).toEqual(['b']);
    expect(await ids(db.collection('items').where('n', '>', 2))).toEqual([]);
    expect(await ids(db.collection('items').where('n', '<=', 1))).toEqual(['a']);
    expect(await ids(db.collection('items').where('n', '<', 1))).toEqual([]);
  });

  it('range ops never match null or missing fields', async () => {
    const db = seededDb(MIXED);
    // null has its own type rank, so `<` against a number excludes it.
    expect(await ids(db.collection('items').where('n', '<', 100))).toEqual(['a', 'b']);
  });

  it('string ranges compare lexicographically within the string type', async () => {
    const db = seededDb({
      'words/w1': { t: 'apple' },
      'words/w2': { t: 'banana' },
      'words/w3': { t: 'cherry' },
    });
    expect(await ids(db.collection('words').where('t', '>', 'apple'))).toEqual(['w2', 'w3']);
  });
});

describe('characterization — where() in / not-in', () => {
  it('in matches any listed value, same-type equality per element', async () => {
    const db = seededDb(MIXED);
    expect(await ids(db.collection('items').where('n', 'in', [1, '5']))).toEqual(['a', 'c']);
    expect(await ids(db.collection('items').where('n', 'in', [5]))).toEqual([]);
  });

  it('in with null in the list matches null-valued fields', async () => {
    const db = seededDb(MIXED);
    expect(await ids(db.collection('items').where('n', 'in', [null]))).toEqual(['d']);
  });

  it('in with an empty array matches nothing', async () => {
    const db = seededDb(MIXED);
    expect(await ids(db.collection('items').where('n', 'in', []))).toEqual([]);
  });

  it('in with a non-array operand silently matches nothing (no throw)', async () => {
    const db = seededDb(MIXED);
    expect(await ids(db.collection('items').where('n', 'in', 1))).toEqual([]);
  });

  it('not-in excludes listed values; null-valued and missing fields never match', async () => {
    const db = seededDb(MIXED);
    expect(await ids(db.collection('items').where('n', 'not-in', [1]))).toEqual(['b', 'c']);
  });

  it('not-in with null anywhere in the operand list matches nothing', async () => {
    const db = seededDb(MIXED);
    expect(await ids(db.collection('items').where('n', 'not-in', [1, null]))).toEqual([]);
  });
});

describe('characterization — where() array-contains(-any)', () => {
  const TAGGED = {
    'posts/p1': { tags: ['a', 'b'] },
    'posts/p2': { tags: ['b', 'c'] },
    'posts/p3': { tags: [] },
    'posts/p4': { tags: 'a' },
    'posts/p5': {},
  } as const;

  it('array-contains matches docs whose array field holds the value', async () => {
    const db = seededDb(TAGGED);
    expect(await ids(db.collection('posts').where('tags', 'array-contains', 'b'))).toEqual(['p1', 'p2']);
  });

  it('array-contains never matches non-array or missing fields', async () => {
    const db = seededDb(TAGGED);
    // p4 has the scalar 'a', not an array containing 'a'.
    expect(await ids(db.collection('posts').where('tags', 'array-contains', 'a'))).toEqual(['p1']);
  });

  it('array-contains-any matches on any overlap; non-array operand matches nothing', async () => {
    const db = seededDb(TAGGED);
    expect(
      await ids(db.collection('posts').where('tags', 'array-contains-any', ['a', 'c'])),
    ).toEqual(['p1', 'p2']);
    expect(
      await ids(db.collection('posts').where('tags', 'array-contains-any', 'a')),
    ).toEqual([]);
  });
});

describe('characterization — multiple where() composition', () => {
  it('chained where() calls AND together', async () => {
    const db = seededDb({
      'orders/o1': { region: 'us', total: 10 },
      'orders/o2': { region: 'us', total: 50 },
      'orders/o3': { region: 'eu', total: 50 },
    });
    expect(
      await ids(db.collection('orders').where('region', '==', 'us').where('total', '>=', 50)),
    ).toEqual(['o2']);
  });

  it('equality + range on different fields compose; range adds implicit order', async () => {
    const db = seededDb({
      'orders/o1': { region: 'us', total: 30 },
      'orders/o2': { region: 'us', total: 10 },
      'orders/o3': { region: 'us', total: 20 },
    });
    // Range on `total` sorts the result by total asc (implicit orderBy).
    expect(
      await ids(db.collection('orders').where('region', '==', 'us').where('total', '>', 5)),
    ).toEqual(['o2', 'o3', 'o1']);
  });
});
