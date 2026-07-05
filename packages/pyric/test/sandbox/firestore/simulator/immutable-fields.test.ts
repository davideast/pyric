/**
 * Tests for lifecycle.immutableFields() stdlib function.
 *
 * Uses MapDiff unchangedKeys().hasAll() — one expression instead of
 * N chained fieldUnchanged() calls. Identified in 5 stress test
 * scenarios as the most frequently needed stdlib addition.
 */
import { describe, test, expect } from 'bun:test';
import { LocalEnvironment } from 'pyric/sandbox/internal';
import { resolveModules } from 'pyric/rules/node';

function makeEnv(expr: string) {
  const SOURCE = `import { immutableFields } from 'lifecycle';
rules_version = '2+modules';
service cloud.firestore {
  match /databases/{database}/documents {
    match /test/{id} {
      allow create: if request.auth != null;
      allow update: if request.auth != null && ${expr};
    }
  }
}`;
  const r = resolveModules(SOURCE);
  if (!r.success) throw new Error(r.error.message);
  return r.data.resolved;
}

function run(expr: string, resource: Record<string, unknown>, data: Record<string, unknown>): boolean {
  const rules = makeEnv(expr);
  const env = new LocalEnvironment();
  env.seed({ rules, documents: { 'test/d1': resource } });
  return env.execute({ method: 'update', path: 'test/d1', auth: { uid: 'u1' }, data }).allowed;
}

describe('lifecycle.immutableFields()', () => {

  describe('basic behavior', () => {
    test('all immutable fields unchanged → ALLOW', () => {
      expect(run("immutableFields(['a', 'b', 'c'])", { a: 1, b: 2, c: 3, d: 'old' }, { a: 1, b: 2, c: 3, d: 'new' })).toBe(true);
    });

    test('one immutable field changed → DENY', () => {
      expect(run("immutableFields(['a', 'b', 'c'])", { a: 1, b: 2, c: 3, d: 'old' }, { a: 1, b: 999, c: 3, d: 'new' })).toBe(false);
    });

    test('all immutable fields changed → DENY', () => {
      expect(run("immutableFields(['a', 'b'])", { a: 1, b: 2 }, { a: 99, b: 99 })).toBe(false);
    });
  });

  describe('single field (equivalent to fieldUnchanged)', () => {
    test('unchanged → ALLOW', () => {
      expect(run("immutableFields(['createdBy'])", { createdBy: 'alice', title: 'old' }, { createdBy: 'alice', title: 'new' })).toBe(true);
    });

    test('changed → DENY', () => {
      expect(run("immutableFields(['createdBy'])", { createdBy: 'alice', title: 'old' }, { createdBy: 'hacker', title: 'new' })).toBe(false);
    });
  });

  describe('many fields (5)', () => {
    test('all 5 unchanged → ALLOW', () => {
      expect(run("immutableFields(['a', 'b', 'c', 'd', 'e'])", { a: 1, b: 2, c: 3, d: 4, e: 5, f: 'old' }, { a: 1, b: 2, c: 3, d: 4, e: 5, f: 'new' })).toBe(true);
    });

    test('last of 5 changed → DENY', () => {
      expect(run("immutableFields(['a', 'b', 'c', 'd', 'e'])", { a: 1, b: 2, c: 3, d: 4, e: 5, f: 'old' }, { a: 1, b: 2, c: 3, d: 4, e: 999, f: 'new' })).toBe(false);
    });
  });

  describe('type preservation', () => {
    test('string unchanged → ALLOW', () => {
      expect(run("immutableFields(['name'])", { name: 'Alice', score: 0 }, { name: 'Alice', score: 100 })).toBe(true);
    });

    test('boolean unchanged → ALLOW', () => {
      expect(run("immutableFields(['active'])", { active: true, count: 0 }, { active: true, count: 5 })).toBe(true);
    });

    test('boolean changed → DENY', () => {
      expect(run("immutableFields(['active'])", { active: true, count: 0 }, { active: false, count: 5 })).toBe(false);
    });

    test('number unchanged → ALLOW', () => {
      expect(run("immutableFields(['price'])", { price: 29.99, qty: 1 }, { price: 29.99, qty: 10 })).toBe(true);
    });

    test('number changed → DENY', () => {
      expect(run("immutableFields(['price'])", { price: 29.99, qty: 1 }, { price: 0.01, qty: 10 })).toBe(false);
    });
  });

  describe('combined with other conditions', () => {
    test('immutableFields + other condition both pass → ALLOW', () => {
      expect(run("immutableFields(['ownerId']) && request.resource.data.status == 'active'",
        { ownerId: 'alice', status: 'pending' }, { ownerId: 'alice', status: 'active' })).toBe(true);
    });

    test('immutableFields passes but other condition fails → DENY', () => {
      expect(run("immutableFields(['ownerId']) && request.resource.data.status == 'active'",
        { ownerId: 'alice', status: 'pending' }, { ownerId: 'alice', status: 'cancelled' })).toBe(false);
    });
  });
});
