/**
 * Unit tests for the annotation collector — pairs functions with their
 * leading JSDoc comments and parses any @firestore-* tags out of them.
 */
import { describe, test, expect } from 'bun:test';
import { parseSource } from '../../../../src/rules/indexes/extract/ast.js';
import { collectAnnotations } from '../../../../src/rules/indexes/extract/annotation-collect.js';

describe('collectAnnotations — function declarations', () => {
  test('function decl with @firestore-mutex annotation', () => {
    const sf = parseSource('a.js', `
      /**
       * @firestore-mutex { category, city, price }
       */
      function applyQueryFilters(q) { return q; }
    `);
    const found = collectAnnotations(sf);
    expect(found).toHaveLength(1);
    expect(found[0].functionName).toBe('applyQueryFilters');
    expect(found[0].hasFirestoreTag).toBe(true);
    expect(found[0].annotations.mutexGroups).toHaveLength(1);
    expect([...found[0].annotations.mutexGroups[0]]).toEqual(['category', 'city', 'price']);
    expect(found[0].warnings).toHaveLength(0);
  });

  test('function decl with no leading comment → empty annotations, no firestore tag', () => {
    const sf = parseSource('a.js', `
      function bare() { return 1; }
    `);
    const found = collectAnnotations(sf);
    expect(found).toHaveLength(1);
    expect(found[0].functionName).toBe('bare');
    expect(found[0].hasFirestoreTag).toBe(false);
    expect(found[0].annotations.mutexGroups).toHaveLength(0);
    expect(found[0].annotations.required.size).toBe(0);
    expect(found[0].annotations.budget).toBeUndefined();
  });

  test('function decl with non-firestore JSDoc → no annotations, no warnings', () => {
    const sf = parseSource('a.js', `
      /**
       * Apply UI filters.
       * @param q The base query.
       * @returns The filtered query.
       */
      function applyQueryFilters(q) { return q; }
    `);
    const found = collectAnnotations(sf);
    expect(found).toHaveLength(1);
    expect(found[0].hasFirestoreTag).toBe(false);
    expect(found[0].warnings).toHaveLength(0);
  });

  test('combined annotations on one function', () => {
    const sf = parseSource('a.js', `
      /**
       * @firestore-mutex { a, b }
       * @firestore-required tenantId
       * @firestore-budget 12
       */
      function f(q) { return q; }
    `);
    const found = collectAnnotations(sf);
    expect(found).toHaveLength(1);
    expect(found[0].annotations.mutexGroups).toHaveLength(1);
    expect([...found[0].annotations.required]).toEqual(['tenantId']);
    expect(found[0].annotations.budget).toBe(12);
  });
});

describe('collectAnnotations — variable-bound functions', () => {
  test('arrow function with leading annotation', () => {
    const sf = parseSource('a.js', `
      /** @firestore-mutex { country, region } */
      const filterByGeo = (q) => q;
    `);
    const found = collectAnnotations(sf);
    expect(found).toHaveLength(1);
    expect(found[0].functionName).toBe('filterByGeo');
    expect(found[0].hasFirestoreTag).toBe(true);
    expect([...found[0].annotations.mutexGroups[0]]).toEqual(['country', 'region']);
  });

  test('function expression with leading annotation', () => {
    const sf = parseSource('a.js', `
      /** @firestore-required tenantId */
      const fn = function (q) { return q; };
    `);
    const found = collectAnnotations(sf);
    expect(found).toHaveLength(1);
    expect(found[0].functionName).toBe('fn');
    expect([...found[0].annotations.required]).toEqual(['tenantId']);
  });
});

describe('collectAnnotations — multiple functions', () => {
  test('one annotated, one not — independent results', () => {
    const sf = parseSource('a.js', `
      /** @firestore-mutex { a, b } */
      function annotated(q) { return q; }

      function plain(q) { return q; }
    `);
    const found = collectAnnotations(sf);
    expect(found).toHaveLength(2);
    const a = found.find(f => f.functionName === 'annotated')!;
    const p = found.find(f => f.functionName === 'plain')!;
    expect(a.hasFirestoreTag).toBe(true);
    expect(p.hasFirestoreTag).toBe(false);
    expect(a.annotations.mutexGroups).toHaveLength(1);
    expect(p.annotations.mutexGroups).toHaveLength(0);
  });

  test('annotation does not leak to the next function', () => {
    const sf = parseSource('a.js', `
      /** @firestore-mutex { a, b } */
      function first(q) { return q; }

      function second(q) { return q; }
    `);
    const found = collectAnnotations(sf);
    const second = found.find(f => f.functionName === 'second')!;
    expect(second.annotations.mutexGroups).toHaveLength(0);
    expect(second.hasFirestoreTag).toBe(false);
  });
});

describe('collectAnnotations — typo / unknown tags surface warnings', () => {
  test('typo on a known tag → unknown-firestore-tag warning + hasFirestoreTag still true', () => {
    const sf = parseSource('a.js', `
      /** @firestore-mutext { a, b } */
      function f(q) { return q; }
    `);
    const found = collectAnnotations(sf);
    expect(found[0].hasFirestoreTag).toBe(true);
    expect(found[0].warnings.some(w => w.code === 'unknown-firestore-tag')).toBe(true);
  });
});
