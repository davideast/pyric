/**
 * FS-B5 (updateDoc dot-path FieldPaths) + FS-B6 (setDoc merge deep-merge).
 *
 * Pre-fix:
 *   - `updateDoc({'a.b': 2})` stored a literal top-level key `"a.b"`,
 *     leaving the real `a.b` stale (`value-resolver.ts` walked keys
 *     structurally; `LocalState.update` did `{...existing, ...writes}`).
 *   - `setDoc({a:{b:2}}, {merge:true})` shallow-replaced the whole `a`
 *     map, dropping sibling `a.c` (prod deep-merges nested maps).
 *
 * These probes reproduce the exact nested scenarios the round-1 oracles
 * (top-level-only) masked, against the clone semantics in
 * `model/object_value.ts` (`ObjectValue.set` / `getFieldsMap`) and
 * `lite-api/user_data_reader.ts` (`parseUpdateData` / `parseSetData`).
 */
import { describe, test, expect } from 'bun:test';
import { LocalEnvironment } from 'pyric/sandbox/internal';
import { FieldValue } from 'pyric/sandbox/admin-compat';
import { createCompatFirestore } from '../../../../src/sandbox/firestore/admin-compat/index.js';

const OPEN = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /{document=**} { allow read, write: if true; }
  }
}`;

function dbWith(documents: Record<string, Record<string, unknown>>) {
  const env = new LocalEnvironment();
  env.seed({ rules: OPEN, documents });
  return { env, db: createCompatFirestore(env, { auth: { uid: 'u' } }) };
}

// ─── FS-B5 — updateDoc dot-path FieldPaths ───────────────────────────────

describe('FS-B5 — updateDoc treats dot-path keys as nested FieldPaths', () => {
  test('a single dot-path sets the leaf and preserves siblings', async () => {
    const { env, db } = dbWith({ 'd/x': { a: { b: 1, c: 2 } } });
    await db.doc('d/x').update({ 'a.b': 99 });
    // Pre-fix: { a: {b:1,c:2}, 'a.b': 99 } — literal key + stale a.b.
    expect(env.getDocument('d/x')).toEqual({ a: { b: 99, c: 2 } });
  });

  test('a deep dot-path creates intermediate maps', async () => {
    const { env, db } = dbWith({ 'd/x': { a: { keep: 1 } } });
    await db.doc('d/x').update({ 'a.b.c': 7 });
    expect(env.getDocument('d/x')).toEqual({ a: { keep: 1, b: { c: 7 } } });
  });

  test('a single-segment map value REPLACES the whole map (not deep-merge)', async () => {
    // updateDoc({a: {...}}) overwrites `a` entirely — only dot-paths reach in.
    const { env, db } = dbWith({ 'd/x': { a: { b: 1, c: 2 } } });
    await db.doc('d/x').update({ a: { b: 99 } });
    expect(env.getDocument('d/x')).toEqual({ a: { b: 99 } });
  });

  test('deleteField() at a dot-path removes the nested leaf, preserving siblings', async () => {
    const { env, db } = dbWith({ 'd/x': { a: { b: 1, c: 2 } } });
    await db.doc('d/x').update({ 'a.b': FieldValue.delete() });
    expect(env.getDocument('d/x')).toEqual({ a: { c: 2 } });
  });
});

// ─── FS-B6 — setDoc(merge) deep-merges nested maps ───────────────────────

describe('FS-B6 — setDoc(merge:true) deep-merges nested maps', () => {
  test('a nested map merges field-by-field, preserving siblings', async () => {
    const { env, db } = dbWith({ 'd/x': { a: { c: 1 }, top: 'keep' } });
    await db.doc('d/x').set({ a: { b: 2 } }, { merge: true });
    // Pre-fix: { a: {b:2}, top:'keep' } — `a.c` was dropped (shallow).
    expect(env.getDocument('d/x')).toEqual({ a: { b: 2, c: 1 }, top: 'keep' });
  });

  test('deep nesting merges at every level', async () => {
    const { env, db } = dbWith({ 'd/x': { a: { b: { c: 1, d: 2 } } } });
    await db.doc('d/x').set({ a: { b: { c: 99 } } }, { merge: true });
    expect(env.getDocument('d/x')).toEqual({ a: { b: { c: 99, d: 2 } } });
  });

  test('merge on a missing doc creates with the full nested shape', async () => {
    const { env, db } = dbWith({});
    await db.doc('d/new').set({ a: { b: 1 } }, { merge: true });
    expect(env.getDocument('d/new')).toEqual({ a: { b: 1 } });
  });
});

// ─── FS-B6 — mergeFields with dotted paths ───────────────────────────────

describe('FS-B6 — mergeFields supports dotted field paths', () => {
  test('a dotted mergeField writes only that nested leaf', async () => {
    const { env, db } = dbWith({ 'd/x': { a: { b: 1, c: 2 }, other: 'keep' } });
    await db.doc('d/x').set(
      { a: { b: 99, c: 88 }, ignored: 'no' },
      { mergeFields: ['a.b'] },
    );
    // Only a.b is written; a.c preserved, `ignored` dropped, `other` kept.
    expect(env.getDocument('d/x')).toEqual({ a: { b: 99, c: 2 }, other: 'keep' });
  });
});
