import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import { renderResourcePattern } from '../../../src/sandbox/internal/resource-pattern.js';
import type { SdkServiceModel } from '../../../src/assurance-surface/code/service-models/types.js';
import {
  extractSdkUsage,
  type SdkUsageIndex,
  type SdkUsagePass,
} from '../../../src/assurance-surface/code/usage-index.js';

describe('extractSdkUsage (Slice 2.3)', () => {
  test('runs browser-clean in-memory extraction when globalThis.process is undefined', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'process');
    delete (globalThis as Record<string, unknown>).process;
    try {
      const usage = extractSdkUsage({
        root: 'app',
        files: {
          'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true } }),
          'src/refs.ts': `
            import { getFirestore, doc } from 'pyric/firestore';
            import { getAuth } from 'pyric/auth';
            const db = getFirestore();
            export function profileDoc() {
              const uid = getAuth().currentUser!.uid;
              return doc(db, 'users', uid);
            }
          `,
        },
      });
      expect(usage.filesScanned).toBe(1);
      expect(usage.refs).toHaveLength(1);
      expect(renderResourcePattern(usage.refs[0]!.pattern)).toBe('users/{uid}');
      expect(usage.refs[0]!.consumedBy).toEqual([]);
    } finally {
      if (descriptor) {
        Object.defineProperty(globalThis, 'process', descriptor);
      }
    }
  });

  test('promotes standalone exported and hook-passed refs and queries with resourceId and consumedBy: []', () => {
    const usage = extractSdkUsage({
      root: '/virtual/app',
      files: {
        'refs.ts': `
          import { getFirestore, collection, collectionGroup, doc, query, where, orderBy } from 'pyric/firestore';
          import { getDatabase, ref, refFromURL, push } from 'pyric/database';
          import { getAuth } from 'pyric/auth';
          declare const app: unknown;
          declare function useExternalQuery(q: unknown): unknown;

          const analyticsDb = getFirestore(app, 'analytics-db');
          const primaryRtdb = getDatabase(app);

          export const orgDoc = doc(analyticsDb, 'orgs', 'acme');
          export const entriesGroup = collectionGroup(analyticsDb, 'entries');
          export const secondaryUserRef = refFromURL(
            primaryRtdb,
            'https://secondary-rtdb.firebaseio.com/users/' + getAuth().currentUser!.uid,
          );
          export const mintedKey = push(ref(primaryRtdb, 'queues')).key;

          export function useOpenItems() {
            const uid = getAuth().currentUser!.uid;
            const itemsCol = collection(analyticsDb, 'items');
            const openQuery = query(itemsCol, where('ownerId', '==', uid), orderBy('createdAt', 'desc'));
            return useExternalQuery(openQuery);
          }
        `,
      },
    });

    const refSummaries = usage.refs.map((r) => ({
      service: r.pattern.service,
      resourceId: r.pattern.resourceId,
      refKind: r.refKind,
      path: renderResourcePattern(r.pattern),
      resolution: r.resolution,
      consumedBy: r.consumedBy,
    }));

    expect(refSummaries).toContainEqual({
      service: 'firestore',
      resourceId: 'analytics-db',
      refKind: 'doc',
      path: 'orgs/acme',
      resolution: 'resolved',
      consumedBy: [],
    });
    expect(refSummaries).toContainEqual({
      service: 'firestore',
      resourceId: 'analytics-db',
      refKind: 'collectionGroup',
      path: '{path=**}/entries',
      resolution: 'resolved',
      consumedBy: [],
    });
    expect(refSummaries).toContainEqual({
      service: 'rtdb',
      resourceId: 'secondary-rtdb',
      refKind: 'node',
      path: 'users/$uid',
      resolution: 'resolved',
      consumedBy: [],
    });
    expect(refSummaries).toContainEqual({
      service: 'rtdb',
      resourceId: '(default)',
      refKind: 'node',
      path: 'queues/$pushId',
      resolution: 'resolved',
      consumedBy: [],
    });

    expect(usage.queries).toHaveLength(1);
    const q = usage.queries[0]!;
    expect(q.consumedBy).toEqual([]);
    expect(q.baseRef.pattern.resourceId).toBe('analytics-db');
    expect(q.baseRef.refKind).toBe('collection');
    expect(renderResourcePattern(q.baseRef.pattern)).toBe('items');
    expect(q.constraints.map((c) => ({ kind: c.kind, field: c.field, op: c.op, direction: c.direction }))).toEqual([
      { kind: 'where', field: 'ownerId', op: '==', direction: undefined },
      { kind: 'orderBy', field: 'createdAt', op: undefined, direction: 'desc' },
    ]);
  });

  test('links consumed refs and queries to AccessSite reads and writes via consumedBy and supports SdkUsagePass', () => {
    const storageModel: SdkServiceModel = {
      service: 'storage',
      modules: ['pyric/storage'],
      handleFactories: { getStorage: { resourceArgIndex: 1, singleStringArgIsResource: true } },
      refConstructors: { ref: { refKind: 'object' } },
      constraints: {},
      operations: { uploadBytes: { op: 'uploadBytes', write: true, data: 1 } },
    };

    const usage = extractSdkUsage({
      root: '/virtual/app',
      serviceModels: [storageModel],
      files: {
        'items.ts': `
          import { getFirestore, collection, doc, query, where, getDocs, setDoc } from 'pyric/firestore';
          import { getStorage, ref as storageRef, uploadBytes } from 'pyric/storage';
          declare const app: unknown;
          const db = getFirestore(app);
          const bucket = getStorage(app, 'gs://assets-bucket');

          export async function run(uid: string, bytes: Uint8Array) {
            const itemRef = doc(db, 'items', uid);
            await setDoc(itemRef, { ownerId: uid });
            const q = query(collection(db, 'items'), where('ownerId', '==', uid));
            await getDocs(q);
            await uploadBytes(storageRef(bucket, 'uploads/' + uid + '/file.bin'), bytes);
          }
        `,
      },
    });

    const docRef = usage.refs.find((r) => r.refKind === 'doc' && renderResourcePattern(r.pattern) === 'items/{uid}');
    expect(docRef).toBeDefined();
    expect(docRef!.consumedBy).toEqual(['setDoc@items.ts:10']);

    const objRef = usage.refs.find((r) => r.refKind === 'object');
    expect(objRef).toBeDefined();
    expect(objRef!.pattern.resourceId).toBe('assets-bucket');
    expect(renderResourcePattern(objRef!.pattern)).toBe('uploads/{uid}/file.bin');
    expect(objRef!.consumedBy).toEqual(['uploadBytes@items.ts:13']);

    expect(usage.queries).toHaveLength(1);
    expect(usage.queries[0]!.consumedBy).toEqual(['query@items.ts:12']);
    expect(usage.queries[0]!.baseRef.consumedBy).toEqual(['query@items.ts:12']);

    const countConsumedQueries: SdkUsagePass<number, { minConsumers: number }> = (
      idx: SdkUsageIndex,
      ctx,
    ) => idx.queries.filter((entry) => entry.consumedBy.length >= ctx.minConsumers).length;

    expect(countConsumedQueries(usage, { minConsumers: 1 })).toBe(1);
  });

  test('degrades non-literal resource headers and untraced handle resource arguments to partial on (default)', () => {
    const storageModel: SdkServiceModel = {
      service: 'storage',
      modules: ['pyric/storage'],
      handleFactories: { getStorage: { resourceArgIndex: 1, singleStringArgIsResource: true } },
      refConstructors: { ref: { refKind: 'object' } },
      constraints: {},
      operations: {},
      defaultRefKind: 'object',
    };

    const usage = extractSdkUsage({
      root: '/virtual/app',
      serviceModels: [storageModel],
      files: {
        'dynamic-resources.ts': `
          import { getFirestore, collection, doc, query, where } from 'pyric/firestore';
          import { getDatabase, refFromURL } from 'pyric/database';
          import { getStorage, ref as storageRef } from 'pyric/storage';
          declare const app: unknown;
          declare const shard: string;
          declare const tenant: string;
          declare const bucket: string;

          const db = getFirestore(app);
          const rtdb = getDatabase(app);
          const storage = getStorage(app);

          export const rtdbDynamicHeader = refFromURL(rtdb, \`https://\${shard}.firebaseio.com/items/1\`);
          export const fsDynamicHeader = doc(db, \`/databases/\${tenant}/documents/items/1\`);
          export const gsDynamicHeader = storageRef(storage, \`gs://\${bucket}/files/a\`);
          export const restDynamicHeader = storageRef(storage, \`/b/\${bucket}/o/files/b\`);

          const tenantFs = getFirestore(app, tenant);
          export const tenantQuery = query(collection(tenantFs, 'orders'), where('open', '==', true));
        `,
      },
    });

    for (const r of usage.refs) {
      expect(r.pattern.resourceId).toBe('(default)');
      expect(r.pattern.resourceId).not.toContain('pyric_hole');
      expect(r.pattern.resourceId).not.toContain('PYRIC_HOLE');
      expect(r.resolution).toBe('partial');
    }

    const fsHeaderRef = usage.refs.find(
      (r) => r.pattern.service === 'firestore' && renderResourcePattern(r.pattern) === 'items/1',
    );
    expect(fsHeaderRef?.reason).toContain('resource header of doc() was not literal');

    const rtdbHeaderRef = usage.refs.find(
      (r) => r.pattern.service === 'rtdb' && renderResourcePattern(r.pattern) === 'items/1',
    );
    expect(rtdbHeaderRef?.reason).toContain('resource header of refFromURL() was not literal');

    const gsHeaderRef = usage.refs.find(
      (r) => r.pattern.service === 'storage' && renderResourcePattern(r.pattern) === 'files/a',
    );
    expect(gsHeaderRef?.reason).toContain('resource header of ref() was not literal');

    const restHeaderRef = usage.refs.find(
      (r) => r.pattern.service === 'storage' && renderResourcePattern(r.pattern) === 'files/b',
    );
    expect(restHeaderRef?.reason).toContain('resource header of ref() was not literal');

    expect(usage.queries).toHaveLength(1);
    expect(usage.queries[0]!.baseRef.pattern.resourceId).toBe('(default)');
    expect(usage.queries[0]!.baseRef.resolution).toBe('partial');
    expect(usage.queries[0]!.baseRef.reason).toContain('getFirestore()');
  });

  test('emits SdkQuery entries for every base branch across union collections, union databases, and caller-parameterized db helpers', () => {
    const usage = extractSdkUsage({
      root: '/virtual/app',
      files: {
        'multi-base.ts': `
          import { getFirestore, collection, query, where, getDocs, type Firestore } from 'pyric/firestore';
          declare const app: unknown;
          declare const archived: boolean;
          declare const useAnalytics: boolean;

          const defaultDb = getFirestore(app);
          const analyticsDb = getFirestore(app, 'analytics-db');

          export async function loadUnionCollection() {
            const colA = collection(defaultDb, 'activeItems');
            const colB = collection(defaultDb, 'archivedItems');
            return getDocs(query(archived ? colA : colB, where('enabled', '==', true)));
          }

          export async function loadUnionDatabase() {
            const db = useAnalytics ? analyticsDb : defaultDb;
            return getDocs(query(collection(db, 'metrics'), where('enabled', '==', true)));
          }

          function fetchEvents(db: Firestore) {
            return getDocs(query(collection(db, 'events'), where('enabled', '==', true)));
          }

          export async function loadCallerDatabases() {
            await fetchEvents(defaultDb);
            await fetchEvents(analyticsDb);
          }
        `,
      },
    });

    const queryBases = usage.queries.map((q) => ({
      resourceId: q.baseRef.pattern.resourceId,
      path: renderResourcePattern(q.baseRef.pattern),
      consumedBy: q.consumedBy,
    }));

    expect(
      queryBases.filter((q) => q.path === 'activeItems' || q.path === 'archivedItems'),
    ).toEqual([
      { resourceId: '(default)', path: 'activeItems', consumedBy: ['query@multi-base.ts:13'] },
      { resourceId: '(default)', path: 'archivedItems', consumedBy: ['query@multi-base.ts:13'] },
    ]);

    expect(
      queryBases
        .filter((q) => q.path === 'metrics')
        .map((q) => q.resourceId)
        .sort(),
    ).toEqual(['(default)', 'analytics-db']);

    const eventQueries = usage.queries.filter(
      (q) => renderResourcePattern(q.baseRef.pattern) === 'events',
    );
    expect(eventQueries.map((q) => q.baseRef.pattern.resourceId).sort()).toEqual([
      '(default)',
      'analytics-db',
    ]);
    expect(eventQueries.every((q) => q.consumedBy.length === 1)).toBe(true);
    expect(eventQueries.every((q) => q.through !== undefined)).toBe(true);
  });
});

