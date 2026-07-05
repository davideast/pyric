/**
 * Unit tests for enumerateShapes. Builds QueryBaseDecls by hand —
 * keeps these tests independent of the dataflow walker.
 */
import { describe, test, expect } from 'bun:test';
import { enumerateShapes, pruneByAnnotations } from '../../../../src/rules/indexes/extract/enumerate.js';
import type { Annotations, Fragment, QueryBaseDecl, QueryShape } from '../../../../src/rules/indexes/extract/types.js';

function unconditional(kind: 'where' | 'orderBy', spec: Record<string, unknown>): Fragment {
  return {
    kind,
    filter: kind === 'where' ? (spec as { field: string; op: string }) : undefined,
    order: kind === 'orderBy' ? (spec as { field: string; direction: 'asc' | 'desc' }) : undefined,
    branchId: null,
    clauseId: null,
    skippable: false,
  };
}

function branched(
  kind: 'where' | 'orderBy',
  spec: Record<string, unknown>,
  ctx: { branchId: number; clauseId: number; skippable: boolean },
): Fragment {
  return {
    kind,
    filter: kind === 'where' ? (spec as { field: string; op: string }) : undefined,
    order: kind === 'orderBy' ? (spec as { field: string; direction: 'asc' | 'desc' }) : undefined,
    branchId: ctx.branchId,
    clauseId: ctx.clauseId,
    skippable: ctx.skippable,
  };
}

const baseDecl = (fragments: Fragment[]): QueryBaseDecl => ({
  varName: 'q',
  collectionPath: 'restaurants',
  isCollectionGroup: false,
  fragments,
});

describe('enumerateShapes — base cases', () => {
  test('null collectionPath → no shapes', () => {
    const shapes = enumerateShapes({ varName: 'q', collectionPath: null, isCollectionGroup: false, fragments: [] });
    expect(shapes).toHaveLength(0);
  });

  test('no fragments → one shape (just the base)', () => {
    const shapes = enumerateShapes(baseDecl([]));
    expect(shapes).toHaveLength(1);
    expect(shapes[0].filters).toHaveLength(0);
    expect(shapes[0].orders).toHaveLength(0);
  });

  test('only unconditional fragments → one shape with all of them', () => {
    const shapes = enumerateShapes(baseDecl([
      unconditional('where', { field: 'a', op: '==' }),
      unconditional('orderBy', { field: 'b', direction: 'asc' }),
    ]));
    expect(shapes).toHaveLength(1);
    expect(shapes[0].filters).toEqual([{ field: 'a', op: '==' }]);
    expect(shapes[0].orders).toEqual([{ field: 'b', direction: 'asc' }]);
  });
});

