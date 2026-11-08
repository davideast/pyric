import { describe, expect, test } from 'bun:test';
import { extractSdkUsage } from '../../../src/assurance-surface/code/usage-index.js';
import { firestoreIndexPass } from '../../../src/assurance-surface/passes/firestore-indexes.js';
import { extractIndexes } from '../../../src/indexes/extract/extractor.js';

describe('firestoreIndexPass', () => {
  test('extracts composite indexes across cross-file wrapper functions and arbitrary variable names', () => {
    const usage = extractSdkUsage({
      root: '/app',
      files: {
        'src/db.ts': `
          import { getFirestore } from 'firebase/firestore';
          declare const app: unknown;
          export const db = getFirestore(app);
        `,
        'src/filters.ts': `
          import { orderBy, query, where, type Query } from 'firebase/firestore';
          export function applyCatalogFilters(baseQuery: Query, category?: string, city?: string) {
            let next = baseQuery;
            if (category) next = query(next, where('category', '==', category));
            if (city) next = query(next, where('city', '==', city));
            return query(next, orderBy('rating', 'desc'));
          }
        `,
        'src/catalog.ts': `
          import { collection, getDocs, query } from 'firebase/firestore';
          import { db } from './db';
          import { applyCatalogFilters } from './filters';
          export async function loadCatalog(category?: string, city?: string) {
            let catalogQuery = query(collection(db, 'items'));
            catalogQuery = applyCatalogFilters(catalogQuery, category, city);
            return getDocs(catalogQuery);
          }
        `,
      },
    });

    const result = firestoreIndexPass(usage);
    expect(result.warnings).toEqual([]);
    expect(result.shapesEnumerated).toBe(4);
    expect(result.config.indexes).toEqual([
      {
        collectionGroup: 'items',
        queryScope: 'COLLECTION',
        fields: [
          { fieldPath: 'category', order: 'ASCENDING' },
          { fieldPath: 'rating', order: 'DESCENDING' },
        ],
      },
      {
        collectionGroup: 'items',
        queryScope: 'COLLECTION',
        fields: [
          { fieldPath: 'city', order: 'ASCENDING' },
          { fieldPath: 'rating', order: 'DESCENDING' },
        ],
      },
      {
        collectionGroup: 'items',
        queryScope: 'COLLECTION',
        fields: [
          { fieldPath: 'category', order: 'ASCENDING' },
          { fieldPath: 'city', order: 'ASCENDING' },
          { fieldPath: 'rating', order: 'DESCENDING' },
        ],
      },
    ]);
    expect(result.signals).toEqual([
      {
        collectionGroup: 'items',
        shapeCount: 4,
        fieldsTouched: ['category', 'city', 'rating'],
        overshootSuspected: true,
      },
    ]);
  });

  test('expands composite and/or filter constraints and collectionGroup queries', () => {
    const usage = extractSdkUsage({
      root: '/app',
      files: {
        'src/tasks.ts': `
          import { and, collectionGroup, getDocs, or, orderBy, query, where } from 'firebase/firestore';
          declare const db: unknown;
          export function watchAssignedTasks(uid: string) {
            return getDocs(
              query(
                collectionGroup(db, 'tasks'),
                and(
                  where('archived', '==', false),
                  or(where('ownerId', '==', uid), where('assigneeId', '==', uid)),
                ),
                orderBy('dueAt', 'asc'),
              ),
            );
          }
        `,
      },
    });

    const result = firestoreIndexPass(usage);
    expect(result.warnings).toEqual([]);
    expect(result.config.indexes).toEqual([
      {
        collectionGroup: 'tasks',
        queryScope: 'COLLECTION_GROUP',
        fields: [
          { fieldPath: 'archived', order: 'ASCENDING' },
          { fieldPath: 'ownerId', order: 'ASCENDING' },
          { fieldPath: 'dueAt', order: 'ASCENDING' },
        ],
      },
      {
        collectionGroup: 'tasks',
        queryScope: 'COLLECTION_GROUP',
        fields: [
          { fieldPath: 'archived', order: 'ASCENDING' },
          { fieldPath: 'assigneeId', order: 'ASCENDING' },
          { fieldPath: 'dueAt', order: 'ASCENDING' },
        ],
      },
    ]);
  });

  test('handles dynamic orderBy direction, cursor bounds without warnings, and named databases', () => {
    const usage = extractSdkUsage({
      root: '/app',
      files: {
        'src/multi-db.ts': `
          import { collection, getDocs, getFirestore, orderBy, query, startAfter, where } from 'firebase/firestore';
          declare const app: unknown;
          const primaryDb = getFirestore(app);
          const analyticsDb = getFirestore(app, 'analytics');

          export function queryPrimary(dir: 'asc' | 'desc', cursor: unknown) {
            return getDocs(
              query(
                collection(primaryDb, 'users', 'u1', 'entries'),
                where('status', '==', 'published'),
                orderBy('createdAt', dir),
                startAfter(cursor),
              ),
            );
          }

          export function queryAnalytics() {
            return getDocs(
              query(
                collection(analyticsDb, 'events'),
                where('kind', '==', 'click'),
                orderBy('at', 'desc'),
              ),
            );
          }
        `,
      },
    });

    const all = firestoreIndexPass(usage);
    expect(all.warnings).toEqual([]);
    expect(all.byDatabase['(default)']?.indexes).toEqual([
      {
        collectionGroup: 'entries',
        queryScope: 'COLLECTION',
        fields: [
          { fieldPath: 'status', order: 'ASCENDING' },
          { fieldPath: 'createdAt', order: 'ASCENDING' },
        ],
      },
      {
        collectionGroup: 'entries',
        queryScope: 'COLLECTION',
        fields: [
          { fieldPath: 'status', order: 'ASCENDING' },
          { fieldPath: 'createdAt', order: 'DESCENDING' },
        ],
      },
    ]);
    expect(all.byDatabase.analytics?.indexes).toEqual([
      {
        collectionGroup: 'events',
        queryScope: 'COLLECTION',
        fields: [
          { fieldPath: 'kind', order: 'ASCENDING' },
          { fieldPath: 'at', order: 'DESCENDING' },
        ],
      },
    ]);

    const scoped = firestoreIndexPass(usage, { databaseId: 'analytics' });
    expect(scoped.config.indexes).toEqual([
      {
        collectionGroup: 'events',
        queryScope: 'COLLECTION',
        fields: [
          { fieldPath: 'kind', order: 'ASCENDING' },
          { fieldPath: 'at', order: 'DESCENDING' },
        ],
      },
    ]);
  });

  test('emits unresolved-query, dynamic-collection-id, and unknown-callee warnings with accurate provenance', () => {
    const usage = extractSdkUsage({
      root: '/app',
      files: {
        'src/warnings.ts': `
          import { collection, getDocs, orderBy, query, where } from 'firebase/firestore';
          declare const db: unknown;
          declare function externalRef(): unknown;

          export function unresolvedBase() {
            return getDocs(query(externalRef() as never, where('a', '==', 1), orderBy('b', 'desc')));
          }

          export function dynamicLeaf(parentId: string, subName: string) {
            return getDocs(query(collection(db, 'parents', parentId, subName), where('a', '==', 1), orderBy('b', 'desc')));
          }

          export function dynamicOrderField(sortField: string) {
            return getDocs(query(collection(db, 'items'), where('a', '==', 1), orderBy(sortField)));
          }
        `,
      },
    });

    const result = firestoreIndexPass(usage);
    expect(result.config.indexes).toEqual([]);
    expect(result.warnings.map((w) => w.code).sort()).toEqual([
      'dynamic-collection-id',
      'unknown-callee',
      'unresolved-query',
    ]);
    const unresolved = result.warnings.find((w) => w.code === 'unresolved-query');
    expect(unresolved).toMatchObject({ file: 'src/warnings.ts', line: 7 });
    expect(unresolved?.message).toContain('query(...)');
  });

  test('rejects doc(...) base references with unresolved-query warning and strips redundant trailing __name__ ASCENDING', () => {
    const usage = extractSdkUsage({
      root: '/app',
      files: {
        'src/doc-and-name.ts': `
          import { collection, doc, documentId, getDocs, orderBy, query, where } from 'firebase/firestore';
          declare const db: unknown;

          export function queryOnDocRef() {
            return getDocs(query(doc(db, 'users', 'alice'), where('role', '==', 'admin'), orderBy('createdAt', 'desc')));
          }

          export function orderByDocIdAsc(uid: string) {
            return getDocs(query(collection(db, 'posts'), where('authorId', '==', uid), orderBy(documentId(), 'asc')));
          }

          export function orderByDocIdDesc(uid: string) {
            return getDocs(query(collection(db, 'posts'), where('authorId', '==', uid), orderBy(documentId(), 'desc')));
          }
        `,
      },
    });

    const result = firestoreIndexPass(usage);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatchObject({
      file: 'src/doc-and-name.ts',
      code: 'unresolved-query',
    });
    expect(result.warnings[0]?.message).toContain('document reference');

    expect(result.config.indexes).toEqual([
      {
        collectionGroup: 'posts',
        queryScope: 'COLLECTION',
        fields: [
          { fieldPath: 'authorId', order: 'ASCENDING' },
          { fieldPath: '__name__', order: 'DESCENDING' },
        ],
      },
    ]);
  });

  test('runs browser-clean without globalThis.process and extracts unimported snippets via extractIndexes', () => {
    const saved = Object.getOwnPropertyDescriptor(globalThis, 'process');
    Object.defineProperty(globalThis, 'process', {
      value: undefined,
      configurable: true,
      writable: true,
    });
    try {
      const usage = extractSdkUsage({
        root: '/app',
        files: {
          'src/snippet.ts': `
            import { collection, getDocs, orderBy, query, where } from 'firebase/firestore';
            declare const db: unknown;
            export function loadDocs() {
              return getDocs(query(collection(db, 'items'), where('kind', '==', 'book'), orderBy('publishedAt', 'desc')));
            }
          `,
        },
      });
      expect(firestoreIndexPass(usage).config.indexes).toHaveLength(1);

      const snippet = extractIndexes({
        files: [
          {
            name: 'test/snippet.test.js',
            source: `
              function loadDocs() {
                let q = query(collection(db, "items"));
                q = query(q, where("kind", "==", "book"), orderBy("publishedAt", "desc"));
                return q;
              }
            `,
          },
        ],
      });
      if (!snippet.success) throw new Error('extractIndexes failed');
      expect(snippet.data.config.indexes).toEqual([
        {
          collectionGroup: 'items',
          queryScope: 'COLLECTION',
          fields: [
            { fieldPath: 'kind', order: 'ASCENDING' },
            { fieldPath: 'publishedAt', order: 'DESCENDING' },
          ],
        },
      ]);
    } finally {
      if (saved) Object.defineProperty(globalThis, 'process', saved);
    }
  });
});