describe('extractSdkUsage (Slice 2.4 - operands, composite filters, and query branches)', () => {
  test('enumerates conditional if, mutually exclusive if/else, unconditional sequential, dynamic orderBy, and cross-function helper query branches', () => {
    const usage = extractSdkUsage({
      root: '/virtual/app',
      files: {
        'helpers.ts': `
          import { query, where, type Query } from 'pyric/firestore';
          export function applyItemFilters(q: Query, opts: { city?: string; active?: boolean }) {
            if (opts.city) {
              q = query(q, where('city', '==', opts.city));
            }
            if (opts.active) {
              q = query(q, where('active', '==', true));
            }
            return q;
          }
        `,
        'queries.ts': `
          import { getFirestore, collection, query, where, orderBy, getDocs, type Query } from 'pyric/firestore';
          import { getAuth, getIdTokenResult } from 'pyric/auth';
          import { applyItemFilters } from './helpers.js';

          const db = getFirestore();

          export async function loadFilteredItems(opts: { city?: string; active?: boolean }) {
            const token = await getIdTokenResult(getAuth().currentUser!);
            let q: Query = query(collection(db, 'items'), where('orgId', '==', token.claims.orgId));
            q = applyItemFilters(q, opts);
            return getDocs(q);
          }

          export async function loadSortedDocs(byTitle: boolean) {
            let q: Query = collection(db, 'docs');
            if (byTitle) {
              q = query(q, orderBy('title', 'asc'));
            } else {
              q = query(q, orderBy('updatedAt', 'desc'));
            }
            return getDocs(q);
          }

          export async function loadSequentialEntries() {
            let q = query(collection(db, 'entries'), where('status', '==', 'open'));
            q = query(q, where('delta', '>', -5));
            q = query(q, orderBy('createdAt', 'desc'));
            return getDocs(q);
          }

          export function buildDynamicDirectionQuery(dir: 'asc' | 'desc') {
            return query(collection(db, 'metrics'), where('public', '==', true), orderBy('value', dir));
          }
        `,
      },
    });

    const itemsQueries = usage.queries.filter((q) => renderResourcePattern(q.baseRef.pattern) === 'items');
    expect(itemsQueries).toHaveLength(1);
    const itemsQ = itemsQueries[0]!;
    expect(itemsQ.consumedBy).toEqual(['query@queries.ts:12']);
    expect(itemsQ.branches).toHaveLength(4);
    expect(
      itemsQ.branches!.map((branch) => branch.map((c) => `${c.kind}:${c.field}:${c.operand?.kind ?? ''}`)),
    ).toEqual([
      ['where:orgId:auth'],
      ['where:orgId:auth', 'where:city:param'],
      ['where:orgId:auth', 'where:active:literal'],
      ['where:orgId:auth', 'where:city:param', 'where:active:literal'],
    ]);

    const docsQueries = usage.queries.filter((q) => renderResourcePattern(q.baseRef.pattern) === 'docs');
    expect(docsQueries).toHaveLength(1);
    const docsQ = docsQueries[0]!;
    expect(docsQ.branches).toEqual([
      [{ kind: 'orderBy', field: 'title', direction: 'asc' }],
      [{ kind: 'orderBy', field: 'updatedAt', direction: 'desc' }],
    ]);

    const entriesQueries = usage.queries.filter((q) => renderResourcePattern(q.baseRef.pattern) === 'entries');
    expect(entriesQueries).toHaveLength(1);
    const entriesQ = entriesQueries[0]!;
    expect(entriesQ.branches).toBeUndefined();
    expect(entriesQ.constraints).toEqual([
      { kind: 'where', field: 'status', op: '==', operand: { kind: 'literal', literal: 'open' } },
      { kind: 'where', field: 'delta', op: '>', operand: { kind: 'literal', literal: -5 } },
      { kind: 'orderBy', field: 'createdAt', direction: 'desc' },
    ]);

    const metricsQueries = usage.queries.filter((q) => renderResourcePattern(q.baseRef.pattern) === 'metrics');
    expect(metricsQueries).toHaveLength(1);
    expect(metricsQueries[0]!.consumedBy).toEqual([]);
    expect(metricsQueries[0]!.branches).toEqual([
      [
        { kind: 'where', field: 'public', op: '==', operand: { kind: 'literal', literal: true } },
        { kind: 'orderBy', field: 'value', direction: 'asc' },
      ],
      [
        { kind: 'where', field: 'public', op: '==', operand: { kind: 'literal', literal: true } },
        { kind: 'orderBy', field: 'value', direction: 'desc' },
      ],
    ]);
  });

  test('isolates read-position sequential query reassignments across early-return and subsequent reads', () => {
    const usage = extractSdkUsage({
      root: '/virtual/app',
      files: {
        'early-return.ts': `
          import { getFirestore, collection, query, where, orderBy, getDocs } from 'pyric/firestore';
          import { getAuth } from 'pyric/auth';
          const db = getFirestore();

          export async function loadItems(onlyMine: boolean) {
            const uid = getAuth().currentUser!.uid;
            let q = query(collection(db, 'items'), orderBy('createdAt', 'desc'));
            if (onlyMine) return getDocs(query(q, where('ownerId', '==', uid)));
            q = query(q, where('public', '==', true));
            return getDocs(q);
          }
        `,
      },
    });

    expect(usage.queries).toHaveLength(2);
    const mineQuery = usage.queries.find((q) => q.consumedBy.includes('query@early-return.ts:9'));
    const publicQuery = usage.queries.find((q) => q.consumedBy.includes('query@early-return.ts:11'));

    expect(mineQuery).toBeDefined();
    expect(mineQuery!.branches).toBeUndefined();
    expect(mineQuery!.constraints).toEqual([
      { kind: 'orderBy', field: 'createdAt', direction: 'desc' },
      { kind: 'where', field: 'ownerId', op: '==', operand: { kind: 'auth', auth: [{ source: 'auth.uid', certainty: 'exact' }] } },
    ]);

    expect(publicQuery).toBeDefined();
    expect(publicQuery!.branches).toBeUndefined();
    expect(publicQuery!.constraints).toEqual([
      { kind: 'orderBy', field: 'createdAt', direction: 'desc' },
      { kind: 'where', field: 'public', op: '==', operand: { kind: 'literal', literal: true } },
    ]);
  });

  test('preserves all conditional filter and sort branches on uncalled functions with default initializers', () => {
    const fixtureUrl = new URL('../../rules/fixtures/firestore-indexes/friendlyeats/source.original.js', import.meta.url);
    const fixtureSource = readFileSync(fixtureUrl, 'utf8');
    const usage = extractSdkUsage({
      root: '/virtual/app',
      files: {
        'tsconfig.json': JSON.stringify({ compilerOptions: { allowJs: true } }),
        'src/firestore.js': fixtureSource,
      },
    });

    const topLevelQueries = usage.queries.filter(
      (q) => !renderResourcePattern(q.baseRef.pattern).includes('/'),
    );
    expect(topLevelQueries.length).toBeGreaterThanOrEqual(2);
    for (const q of topLevelQueries) {
      expect(q.branches).toBeDefined();
      const fields = new Set(q.branches!.flatMap((b) => b.map((c) => `${c.kind}:${c.field}`)));
      expect(fields.has('where:category')).toBe(true);
      expect(fields.has('where:city')).toBe(true);
      expect(fields.has('where:price')).toBe(true);
      expect(fields.has('orderBy:avgRating')).toBe(true);
      expect(fields.has('orderBy:numRatings')).toBe(true);
    }
  });
});