describe('enumerateShapes — branches', () => {
  test('skippable single-clause branch → 2 shapes (with and without)', () => {
    const shapes = enumerateShapes(baseDecl([
      branched('where', { field: 'city', op: '==' }, { branchId: 1, clauseId: 0, skippable: true }),
    ]));
    expect(shapes).toHaveLength(2);
    expect(shapes.find(s => s.filters.length === 0)).toBeDefined();
    expect(shapes.find(s => s.filters.length === 1)).toBeDefined();
  });

  test('non-skippable two-clause branch (if/else) → 2 shapes, mutex', () => {
    const shapes = enumerateShapes(baseDecl([
      branched('orderBy', { field: 'rating', direction: 'desc' }, { branchId: 1, clauseId: 0, skippable: false }),
      branched('orderBy', { field: 'reviews', direction: 'desc' }, { branchId: 1, clauseId: 1, skippable: false }),
    ]));
    expect(shapes).toHaveLength(2);
    expect(shapes.every(s => s.orders.length === 1)).toBe(true);
    expect(shapes.map(s => s.orders[0].field).sort()).toEqual(['rating', 'reviews']);
  });

  test('two skippable branches → 4 shapes (cartesian product)', () => {
    const shapes = enumerateShapes(baseDecl([
      branched('where', { field: 'a', op: '==' }, { branchId: 1, clauseId: 0, skippable: true }),
      branched('where', { field: 'b', op: '==' }, { branchId: 2, clauseId: 0, skippable: true }),
    ]));
    // Choices: {a, skip} × {b, skip} = 4 combos
    expect(shapes).toHaveLength(4);
  });

  test('three skippable branches × 2 mutex orderBys → 16 shapes', () => {
    const shapes = enumerateShapes(baseDecl([
      branched('where', { field: 'a', op: '==' }, { branchId: 1, clauseId: 0, skippable: true }),
      branched('where', { field: 'b', op: '==' }, { branchId: 2, clauseId: 0, skippable: true }),
      branched('where', { field: 'c', op: '==' }, { branchId: 3, clauseId: 0, skippable: true }),
      branched('orderBy', { field: 'r', direction: 'desc' }, { branchId: 4, clauseId: 0, skippable: false }),
      branched('orderBy', { field: 'n', direction: 'desc' }, { branchId: 4, clauseId: 1, skippable: false }),
    ]));
    // 2 × 2 × 2 × 2 = 16. (This mirrors the friendlyeats wrap-pattern shape.)
    expect(shapes).toHaveLength(16);
  });

  test('unconditional + branched coexist correctly', () => {
    const shapes = enumerateShapes(baseDecl([
      unconditional('where', { field: 'kind', op: '==' }),
      branched('orderBy', { field: 'rating', direction: 'desc' }, { branchId: 1, clauseId: 0, skippable: true }),
    ]));
    expect(shapes).toHaveLength(2);
    // Both shapes carry the unconditional filter.
    expect(shapes.every(s => s.filters.length === 1 && s.filters[0].field === 'kind')).toBe(true);
    // One shape has the orderBy, one doesn't.
    expect(shapes.filter(s => s.orders.length === 1)).toHaveLength(1);
    expect(shapes.filter(s => s.orders.length === 0)).toHaveLength(1);
  });
});

describe('enumerateShapes — dedupe', () => {
  test('duplicate combos collapse', () => {
    // Two skippable branches both adding the SAME constraint produce
    // {[],[X],[X],[X,X-but-deduped]} → after dedupe: 2 unique shapes
    // (empty and {X}) since {X,X-skipped} == {X-skipped, X} == {X}.
    const shapes = enumerateShapes(baseDecl([
      branched('where', { field: 'a', op: '==' }, { branchId: 1, clauseId: 0, skippable: true }),
      branched('where', { field: 'a', op: '==' }, { branchId: 2, clauseId: 0, skippable: true }),
    ]));
    // Combos: ([], [], a, a, a) but dedupe collapses {a} duplicates and
    // {a, a} to {a, a}. Distinct shapes: [], [a], [a, a].
    expect(shapes.length).toBeLessThanOrEqual(3);
    expect(shapes.length).toBeGreaterThanOrEqual(2);
  });
});

// ── pruneByAnnotations ────────────────────────────────────────────────
function shape(filters: { field: string; op: string }[], orders: { field: string; direction: 'asc' | 'desc' }[] = []): QueryShape {
  return {
    collectionPath: 'restaurants',
    isCollectionGroup: false,
    filters,
    orders,
    limit: null,
  };
}

const empty: Annotations = { mutexGroups: [], required: new Set() };

describe('pruneByAnnotations — no-op cases', () => {
  test('undefined annotations → input passthrough, zero counts', () => {
    const shapes = [shape([{ field: 'a', op: '==' }])];
    const r = pruneByAnnotations(shapes, undefined);
    expect(r.shapes).toBe(shapes);
    expect(r.prunedByMutex).toBe(0);
    expect(r.prunedByRequired).toBe(0);
  });

  test('empty annotations → input passthrough', () => {
    const shapes = [shape([{ field: 'a', op: '==' }])];
    const r = pruneByAnnotations(shapes, empty);
    expect(r.shapes).toBe(shapes);
  });
});

