/**
 * Unit tests for classifyQueryCall. Each test parses a tiny source
 * string, locates the first `query(...)` call, and asserts the
 * classified output. Avoids depending on the rest of the extractor.
 */
import { describe, test, expect } from 'bun:test';
import ts from 'typescript';
import { classifyQueryCall } from '../../../../src/rules/indexes/extract/classify.js';
import { getCalleeName, parseSource } from '../../../../src/rules/indexes/extract/ast.js';

function findFirstQueryCall(src: string): ts.CallExpression {
  const sf = parseSource('test.js', src);
  let found: ts.CallExpression | null = null;
  function visit(n: ts.Node): void {
    if (found) return;
    if (ts.isCallExpression(n) && getCalleeName(n) === 'query') {
      found = n;
      return;
    }
    ts.forEachChild(n, visit);
  }
  visit(sf);
  if (!found) throw new Error('no query() call found in test source');
  return found;
}

describe('classifyQueryCall — INIT', () => {
  test('query(collection(db, "x")) → init, path "x", not group', () => {
    const call = findFirstQueryCall('const q = query(collection(db, "restaurants"));');
    const r = classifyQueryCall(call, 'q');
    expect(r.isInit).toBe(true);
    expect(r.collectionPath).toBe('restaurants');
    expect(r.isCollectionGroup).toBe(false);
    expect(r.fragments).toHaveLength(0);
  });

  test('query(collectionGroup(db, "name")) → init, group=true', () => {
    const call = findFirstQueryCall('const q = query(collectionGroup(db, "comments"));');
    const r = classifyQueryCall(call, 'q');
    expect(r.isInit).toBe(true);
    expect(r.collectionPath).toBe('comments');
    expect(r.isCollectionGroup).toBe(true);
  });

  test('query(collection(db, "a", id, "b")) → stitched path with {*}', () => {
    const call = findFirstQueryCall('const q = query(collection(db, "users", uid, "posts"));');
    const r = classifyQueryCall(call, 'q');
    expect(r.isInit).toBe(true);
    expect(r.collectionPath).toBe('users/{*}/posts');
  });

  test('query(collection(db, dynamic)) → null path', () => {
    const call = findFirstQueryCall('const q = query(collection(db, name));');
    const r = classifyQueryCall(call, 'q');
    expect(r.isInit).toBe(true);
    expect(r.collectionPath).toBeNull();
  });

  test('init with constraints emits both INIT and constraint fragments', () => {
    const call = findFirstQueryCall('const q = query(collection(db, "r"), where("city", "==", c), orderBy("rating", "desc"));');
    const r = classifyQueryCall(call, 'q');
    expect(r.isInit).toBe(true);
    expect(r.collectionPath).toBe('r');
    expect(r.fragments).toHaveLength(2);
    expect(r.fragments[0].kind).toBe('where');
    expect(r.fragments[0].filter).toEqual({ field: 'city', op: '==' });
    expect(r.fragments[1].kind).toBe('orderBy');
    expect(r.fragments[1].order).toEqual({ field: 'rating', direction: 'desc' });
  });
});

describe('classifyQueryCall — WRAP', () => {
  test('query(q, where(...)) → wrap, single where fragment', () => {
    const call = findFirstQueryCall('q = query(q, where("category", "==", c));');
    const r = classifyQueryCall(call, 'q');
    expect(r.isInit).toBe(false);
    expect(r.fragments).toHaveLength(1);
    expect(r.fragments[0].filter).toEqual({ field: 'category', op: '==' });
  });

  test('query(q, where(...), orderBy(...)) → both fragments', () => {
    const call = findFirstQueryCall('q = query(q, where("x", ">", 1), orderBy("y"));');
    const r = classifyQueryCall(call, 'q');
    expect(r.isInit).toBe(false);
    expect(r.fragments).toHaveLength(2);
    expect(r.fragments[0].kind).toBe('where');
    expect(r.fragments[0].filter).toEqual({ field: 'x', op: '>' });
    expect(r.fragments[1].kind).toBe('orderBy');
    expect(r.fragments[1].order).toEqual({ field: 'y', direction: 'asc' });
  });

  test('query(other, where(...)) → unknown (different var)', () => {
    const call = findFirstQueryCall('q = query(other, where("x", "==", 1));');
    const r = classifyQueryCall(call, 'q');
    expect(r.isInit).toBe(false);
    // First arg was an identifier other than `q` — treated as unknown,
    // single unknown fragment, no constraints processed.
    expect(r.fragments).toHaveLength(1);
    expect(r.fragments[0].kind).toBe('unknown');
  });
});

describe('classifyQueryCall — orderBy direction', () => {
  test('orderBy("f") defaults to asc', () => {
    const call = findFirstQueryCall('q = query(q, orderBy("f"));');
    const r = classifyQueryCall(call, 'q');
    expect(r.fragments[0].order?.direction).toBe('asc');
  });

  test('orderBy("f", "asc") → asc', () => {
    const call = findFirstQueryCall('q = query(q, orderBy("f", "asc"));');
    const r = classifyQueryCall(call, 'q');
    expect(r.fragments[0].order?.direction).toBe('asc');
  });

  test('orderBy("f", "desc") → desc', () => {
    const call = findFirstQueryCall('q = query(q, orderBy("f", "desc"));');
    const r = classifyQueryCall(call, 'q');
    expect(r.fragments[0].order?.direction).toBe('desc');
  });

  test('orderBy("f", dynamic) → both directions emitted', () => {
    const call = findFirstQueryCall('q = query(q, orderBy("f", dir));');
    const r = classifyQueryCall(call, 'q');
    expect(r.fragments).toHaveLength(2);
    expect(r.fragments.map(f => f.order?.direction).sort()).toEqual(['asc', 'desc']);
  });
});

describe('classifyQueryCall — constraints', () => {
  test('limit with numeric literal', () => {
    const call = findFirstQueryCall('q = query(q, limit(50));');
    const r = classifyQueryCall(call, 'q');
    expect(r.fragments[0].kind).toBe('limit');
    expect(r.fragments[0].limit).toBe(50);
  });

  test('limit with non-numeric → unknown', () => {
    const call = findFirstQueryCall('q = query(q, limit(n));');
    const r = classifyQueryCall(call, 'q');
    expect(r.fragments[0].kind).toBe('unknown');
  });

  test('where with dynamic field → unknown', () => {
    const call = findFirstQueryCall('q = query(q, where(field, "==", val));');
    const r = classifyQueryCall(call, 'q');
    expect(r.fragments[0].kind).toBe('unknown');
  });

  test('unrecognized constraint → unknown', () => {
    const call = findFirstQueryCall('q = query(q, startAt(snap));');
    const r = classifyQueryCall(call, 'q');
    expect(r.fragments[0].kind).toBe('unknown');
  });
});

describe('classifyQueryCall — empty / edge', () => {
  test('query() with no args → no init, no fragments', () => {
    const call = findFirstQueryCall('q = query();');
    const r = classifyQueryCall(call, 'q');
    expect(r.isInit).toBe(false);
    expect(r.fragments).toHaveLength(0);
  });
});
