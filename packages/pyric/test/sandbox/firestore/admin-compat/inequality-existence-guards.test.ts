/**
 * FS-B7 — `!=` / `not-in` (and the other field filters) require the
 * field to exist and respect null semantics.
 *
 * Before FS-B7, a missing field compared as `undefined`, so `!=` and
 * `not-in` MATCHED docs that lacked the field entirely (and matched
 * null-valued docs), surfacing docs a production query never returns.
 * Mirrors `clones/firebase-js-sdk/packages/firestore/src/core/filter.ts`
 * (`FieldFilter.matches` / `NotInFilter.matches`): the field must exist
 * (`doc.data.field(...) !== null`) and be non-null for `!=` / `not-in`.
 */
import { describe, it, expect } from 'bun:test';
import { LocalEnvironment } from 'pyric/sandbox/internal';
import { createCompatFirestore } from '../../../../src/sandbox/firestore/admin-compat/index.js';

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
      'items/has-a': { status: 'a' },
      'items/has-b': { status: 'b' },
      'items/is-null': { status: null },
      'items/missing': { other: 1 }, // no `status` field
    },
  });
  return createCompatFirestore(env, { auth: { uid: 'u' } });
}

describe('FS-B7 — != existence + null guards', () => {
  it('!= excludes the missing-field doc and the null doc', async () => {
    const snap = await db().collection('items').where('status', '!=', 'a').get();
    const ids = snap.docs.map((d) => d.id).sort();
    // Only has-b: not has-a (equal), not is-null (null), not missing (absent).
    // Pre-FS-B7 this also returned `missing` and `is-null`.
    expect(ids).toEqual(['has-b']);
  });
});

describe('FS-B7 — not-in existence + null guards', () => {
  it('not-in excludes missing + null docs', async () => {
    const snap = await db().collection('items')
      .where('status', 'not-in', ['a'])
      .get();
    const ids = snap.docs.map((d) => d.id).sort();
    expect(ids).toEqual(['has-b']);
  });

  it('not-in with a null in the operand list matches nothing', async () => {
    const snap = await db().collection('items')
      .where('status', 'not-in', ['a', null])
      .get();
    expect(snap.size).toBe(0);
  });
});

describe('FS-B7 — equality / range exclude the missing-field doc', () => {
  it('== never matches the missing-field doc', async () => {
    const snap = await db().collection('items').where('status', '==', 'a').get();
    expect(snap.docs.map((d) => d.id)).toEqual(['has-a']);
  });

  it('range filter excludes missing + cross-type docs', async () => {
    const snap = await db().collection('items').where('status', '>=', 'a').get();
    const ids = snap.docs.map((d) => d.id).sort();
    // has-a, has-b are strings >= 'a'; null + missing excluded.
    expect(ids).toEqual(['has-a', 'has-b']);
  });
});