describe('pruneByAnnotations — @firestore-mutex', () => {
  test('drops shapes with 2+ fields from a mutex group', () => {
    const shapes = [
      shape([{ field: 'category', op: '==' }, { field: 'city', op: '==' }]), // 2 hits → drop
      shape([{ field: 'category', op: '==' }]),                                // 1 hit → keep
      shape([{ field: 'tenantId', op: '==' }]),                                // 0 hits → keep
    ];
    const annotations: Annotations = {
      mutexGroups: [new Set(['category', 'city', 'price'])],
      required: new Set(),
    };
    const r = pruneByAnnotations(shapes, annotations);
    expect(r.shapes).toHaveLength(2);
    expect(r.prunedByMutex).toBe(1);
    expect(r.prunedByRequired).toBe(0);
  });

  test('mutex applies to fields in orderBy too, not just filters', () => {
    const shapes = [
      shape([{ field: 'category', op: '==' }], [{ field: 'city', direction: 'asc' }]),
    ];
    const annotations: Annotations = {
      mutexGroups: [new Set(['category', 'city'])],
      required: new Set(),
    };
    const r = pruneByAnnotations(shapes, annotations);
    expect(r.shapes).toHaveLength(0);
    expect(r.prunedByMutex).toBe(1);
  });

  test('multiple mutex groups — violating any one drops the shape', () => {
    const shapes = [shape([{ field: 'plan', op: '==' }, { field: 'tier', op: '==' }])];
    const annotations: Annotations = {
      mutexGroups: [new Set(['country', 'region']), new Set(['plan', 'tier'])],
      required: new Set(),
    };
    const r = pruneByAnnotations(shapes, annotations);
    expect(r.shapes).toHaveLength(0);
    expect(r.prunedByMutex).toBe(1);
  });
});

describe('pruneByAnnotations — @firestore-required', () => {
  test('drops shapes missing any required field', () => {
    const shapes = [
      shape([{ field: 'tenantId', op: '==' }, { field: 'city', op: '==' }]),  // has tenantId → keep
      shape([{ field: 'city', op: '==' }]),                                    // missing tenantId → drop
    ];
    const annotations: Annotations = {
      mutexGroups: [],
      required: new Set(['tenantId']),
    };
    const r = pruneByAnnotations(shapes, annotations);
    expect(r.shapes).toHaveLength(1);
    expect(r.prunedByRequired).toBe(1);
    expect(r.prunedByMutex).toBe(0);
  });

  test('required field present in orderBy counts', () => {
    const shapes = [shape([{ field: 'a', op: '==' }], [{ field: 'tenantId', direction: 'asc' }])];
    const annotations: Annotations = { mutexGroups: [], required: new Set(['tenantId']) };
    const r = pruneByAnnotations(shapes, annotations);
    expect(r.shapes).toHaveLength(1);
    expect(r.prunedByRequired).toBe(0);
  });

  test('multiple required fields — all must be present', () => {
    const shapes = [
      shape([{ field: 'tenantId', op: '==' }, { field: 'ownerId', op: '==' }]),
      shape([{ field: 'tenantId', op: '==' }]),
    ];
    const annotations: Annotations = { mutexGroups: [], required: new Set(['tenantId', 'ownerId']) };
    const r = pruneByAnnotations(shapes, annotations);
    expect(r.shapes).toHaveLength(1);
    expect(r.prunedByRequired).toBe(1);
  });
});

describe('pruneByAnnotations — mutex + required combined', () => {
  test('mutex check happens first; mutex-violating shape attributed to mutex even if also missing required', () => {
    const shapes = [shape([{ field: 'category', op: '==' }, { field: 'city', op: '==' }])];
    const annotations: Annotations = {
      mutexGroups: [new Set(['category', 'city'])],
      required: new Set(['tenantId']),
    };
    const r = pruneByAnnotations(shapes, annotations);
    expect(r.shapes).toHaveLength(0);
    expect(r.prunedByMutex).toBe(1);
    expect(r.prunedByRequired).toBe(0);
  });

  test('combined annotation typical case', () => {
    const shapes = [
      shape([{ field: 'tenantId', op: '==' }, { field: 'category', op: '==' }]),  // keep
      shape([{ field: 'tenantId', op: '==' }, { field: 'category', op: '==' }, { field: 'city', op: '==' }]), // mutex drop
      shape([{ field: 'category', op: '==' }]),  // missing tenantId → required drop
    ];
    const annotations: Annotations = {
      mutexGroups: [new Set(['category', 'city', 'price'])],
      required: new Set(['tenantId']),
    };
    const r = pruneByAnnotations(shapes, annotations);
    expect(r.shapes).toHaveLength(1);
    expect(r.prunedByMutex).toBe(1);
    expect(r.prunedByRequired).toBe(1);
  });
});
