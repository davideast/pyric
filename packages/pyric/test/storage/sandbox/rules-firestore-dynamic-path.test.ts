import { describe, test, expect } from 'bun:test';
import { parseStorageRules } from '../../../src/storage/sandbox/rules.js';
import { evaluateStorageRules } from '../../../src/storage/sandbox/rules-evaluator.js';

describe('08-storage-firestore-dynamic-path-and-value-wrapping', () => {
  const path = 'b/pyric-default/o/docs/d1.json';

  function evalFs(
    cond: string,
    docs: Record<string, Record<string, unknown>>,
    auth: { uid: string } | null = { uid: 'alice' },
  ): { allowed: boolean; reasons: string[] } {
    const rules = parseStorageRules(`service firebase.storage {
      match /b/{bucket}/o {
        match /docs/{docId} { allow read: if ${cond}; }
      }
    }`);
    const lookup = {
      get(p: string) {
        return p in docs ? docs[p] : null;
      },
      exists(p: string) {
        return p in docs;
      },
    };
    return evaluateStorageRules(
      rules,
      { request: { auth, method: 'read', path }, resource: { size: 1 } },
      undefined,
      lookup,
    );
  }

  test('allows firestore.get with dynamic string-concatenated path expression', () => {
    const r = evalFs(
      "firestore.get('/databases/(default)/documents/users/' + request.auth.uid).data.premium == true",
      { 'users/alice': { premium: true } },
    );
    expect(r.allowed).toBe(true);
  });

  test('allows firestore.exists with path() constructor expression', () => {
    const r = evalFs(
      "firestore.exists(path('/databases/(default)/documents/users/' + request.auth.uid))",
      { 'users/alice': { premium: true } },
    );
    expect(r.allowed).toBe(true);
  });
});
