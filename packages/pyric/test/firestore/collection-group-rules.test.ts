/**
 * Collection-group reads under the rule shape Firebase documents for them:
 * `match /{path=**}/<collectionId>/{id}` with `rules_version = '2'`.
 *
 * The recursive segment matches zero or more leading segments, so the rule
 * governs every collection with that id at any depth, and a collection-group
 * query on that id is authorized by it. Direct document reads resolve the
 * same block. Production verdicts for the matcher are recorded in the
 * `recursive-wildcard-placement` rules corpus scenario.
 */
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { seedDocuments, setRules } from 'pyric/sandbox/firestore';
import {
  collectionGroup,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  query,
  where,
} from '../../src/firestore/index.js';

const SEED = {
  'users/u1/items/a': { owner: 'u1', visibility: 'public' },
  'users/u2/items/b': { owner: 'u2', visibility: 'private' },
  'items/c': { owner: 'root', visibility: 'public' },
  'users/u1/other/d': { owner: 'u1', visibility: 'public' },
};

function setup(rules: string, uid: string | null) {
  const sandbox = initializeSandbox();
  seedDocuments(sandbox, SEED);
  setRules(sandbox, `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
${rules}
  }
}`);
  const db = getFirestore(uid ? sandbox.withAuth({ uid }) : sandbox.withAuth(null));
  return { sandbox, db };
}

const SIGNED_IN_ITEMS = 'match /{path=**}/items/{id} { allow read: if request.auth != null; }';

describe('collection-group query under match /{path=**}/<collectionId>/{id}', () => {
  it('authorizes the query and returns every items document at any depth', async () => {
    const { db } = setup(SIGNED_IN_ITEMS, 'alice');
    const snap = await getDocs(collectionGroup(db, 'items'));
    expect(snap.docs.map((d) => d.ref.path).sort()).toEqual([
      'items/c',
      'users/u1/items/a',
      'users/u2/items/b',
    ]);
  });

  it('denies the query when the rule condition is false for the request', async () => {
    const { db } = setup(SIGNED_IN_ITEMS, null);
    await expect(getDocs(collectionGroup(db, 'items'))).rejects.toMatchObject({
      code: 'permission-denied',
    });
  });

  it('reads a document directly through the same rule, at the root and nested', async () => {
    const { db } = setup(SIGNED_IN_ITEMS, 'alice');
    expect((await getDoc(doc(db, 'users/u1/items/a'))).exists()).toBe(true);
    expect((await getDoc(doc(db, 'items/c'))).exists()).toBe(true);
    await expect(getDoc(doc(db, 'users/u1/other/d'))).rejects.toMatchObject({
      code: 'permission-denied',
    });
  });

  it('proves a data-gated rule against the query constraints', async () => {
    const { db } = setup(
      "match /{path=**}/items/{id} { allow list: if resource.data.visibility == 'public'; }",
      null,
    );
    const pub = await getDocs(query(collectionGroup(db, 'items'), where('visibility', '==', 'public')));
    expect(pub.docs.map((d) => d.ref.path).sort()).toEqual(['items/c', 'users/u1/items/a']);
    await expect(getDocs(collectionGroup(db, 'items'))).rejects.toMatchObject({
      code: 'permission-denied',
    });
  });

  it('does not authorize a group query from a rule for another collection id', async () => {
    const { db } = setup('match /{path=**}/other/{id} { allow read: if true; }', 'alice');
    const error = await getDocs(collectionGroup(db, 'items')).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'permission-denied' });
    expect(String((error as Error).message)).toContain('match /{path=**}/items/{id}');
  });

  it('does not authorize a group query from a rule that reads the recursive binding', async () => {
    const { db } = setup("match /{path=**}/items/{id} { allow read: if path == 'users/u1'; }", 'alice');
    await expect(getDocs(collectionGroup(db, 'items'))).rejects.toMatchObject({
      code: 'permission-denied',
    });
  });

  it('does not authorize a group query from concrete collection rules', async () => {
    const { db } = setup(`
    match /items/{id} { allow read: if true; }
    match /users/{uid}/items/{id} { allow read: if true; }`, 'alice');
    await expect(getDocs(collectionGroup(db, 'items'))).rejects.toMatchObject({
      code: 'permission-denied',
    });
  });
});
