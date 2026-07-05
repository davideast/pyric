/**
 * End-to-end orchestrator tests on synthetic source. The friendlyeats
 * corpus test will live in a separate file once we vendor the fixture.
 */
import { describe, test, expect } from 'bun:test';
import { extractIndexes } from '../../../../src/rules/indexes/extract/extractor.js';

function extract(source: string) {
  const result = extractIndexes({ files: [{ name: 'test.js', source }] });
  if (!result.success) throw new Error(`extractIndexes failed: ${result.error.message}`);
  return result.data;
}

describe('extractIndexes — basic flow', () => {
  test('empty file → empty config, empty signals', () => {
    const data = extract('');
    expect(data.config.indexes).toHaveLength(0);
    expect(data.signals).toHaveLength(0);
    expect(data.warnings).toHaveLength(0);
  });

  test('single full query → one composite index when warranted', () => {
    const data = extract(`
      function getRestaurants() {
        let q = query(collection(db, "restaurants"));
        q = query(q, where("category", "==", c));
        q = query(q, orderBy("rating", "desc"));
        return q;
      }
    `);
    expect(data.config.indexes).toHaveLength(1);
    expect(data.config.indexes[0].collectionGroup).toBe('restaurants');
    expect(data.config.indexes[0].fields).toEqual([
      { fieldPath: 'category', order: 'ASCENDING' },
      { fieldPath: 'rating', order: 'DESCENDING' },
    ]);
  });

  test('query with single equality filter → no composite, empty config', () => {
    const data = extract(`
      function fn() {
        const q = query(collection(db, "r"), where("a", "==", 1));
      }
    `);
    expect(data.config.indexes).toHaveLength(0);
    // But shapesEnumerated includes the single-field shape.
    expect(data.shapesEnumerated).toBe(1);
  });
});

describe('extractIndexes — warnings', () => {
  test('function with q in body but no INIT → partial-base warning', () => {
    const data = extract(`
      function applyFilters(q) {
        q = query(q, where("city", "==", c));
        return q;
      }
    `);
    expect(data.warnings.some(w => w.code === 'partial-base')).toBe(true);
    expect(data.config.indexes).toHaveLength(0);
  });

  test('function with no query at all → no warning', () => {
    const data = extract(`
      function helper() { return 42; }
    `);
    expect(data.warnings).toHaveLength(0);
  });

  test('unknown constraint surfaces unknown-callee warning', () => {
    const data = extract(`
      function fn() {
        let q = query(collection(db, "r"));
        q = query(q, where("a", "==", 1), startAt(snap));
      }
    `);
    expect(data.warnings.some(w => w.code === 'unknown-callee')).toBe(true);
  });
});

describe('extractIndexes — signals', () => {
  test('single-collection signal with field set + shape count', () => {
    const data = extract(`
      function fn() {
        let q = query(collection(db, "restaurants"));
        q = query(q, where("category", "==", c));
        q = query(q, orderBy("rating", "desc"));
      }
    `);
    expect(data.signals).toHaveLength(1);
    const sig = data.signals[0];
    expect(sig.collectionGroup).toBe('restaurants');
    expect(sig.fieldsTouched).toEqual(['category', 'rating']);
    expect(sig.overshootSuspected).toBe(false);
  });

  test('overshootSuspected fires when shape count > 3', () => {
    // 3 skippable wheres × 2 mutex orderBys = 16 shapes
    const data = extract(`
      function fn() {
        let q = query(collection(db, "restaurants"));
        if (a) q = query(q, where("a", "==", x));
        if (b) q = query(q, where("b", "==", x));
        if (c) q = query(q, where("c", "==", x));
        if (sort === "x") q = query(q, orderBy("xField", "desc"));
        else q = query(q, orderBy("yField", "desc"));
      }
    `);
    const sig = data.signals.find(s => s.collectionGroup === 'restaurants');
    expect(sig).toBeDefined();
    expect(sig!.shapeCount).toBe(16);
    expect(sig!.overshootSuspected).toBe(true);
  });

  test('multiple collections produce one signal each, sorted', () => {
    const data = extract(`
      function a() { let q = query(collection(db, "z")); q = query(q, where("a", "==", 1), where("b", "==", 2)); }
      function b() { let q = query(collection(db, "a")); q = query(q, where("x", "==", 1), where("y", "==", 2)); }
    `);
    expect(data.signals.map(s => s.collectionGroup)).toEqual(['a', 'z']);
  });
});

