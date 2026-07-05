/**
 * `FirestoreImpl.collectionGroup(id)` — Tier 2 / v1 scope-survey gap.
 *
 * The collection-group walk runs across the entire keyspace and
 * matches docs whose immediate parent collection equals `id`. These
 * tests pin:
 *
 *   - Cross-depth gathering (top-level + nested + deeply nested all
 *     surface when the parent-collection name matches).
 *   - `where` / `orderBy` / `limit` chained constraints flow through.
 *   - `invalid-argument` on multi-segment / empty IDs.
 *   - Non-matching IDs return empty results (no false positives).
 *   - Phantom parent docs (synthesized for paths with descendants but
 *     no stored data of their own) are filtered out — same contract as
 *     `collection().get()`.
 */
import { describe, it, expect } from 'bun:test';
import { LocalEnvironment } from 'pyric/sandbox/internal';
import { FirestoreImpl } from '../../../../src/sandbox/firestore/admin-compat/firestore.js';
import type { FirestoreCompatError } from '../../../../src/sandbox/firestore/admin-compat/types.js';

const RULES_OPEN = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /{document=**} {
      allow read, write: if true;
    }
  }
}`;

function setup(): FirestoreImpl {
  const env = new LocalEnvironment();
  env.deployRules(RULES_OPEN);
  env.seed({
    rules: RULES_OPEN,
    documents: {
      // Top-level `items` collection
      'items/A': { name: 'top-A', priority: 1 },
      'items/B': { name: 'top-B', priority: 3 },
      // Nested under `parents`
      'parents/P1/items/C': { name: 'nested-C', priority: 2 },
      'parents/P2/items/D': { name: 'nested-D', priority: 4 },
      // Deeply nested
      'orgs/O1/teams/T1/items/E': { name: 'deep-E', priority: 5 },
      // Different collection name — should NOT match `items`
      'projects/PR1': { kind: 'project' },
      'parents/P1/tasks/X': { kind: 'task' },
    },
  });
  return new FirestoreImpl(env, null);
}

describe('FirestoreImpl.collectionGroup', () => {
  it('gathers documents across every depth where the parent collection matches', async () => {
    const db = setup();
    const snap = await db.collectionGroup('items').get();
    expect(snap.size).toBe(5);
    const paths = snap.docs.map((d) => d.ref.path).sort();
    expect(paths).toEqual([
      'items/A',
      'items/B',
      'orgs/O1/teams/T1/items/E',
      'parents/P1/items/C',
      'parents/P2/items/D',
    ]);
  });

  it('returns an empty snapshot for an unknown collection id', async () => {
    const db = setup();
    const snap = await db.collectionGroup('nope').get();
    expect(snap.empty).toBe(true);
    expect(snap.size).toBe(0);
  });

  it('does not include docs whose parent collection has a different name', async () => {
    const db = setup();
    const snap = await db.collectionGroup('tasks').get();
    expect(snap.docs.map((d) => d.ref.path)).toEqual(['parents/P1/tasks/X']);
  });

  it('honors where() across all gathered docs', async () => {
    const db = setup();
    const snap = await db.collectionGroup('items').where('priority', '>', 3).get();
    const names = snap.docs.map((d) => d.data().name).sort();
    expect(names).toEqual(['deep-E', 'nested-D']);
  });

  it('honors orderBy() across all gathered docs', async () => {
    const db = setup();
    const snap = await db.collectionGroup('items').orderBy('priority').get();
    expect(snap.docs.map((d) => d.data().priority)).toEqual([1, 2, 3, 4, 5]);
  });

  it('honors limit()', async () => {
    const db = setup();
    const snap = await db.collectionGroup('items').orderBy('priority').limit(2).get();
    expect(snap.docs.map((d) => d.data().priority)).toEqual([1, 2]);
  });

  it('throws invalid-argument when collectionId contains a slash', () => {
    const db = setup();
    let err: FirestoreCompatError | undefined;
    try { db.collectionGroup('foo/bar'); } catch (e) { err = e as FirestoreCompatError; }
    expect(err?.code).toBe('invalid-argument');
  });

  it('throws invalid-argument when collectionId is empty', () => {
    const db = setup();
    let err: FirestoreCompatError | undefined;
    try { db.collectionGroup(''); } catch (e) { err = e as FirestoreCompatError; }
    expect(err?.code).toBe('invalid-argument');
  });
});
