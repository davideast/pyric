import { expect, test } from 'bun:test';
import { compileFunction, compilePolicy } from '../../src/policy/index.js';
import { firestoreRules } from '../../src/index.js';

test('a parameterized value helper has the same collection and index semantics on both paths', () => {
  const count = compileFunction(`function countFirst(items) {
    let first = items[0];
    return items.size() - items.removeAll([first]).size();
  }`);
  expect(Number(count([3, 1, 3]))).toBe(2);
  const emitted = count.firestoreModule();
  expect(emitted).toContain('export function countFirst(items)');
  const fn = emitted.slice(emitted.indexOf('export function') + 'export '.length);
  const rules = firestoreRules(`rules_version = '2'; service cloud.firestore {
    match /databases/{db}/documents { ${fn}
      match /items/{id} { allow update: if countFirst(resource.data.items) == request.resource.data.count; }
    }
  }`);
  const rows = rules.simulate([2, 3].map(count => ({
    method:'update' as const, description:'count ' + count, path:'items/one',
    resource:{items:[3, 1, 3]}, data:{count}, expectation:'ALLOW' as const,
  }))).cases;
  expect(rows.map(r => r.decision)).toEqual(['ALLOW', 'DENY']);
});

test('pure functions keep lexical scope and collection error absorption', () => {
  expect(compileFunction('function test(items) { return items[99].size() == 0 || true; }')([])).toBe(true);
  for (const source of [
    'function wrong(a) { return a.removeAll(); }',
    'function unknown(a) { return a[missing]; }',
    'function masked(a) { return false && a.get(1, 2); }',
  ]) expect(() => compileFunction(source)).toThrow();
  expect(() => compileFunction('function get(a) { return a; }').firestoreModule()).toThrow('builtin');
  expect(() => compilePolicy('transition only { require r { return after.items.size() == 1; } }')).toThrow('subset');
});
