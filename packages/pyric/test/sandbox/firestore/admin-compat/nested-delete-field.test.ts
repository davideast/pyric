/**
 * FS-B13 — nested `deleteField()` throws instead of destroying sibling data.
 *
 * `deleteField()` may only appear at the top level of an `updateDoc` — as a
 * whole field value or via a dot-path key. Nested inside a map LITERAL
 * (`updateDoc({a: {b: deleteField()}})`) it is invalid; prod throws
 * `invalid-argument` ("FieldValue.delete() can only appear at the top level
 * of your update data"). Pre-fix the sandbox stripped the nested marker and
 * silently wrote `a = {}`, destroying the sibling `a.c`.
 *
 * Mirrors `clones/.../lite-api/user_data_reader.ts:DeleteFieldValueImpl`.
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

describe('FS-B13 — nested deleteField() is invalid-argument', () => {
  test('deleteField() nested in a map literal throws and leaves data intact', async () => {
    const { env, db } = dbWith({ 'd/x': { a: { b: 1, c: 2 } } });
    let err: unknown;
    try {
      await db.doc('d/x').update({ a: { b: FieldValue.delete() } });
    } catch (e) { err = e; }
    expect((err as { code?: string }).code).toBe('invalid-argument');
    // Sibling data untouched — pre-fix this became `{ a: {} }`.
    expect(env.getDocument('d/x')).toEqual({ a: { b: 1, c: 2 } });
  });

  test('top-level deleteField() is still valid', async () => {
    const { env, db } = dbWith({ 'd/x': { a: 1, b: 2 } });
    await db.doc('d/x').update({ b: FieldValue.delete() });
    expect(env.getDocument('d/x')).toEqual({ a: 1 });
  });

  test('dot-path deleteField() is still valid (FS-B5 path)', async () => {
    const { env, db } = dbWith({ 'd/x': { a: { b: 1, c: 2 } } });
    await db.doc('d/x').update({ 'a.b': FieldValue.delete() });
    expect(env.getDocument('d/x')).toEqual({ a: { c: 2 } });
  });
});