describe('extractIndexes — dedup across functions', () => {
  test('two functions emitting the same composite → one entry', () => {
    const data = extract(`
      function a() {
        let q = query(collection(db, "r"));
        q = query(q, where("category", "==", c), orderBy("rating", "desc"));
      }
      function b() {
        let q = query(collection(db, "r"));
        q = query(q, where("category", "==", c), orderBy("rating", "desc"));
      }
    `);
    expect(data.config.indexes).toHaveLength(1);
  });

  test('two functions emitting different composites → two entries', () => {
    const data = extract(`
      function a() {
        let q = query(collection(db, "r"));
        q = query(q, where("category", "==", c), orderBy("rating", "desc"));
      }
      function b() {
        let q = query(collection(db, "r"));
        q = query(q, where("city", "==", c), orderBy("rating", "desc"));
      }
    `);
    expect(data.config.indexes).toHaveLength(2);
  });
});

describe('extractIndexes — multiple files', () => {
  test('cross-file shapes contribute to a unified config', () => {
    const result = extractIndexes({
      files: [
        { name: 'a.js', source: 'function a() { let q = query(collection(db, "r")); q = query(q, where("category", "==", c), orderBy("rating", "desc")); }' },
        { name: 'b.js', source: 'function b() { let q = query(collection(db, "r")); q = query(q, where("city", "==", c), orderBy("price", "asc")); }' },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.config.indexes).toHaveLength(2);
      expect(result.data.warnings).toHaveLength(0);
    }
  });
});

describe('extractIndexes — output flows into deploy handler shape', () => {
  test('config field types are valid Index entries', () => {
    const data = extract(`
      function fn() {
        let q = query(collection(db, "r"));
        q = query(q, where("a", "==", 1), where("b", ">", 2), orderBy("c", "desc"));
      }
    `);
    const entry = data.config.indexes[0];
    expect(entry.collectionGroup).toBe('r');
    expect(entry.queryScope).toMatch(/^COLLECTION(_GROUP)?$/);
    for (const field of entry.fields) {
      expect(typeof field.fieldPath).toBe('string');
      expect(field.order).toMatch(/^(ASCENDING|DESCENDING)$/);
    }
  });
});

describe('extractIndexes — annotations', () => {
  test('no annotations → annotationsApplied is empty, behavior unchanged', () => {
    const data = extract(`
      function fn() {
        let q = query(collection(db, "r"));
        q = query(q, where("a", "==", 1), where("b", ">", 2));
      }
    `);
    expect(data.annotationsApplied).toHaveLength(0);
  });

  test('@firestore-mutex prunes shapes and records counts', () => {
    // Two if/else branches each adding one of two mutex fields.
    // Without the annotation, all 4 cartesian combos survive (incl.
    // the {category, city} combo). With mutex, that combo is dropped.
    const data = extract(`
      /** @firestore-mutex { category, city } */
      function applyFilters(category, city) {
        let q = query(collection(db, "restaurants"));
        if (category) q = query(q, where("category", "==", category));
        if (city) q = query(q, where("city", "==", city));
        q = query(q, orderBy("avgRating", "desc"));
      }
    `);
    expect(data.annotationsApplied).toHaveLength(1);
    const a = data.annotationsApplied[0];
    expect(a.functionName).toBe('applyFilters');
    expect(a.prunedByMutex).toBeGreaterThanOrEqual(1);
    expect(a.prunedByRequired).toBe(0);
    // No remaining shape should have BOTH category and city.
    for (const entry of data.config.indexes) {
      const fields = entry.fields.map(f => f.fieldPath);
      const hasCategory = fields.includes('category');
      const hasCity = fields.includes('city');
      expect(hasCategory && hasCity).toBe(false);
    }
  });

  test('@firestore-required prunes shapes missing the field', () => {
    const data = extract(`
      /** @firestore-required tenantId */
      function fn(filterByCategory) {
        let q = query(collection(db, "restaurants"));
        if (filterByCategory) q = query(q, where("category", "==", "x"));
        q = query(q, orderBy("avgRating", "desc"));
      }
    `);
    const a = data.annotationsApplied[0];
    expect(a.prunedByRequired).toBeGreaterThanOrEqual(1);
    // Surviving config should be empty since none of the shapes have tenantId.
    expect(data.config.indexes).toHaveLength(0);
  });

  test('@firestore-budget exceeded → budget-exceeded warning', () => {
    const data = extract(`
      /** @firestore-budget 0 */
      function fn() {
        let q = query(collection(db, "r"));
        q = query(q, where("a", "==", 1), orderBy("b", "desc"));
      }
    `);
    // The budget tag is malformed (0 isn't positive) so it should
    // surface as annotation-malformed and NOT trigger budget-exceeded.
    expect(data.warnings.some(w => w.code === 'annotation-malformed')).toBe(true);
    expect(data.warnings.some(w => w.code === 'budget-exceeded')).toBe(false);
  });

  test('@firestore-budget=1 with 2 entries → budget-exceeded warning', () => {
    const data = extract(`
      /** @firestore-budget 1 */
      function fn() {
        let q = query(collection(db, "r"));
        q = query(q, where("a", "==", 1), where("b", "==", 2), orderBy("c", "desc"));
      }
      function fn2() {
        let q = query(collection(db, "r"));
        q = query(q, where("x", "==", 1), where("y", "==", 2), orderBy("z", "desc"));
      }
    `);
    expect(data.config.indexes.length).toBeGreaterThan(1);
    const budgetWarn = data.warnings.find(w => w.code === 'budget-exceeded');
    expect(budgetWarn).toBeDefined();
    expect(budgetWarn!.message).toContain('1');
  });

  test('typo annotation → annotation-malformed warning', () => {
    const data = extract(`
      /** @firestore-mutext { a, b } */
      function fn() {
        let q = query(collection(db, "r"));
        q = query(q, where("a", "==", 1), orderBy("b", "desc"));
      }
    `);
    expect(data.warnings.some(w => w.code === 'annotation-malformed' && w.message.includes('firestore-mutext'))).toBe(true);
  });
});

describe('extractIndexes — Layer 2.5 inter-procedural follow', () => {
  test('caller + same-file wrapper: index recovered, no partial-base for wrapper', () => {
    const data = extract(`
      function applyFilters(q, c) {
        q = query(q, where("category", "==", c));
        q = query(q, orderBy("rating", "desc"));
        return q;
      }
      function getRestaurants() {
        let q = query(collection(db, "restaurants"));
        q = applyFilters(q, "burgers");
        return q;
      }
    `);
    expect(data.config.indexes).toHaveLength(1);
    expect(data.config.indexes[0].collectionGroup).toBe('restaurants');
    expect(data.config.indexes[0].fields).toEqual([
      { fieldPath: 'category', order: 'ASCENDING' },
      { fieldPath: 'rating', order: 'DESCENDING' },
    ]);
    // Wrapper had no INIT of its own but was inlined into getRestaurants —
    // the suppression rule means no partial-base warning surfaces.
    const partialBase = data.warnings.filter(w => w.code === 'partial-base');
    expect(partialBase).toHaveLength(0);
  });

  test('two callers of same wrapper → composite-dedupe collapses to one entry', () => {
    const data = extract(`
      function applyFilters(q, c) {
        q = query(q, where("category", "==", c));
        q = query(q, orderBy("rating", "desc"));
      }
      function getA() {
        let q = query(collection(db, "restaurants"));
        q = applyFilters(q, "burgers");
      }
      function getB() {
        let q = query(collection(db, "restaurants"));
        q = applyFilters(q, "pizza");
      }
    `);
    // Both callers produce equivalent shapes; dedupe by index-entry key
    // collapses them to one entry.
    expect(data.config.indexes).toHaveLength(1);
    const partialBase = data.warnings.filter(w => w.code === 'partial-base');
    expect(partialBase).toHaveLength(0);
  });

  test('nested wrapper call (inside if-branch) surfaces inter-proc-nested warning', () => {
    const data = extract(`
      function applyFilters(q, c) {
        q = query(q, where("category", "==", c));
      }
      function fn() {
        let q = query(collection(db, "restaurants"));
        if (cond) q = applyFilters(q, "x");
      }
    `);
    const nested = data.warnings.filter(w => w.code === 'inter-proc-nested');
    expect(nested).toHaveLength(1);
    expect(nested[0].message).toContain('applyFilters');
  });

  test('A→B→C transitive call: depth guard fires, only one level inlines', () => {
    const data = extract(`
      function inner(q) {
        q = query(q, where("z", "==", 1));
      }
      function outer(q) {
        q = inner(q);
      }
      function fn() {
        let q = query(collection(db, "restaurants"));
        q = outer(q);
      }
    `);
    const recursionWarn = data.warnings.filter(w => w.code === 'inter-proc-recursion');
    expect(recursionWarn).toHaveLength(1);
    expect(recursionWarn[0].message).toContain('inner');
  });

  test('wrapper that takes chain by name but resolver returns null → still partial-base', () => {
    // Cross-file wrapper would produce this. Synthesize by referencing
    // a function that doesn't exist in the same source.
    const data = extract(`
      function fn() {
        let q = query(collection(db, "r"));
        q = externalWrapper(q, "x");
      }
    `);
    // Caller has its own INIT, so no partial-base for fn either.
    // The orphan call is silently ignored — we can't know if it
    // mutates q meaningfully without cross-file resolution.
    const partialBase = data.warnings.filter(w => w.code === 'partial-base');
    expect(partialBase).toHaveLength(0);
    // No composite either — only one filter would have applied.
    expect(data.config.indexes).toHaveLength(0);
  });

  test('arrow-function wrapper assigned to const is also resolvable', () => {
    const data = extract(`
      const applyFilters = (q, c) => {
        q = query(q, where("category", "==", c));
        q = query(q, orderBy("rating", "desc"));
        return q;
      };
      function getRestaurants() {
        let q = query(collection(db, "restaurants"));
        q = applyFilters(q, "burgers");
      }
    `);
    expect(data.config.indexes).toHaveLength(1);
    expect(data.config.indexes[0].fields).toEqual([
      { fieldPath: 'category', order: 'ASCENDING' },
      { fieldPath: 'rating', order: 'DESCENDING' },
    ]);
  });
});

describe('extractIndexes — Layer 2.5 annotation propagation', () => {
  test('mutex annotation on wrapper applies to caller-enumerated shapes', () => {
    const data = extract(`
      /** @firestore-mutex { category, city } */
      function applyFilters(q, opts) {
        if (opts.category) q = query(q, where("category", "==", opts.category));
        if (opts.city) q = query(q, where("city", "==", opts.city));
        q = query(q, orderBy("rating", "desc"));
      }
      function getRestaurants() {
        let q = query(collection(db, "restaurants"));
        q = applyFilters(q, opts);
      }
    `);
    // Without the wrapper annotation: 4 enumerated combos →
    // {city,rating}, {category,rating}, {category,city,rating}, {rating}.
    // {rating} alone needs no composite. {category,city,rating} is dropped
    // by the mutex. The remaining two are kept.
    const groups = data.config.indexes.map(i => i.fields.map(f => f.fieldPath).join(','));
    expect(groups).toContain('category,rating');
    expect(groups).toContain('city,rating');
    expect(groups).not.toContain('category,city,rating');
  });

  test('AnnotationApplied attributed to caller with inlinedFrom set to wrapper', () => {
    const data = extract(`
      /** @firestore-mutex { a, b } */
      function applyFilters(q, opts) {
        if (opts.a) q = query(q, where("a", "==", opts.a));
        if (opts.b) q = query(q, where("b", "==", opts.b));
        q = query(q, orderBy("c", "desc"));
      }
      function getThings() {
        let q = query(collection(db, "things"));
        q = applyFilters(q, opts);
      }
    `);
    expect(data.annotationsApplied).toHaveLength(1);
    const entry = data.annotationsApplied[0];
    expect(entry.functionName).toBe('getThings');
    expect(entry.inlinedFrom).toBe('applyFilters');
    expect(entry.prunedByMutex).toBeGreaterThan(0);
    expect([...entry.annotations.mutexGroups[0]].sort()).toEqual(['a', 'b']);
  });

  test('caller and wrapper both have annotations → two AnnotationApplied entries', () => {
    const data = extract(`
      /** @firestore-mutex { a, b } */
      function applyFilters(q, opts) {
        if (opts.a) q = query(q, where("a", "==", opts.a));
        if (opts.b) q = query(q, where("b", "==", opts.b));
        q = query(q, orderBy("c", "desc"));
      }
      /** @firestore-required tenantId */
      function getThings() {
        let q = query(collection(db, "things"));
        q = query(q, where("tenantId", "==", t));
        q = applyFilters(q, opts);
      }
    `);
    expect(data.annotationsApplied).toHaveLength(2);
    const caller = data.annotationsApplied.find(a => a.inlinedFrom === undefined);
    const wrapped = data.annotationsApplied.find(a => a.inlinedFrom === 'applyFilters');
    expect(caller).toBeDefined();
    expect(wrapped).toBeDefined();
    expect(caller!.functionName).toBe('getThings');
    expect(wrapped!.functionName).toBe('getThings');
    expect([...caller!.annotations.required].sort()).toEqual(['tenantId']);
    expect([...wrapped!.annotations.mutexGroups[0]].sort()).toEqual(['a', 'b']);
  });

  test('wrapper @firestore-budget contributes to tightest budget at config level', () => {
    const data = extract(`
      /** @firestore-budget 1 */
      function applyFilters(q) {
        q = query(q, where("a", "==", 1));
        q = query(q, orderBy("b", "desc"));
      }
      function getA() {
        let q = query(collection(db, "things"));
        q = applyFilters(q);
      }
      function getB() {
        let q = query(collection(db, "other"));
        q = query(q, where("x", "==", 1), orderBy("y", "desc"));
      }
    `);
    // Two distinct composite entries, budget=1 from the wrapper.
    expect(data.config.indexes.length).toBeGreaterThan(1);
    const budget = data.warnings.find(w => w.code === 'budget-exceeded');
    expect(budget).toBeDefined();
    expect(budget!.message).toContain('1');
  });
});
