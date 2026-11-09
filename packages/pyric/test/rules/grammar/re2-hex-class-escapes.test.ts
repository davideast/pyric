import { describe, expect, test } from 'bun:test';
import { firestoreRules } from '../../../src/rules/index.js';
import { evaluateStorageRules, parseStorageRules } from '../../../src/storage/index.js';

function evalFirestore(expr: string, val: string): boolean {
  const ruleset = firestoreRules(`
    rules_version = '2';
    service cloud.firestore {
      match /databases/{database}/documents {
        match /items/{id} {
          allow get: if ${expr};
        }
      }
    }
  `);
  const summary = ruleset.simulate([
    {
      description: 'hex escape probe',
      expectation: 'ALLOW',
      method: 'get',
      path: '/items/item-1',
      auth: { uid: 'u1' },
      resource: { val },
    },
  ]);
  return summary.cases[0]!.decision === 'ALLOW';
}

function evalStorage(expr: string, val: string): boolean {
  const rules = parseStorageRules(`
    rules_version = '2';
    service firebase.storage {
      match /b/{bucket}/o {
        match /items/{id} {
          allow get: if ${expr};
        }
      }
    }
  `);
  return evaluateStorageRules(
    rules,
    {
      request: {
        auth: { uid: 'u1', token: {} },
        method: 'get',
        path: 'b/test-bucket/o/items/item-1',
      },
      resource: {
        name: 'items/item-1',
        bucket: 'test-bucket',
        size: 4,
        contentType: 'text/plain',
        metadata: { val },
      },
    },
    new Date('2026-01-01T00:00:00Z'),
  ).allowed;
}

describe('RE2 braced hex escapes inside character classes', () => {
  test('treats \\x{5e}, \\x{2d}, \\x{5d}, and \\x{5c} inside [...] as literal class members across matches, replace, and split', () => {
    expect(evalFirestore(String.raw`resource.data.val.matches('[\\x{5e}a]')`, 'a')).toBe(true);
    expect(evalFirestore(String.raw`resource.data.val.matches('[\\x{5e}a]')`, '^')).toBe(true);
    expect(evalFirestore(String.raw`resource.data.val.matches('[\\x{5e}a]')`, 'b')).toBe(false);
    expect(evalStorage(String.raw`resource.metadata.val.matches('[\\x{5e}a]')`, 'a')).toBe(true);
    expect(evalStorage(String.raw`resource.metadata.val.matches('[\\x{5e}a]')`, '^')).toBe(true);
    expect(evalStorage(String.raw`resource.metadata.val.matches('[\\x{5e}a]')`, 'b')).toBe(false);

    expect(evalFirestore(String.raw`resource.data.val.matches('[a\\x{2d}c]')`, '-')).toBe(true);
    expect(evalFirestore(String.raw`resource.data.val.matches('[a\\x{2d}c]')`, 'b')).toBe(false);
    expect(evalStorage(String.raw`resource.metadata.val.matches('[a\\x{2d}c]')`, '-')).toBe(true);
    expect(evalStorage(String.raw`resource.metadata.val.matches('[a\\x{2d}c]')`, 'b')).toBe(false);

    expect(evalFirestore(String.raw`resource.data.val.matches('[\\x{5d}a]')`, ']')).toBe(true);
    expect(evalStorage(String.raw`resource.metadata.val.matches('[\\x{5d}a]')`, ']')).toBe(true);

    expect(evalFirestore(String.raw`resource.data.val.matches('[\\x{5c}]')`, '\\')).toBe(true);
    expect(evalStorage(String.raw`resource.metadata.val.matches('[\\x{5c}]')`, '\\')).toBe(true);

    expect(evalFirestore(String.raw`resource.data.val.replace('[\\x{5e}a]', 'X') == 'Xbc'`, 'abc')).toBe(true);
    expect(evalStorage(String.raw`resource.metadata.val.split('[\\x{5e}a]') == ['b', '', 'c']`, 'ba^c')).toBe(true);
  });
});
