/**
 * End-to-end orchestrator tests for `extractIndexes` over `SdkUsageIndex`
 * and `firestoreIndexPass`.
 */
import { describe, expect, test } from 'bun:test';
import { extractIndexes } from '../../../src/indexes/extract/extractor.js';
import { analyzeIndexQuery, readIndexConfig } from '../../../src/indexes/query-analysis.js';

function extract(source: string) {
  const result = extractIndexes({ files: [{ name: 'test.js', source }] });
  if (!result.success) throw new Error(`extractIndexes failed: ${result.error.message}`);
  return result.data;
}

describe('extractIndexes: basic flow', () => {
  test('empty file yields empty config and empty signals', () => {
    const data = extract('');
    expect(data.config.indexes).toHaveLength(0);
    expect(data.signals).toHaveLength(0);
    expect(data.warnings).toHaveLength(0);
  });

  test('single full query yields one composite index when warranted', () => {
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

  test('query with single equality filter needs no composite index', () => {
    const data = extract(`
      function fn() {
        const q = query(collection(db, "r"), where("a", "==", 1));
      }
    `);
    expect(data.config.indexes).toHaveLength(0);
    expect(data.shapesEnumerated).toBe(1);
  });
});

describe('extractIndexes: warnings', () => {
  test('uncalled wrapper function with parameter base emits unresolved-query warning', () => {
    const data = extract(`
      function applyFilters(q) {
        q = query(q, where("city", "==", c));
        return q;
      }
    `);
    expect(data.warnings.some((w) => w.code === 'unresolved-query')).toBe(true);
    expect(data.config.indexes).toHaveLength(0);
  });

  test('function with no query emits no warning', () => {
    const data = extract(`
      function helper() { return 42; }
    `);
    expect(data.warnings).toHaveLength(0);
  });

  test('unrecognized custom constraint surfaces unknown-callee warning while SDK cursor bounds do not', () => {
    const unknownConstraint = extract(`
      function fn() {
        let q = query(collection(db, "r"));
        q = query(q, where("a", "==", 1), customConstraint(snap));
      }
    `);
    expect(unknownConstraint.warnings.some((w) => w.code === 'unknown-callee')).toBe(true);

    const cursorBound = extract(`
      function fn() {
        let q = query(collection(db, "r"));
        q = query(q, where("a", "==", 1), orderBy("b", "asc"), startAt(snap));
      }
    `);
    expect(cursorBound.warnings).toEqual([]);
    expect(cursorBound.config.indexes).toHaveLength(1);
  });
});

describe('extractIndexes: signals', () => {
  test('single-collection signal reports field set and shape count', () => {
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
    const sig = data.signals.find((s) => s.collectionGroup === 'restaurants');
    expect(sig).toBeDefined();
    expect(sig!.shapeCount).toBe(16);
    expect(sig!.overshootSuspected).toBe(true);
  });

  test('multiple collections produce one signal each, sorted', () => {
    const data = extract(`
      function a() { let q = query(collection(db, "z")); q = query(q, where("a", "==", 1), where("b", "==", 2)); }
      function b() { let q = query(collection(db, "a")); q = query(q, where("x", "==", 1), where("y", "==", 2)); }
    `);
    expect(data.signals.map((s) => s.collectionGroup)).toEqual(['a', 'z']);
  });
});

describe('extractIndexes: dedup and multi-file cross-module wrappers', () => {
  test('two functions emitting the same composite collapse to one entry', () => {
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

  test('two functions emitting different composites keep two entries', () => {
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

  test('cross-file shapes and cross-file helper functions resolve without warnings', () => {
    const result = extractIndexes({
      files: [
        {
          name: 'src/filters.ts',
          source: `
            import { orderBy, query, where } from 'firebase/firestore';
            export function applySortAndCategory(base, category) {
              let next = query(base, where('category', '==', category));
              return query(next, orderBy('rating', 'desc'));
            }
          `,
        },
        {
          name: 'src/queries.ts',
          source: `
            import { collection, getDocs, orderBy, query, where } from 'firebase/firestore';
            import { applySortAndCategory } from './filters';
            declare const db: unknown;
            export function loadByCategory(c: string) {
              const base = query(collection(db, 'r'));
              return getDocs(applySortAndCategory(base, c));
            }
            export function loadByCity(city: string) {
              return getDocs(query(collection(db, 'r'), where('city', '==', city), orderBy('price', 'asc')));
            }
          `,
        },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.config.indexes).toHaveLength(2);
      expect(result.data.warnings).toHaveLength(0);
    }
  });

  test('multi-level transitive helpers and nested branch calls resolve cleanly', () => {
    const data = extract(`
      function inner(q) {
        return query(q, orderBy("rating", "desc"));
      }
      function outer(q, c) {
        const next = query(q, where("category", "==", c));
        return inner(next);
      }
      function getRestaurants(cond, c) {
        let q = query(collection(db, "restaurants"));
        if (cond) q = outer(q, c);
        return getDocs(q);
      }
    `);
    expect(data.warnings).toEqual([]);
    expect(data.config.indexes).toEqual([
      {
        collectionGroup: 'restaurants',
        queryScope: 'COLLECTION',
        fields: [
          { fieldPath: 'category', order: 'ASCENDING' },
          { fieldPath: 'rating', order: 'DESCENDING' },
        ],
      },
    ]);
  });
});

describe('extractIndexes: output flows into deploy handler shape', () => {
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

  test('array-contains + orderBy produces a valid CONTAINS index covered by analyzeIndexQuery', () => {
    const data = extract(`
      function getTaggedRestaurants() {
        let q = query(collection(db, "restaurants"));
        q = query(q, where("tags", "array-contains", "vegan"));
        q = query(q, orderBy("rating", "desc"));
        return q;
      }
    `);
    expect(data.config.indexes).toHaveLength(1);
    expect(data.config.indexes[0].fields).toEqual([
      { fieldPath: 'tags', arrayConfig: 'CONTAINS' },
      { fieldPath: 'rating', order: 'DESCENDING' },
    ]);
    const validated = readIndexConfig(data.config);
    const finding = analyzeIndexQuery(
      {
        collectionGroup: 'restaurants',
        queryScope: 'COLLECTION',
        filters: [{ field: 'tags', op: 'array-contains' }],
        orders: [{ field: 'rating', direction: 'desc' }],
      },
      validated,
    );
    expect(finding).toEqual({ status: 'covered', basis: 'configured' });
  });

  test('two-sided range on one field needs no composite index, and equality + two-sided range deduplicates the range field', () => {
    const singleFieldRange = extract(`
      function getByPriceBand() {
        let q = query(collection(db, "restaurants"));
        q = query(q, where("price", ">=", 10), where("price", "<=", 100));
        return q;
      }
    `);
    expect(singleFieldRange.config.indexes).toHaveLength(0);

    const compositeRange = extract(`
      function getCategoryByPriceBand() {
        let q = query(collection(db, "restaurants"));
        q = query(q, where("category", "==", "Mexican"), where("price", ">=", 10), where("price", "<=", 100));
        return q;
      }
    `);
    expect(compositeRange.config.indexes).toHaveLength(1);
    expect(compositeRange.config.indexes[0].fields).toEqual([
      { fieldPath: 'category', order: 'ASCENDING' },
      { fieldPath: 'price', order: 'ASCENDING' },
    ]);
  });
});

describe('extractIndexes: dynamic collection id', () => {
  const twoConstraints = `
        q = query(q, where("status", "==", s));
        q = query(q, orderBy("createdAt", "desc"));
        return q;`;

  test('a query whose collection id is dynamic emits no index and warns once', () => {
    const data = extract(`
      function listChildren(parentId, childCollection) {
        let q = query(collection(db, "parents", parentId, childCollection));${twoConstraints}
      }
    `);
    expect(data.config.indexes).toEqual([]);
    expect(data.signals.map((s) => s.collectionGroup)).not.toContain('{*}');
    const skipped = data.warnings.filter((w) => w.code === 'dynamic-collection-id');
    expect(skipped).toHaveLength(1);
    expect(skipped[0].message).toContain('index for a wildcard collection id skipped: name the collection');
  });

  test('a literal collection id under a dynamic parent still emits its index', () => {
    const data = extract(`
      function listPosts(uid) {
        let q = query(collection(db, "users", uid, "posts"));${twoConstraints}
      }
    `);
    expect(data.config.indexes).toHaveLength(1);
    expect(data.config.indexes[0].collectionGroup).toBe('posts');
    expect(data.warnings.filter((w) => w.code === 'dynamic-collection-id')).toEqual([]);
  });
});

describe('extractIndexes: a query passed inline to a reader (#2427)', () => {
  const RECENT_PROJECTS_INDEX = {
    collectionGroup: 'projects',
    queryScope: 'COLLECTION_GROUP',
    fields: [
      { fieldPath: 'ownerId', order: 'ASCENDING' },
      { fieldPath: 'updatedAt', order: 'DESCENDING' },
    ],
  };
  const RECENT_PROJECTS = `query(collectionGroup(db, 'projects'), where('ownerId', '==', ownerId), orderBy('updatedAt', 'desc'))`;

  test('a query assigned to q first yields the index', () => {
    const data = extract(`
      export async function recentProjects(ownerId) {
        const q = ${RECENT_PROJECTS};
        return getDocs(q);
      }
    `);
    expect(data.config.indexes).toEqual([RECENT_PROJECTS_INDEX]);
    expect(data.warnings).toEqual([]);
  });

  test('a query passed straight into getDocs yields the same index', () => {
    const data = extract(`
      export async function recentProjects(ownerId) {
        return getDocs(${RECENT_PROJECTS});
      }
    `);
    expect(data.config.indexes).toEqual([RECENT_PROJECTS_INDEX]);
    expect(data.warnings).toEqual([]);
  });

  for (const reader of ['onSnapshot', 'getCountFromServer', 'getAggregateFromServer', 'getDocsFromServer']) {
    test(`a query passed straight into ${reader} yields the index`, () => {
      const data = extract(`
        export function watch(ownerId, cb) {
          return ${reader}(${RECENT_PROJECTS}, cb);
        }
      `);
      expect(data.config.indexes).toEqual([RECENT_PROJECTS_INDEX]);
      expect(data.warnings).toEqual([]);
    });
  }

  test('an inline query in an arrow function with an expression body yields the index', () => {
    const data = extract(`
      export const recentProjects = (ownerId) => getDocs(${RECENT_PROJECTS});
    `);
    expect(data.config.indexes).toEqual([RECENT_PROJECTS_INDEX]);
  });

  test('a query assigned to a variable not named q yields the index', () => {
    const data = extract(`
      export async function recentProjects(ownerId) {
        const recent = ${RECENT_PROJECTS};
        return getDocs(recent);
      }
    `);
    expect(data.config.indexes).toEqual([RECENT_PROJECTS_INDEX]);
    expect(data.warnings).toEqual([]);
  });

  test('an inline query that narrows the q chain adds to the chain', () => {
    const data = extract(`
      export async function recentProjects(ownerId) {
        const q = query(collectionGroup(db, 'projects'), where('ownerId', '==', ownerId));
        return getDocs(query(q, orderBy('updatedAt', 'desc')));
      }
    `);
    expect(data.config.indexes).toEqual([RECENT_PROJECTS_INDEX]);
    expect(data.warnings).toEqual([]);
  });

  test('a query built on a helper the analysis cannot resolve warns with its file and line', () => {
    const data = extract(`export async function recentProjects(ownerId) {
  return getDocs(query(projectsOf(db), where('ownerId', '==', ownerId), orderBy('updatedAt', 'desc')));
}
`);
    expect(data.config.indexes).toEqual([]);
    expect(data.warnings).toHaveLength(1);
    expect(data.warnings[0]).toMatchObject({ file: 'test.js', line: 2, code: 'unresolved-query' });
  });

  test('a query on an unresolved parameter warns with its file and line', () => {
    const data = extract(`export async function recentProjects(base) {
  const recent = query(base, orderBy('updatedAt', 'desc'));
  return getDocs(recent);
}
`);
    expect(data.warnings).toHaveLength(1);
    expect(data.warnings[0]).toMatchObject({ file: 'test.js', line: 2, code: 'unresolved-query' });
  });

  test('a query at module scope yields the index', () => {
    const data = extract(`
      const snapshot = await getDocs(query(collectionGroup(db, 'projects'), where('ownerId', '==', 'a'), orderBy('updatedAt', 'desc')));
    `);
    expect(data.config.indexes).toEqual([RECENT_PROJECTS_INDEX]);
  });

  test('an inline query inside a nested callback is counted once', () => {
    const data = extract(`
      export function useProjects(ownerId) {
        useEffect(() => onSnapshot(query(collectionGroup(db, 'projects'), where('ownerId', '==', ownerId), orderBy(field)), cb), []);
      }
    `);
    expect(data.warnings.filter((w) => w.code === 'unknown-callee')).toHaveLength(1);
  });
});
