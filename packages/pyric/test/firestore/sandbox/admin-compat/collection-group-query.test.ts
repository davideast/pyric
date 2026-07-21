import { describe, expect, test } from 'bun:test';
import { LocalEnvironment } from '../../../../src/firestore/sandbox/local-environment.js';
import { CollectionGroupQueryImpl } from '../../../../src/firestore/sandbox/admin-compat/collection-group-query.js';

const OPEN_RULES = `rules_version = '2'; service cloud.firestore {
  match /databases/{database}/documents { match /{document=**} { allow read: if true; } }
}`;

describe('CollectionGroupQueryImpl', () => {
  test('preserves collection-group scope across cloned query plans', async () => {
    const env = new LocalEnvironment();
    env.seed({ rules: OPEN_RULES, documents: {
      'items/top': { rank: 3 },
      'parents/a/items/low': { rank: 1 },
      'parents/b/items/mid': { rank: 2 },
      'parents/a/other/nope': { rank: 0 },
    } });
    const query = new CollectionGroupQueryImpl({
      env,
      auth: null,
      collectionId: 'items',
    }).orderBy('rank').limit(2);

    expect((await query.get()).docs.map((doc) => doc.ref.path)).toEqual([
      'parents/a/items/low',
      'parents/b/items/mid',
    ]);
  });
});
