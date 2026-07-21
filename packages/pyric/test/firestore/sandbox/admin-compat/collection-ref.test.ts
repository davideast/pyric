import { describe, expect, test } from 'bun:test';
import { LocalEnvironment } from '../../../../src/firestore/sandbox/local-environment.js';
import { CollectionRefImpl } from '../../../../src/firestore/sandbox/admin-compat/collection-ref.js';

const OPEN_RULES = `rules_version = '2'; service cloud.firestore {
  match /databases/{database}/documents { match /{document=**} { allow read: if true; } }
}`;

describe('CollectionRefImpl', () => {
  test('creates navigable document references without a module cycle', async () => {
    const env = new LocalEnvironment();
    env.seed({ rules: OPEN_RULES, documents: { 'notes/a': { rank: 1 } } });
    const collection = new CollectionRefImpl(env, null, 'notes');

    expect(collection.doc('a').path).toBe('notes/a');
    expect(collection.doc('a').collection('comments').path).toBe('notes/a/comments');
    expect((await collection.where('rank', '==', 1).get()).docs.map((doc) => doc.id)).toEqual(['a']);
  });
});
