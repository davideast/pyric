import type { Sandbox } from 'pyric/sandbox';
import type { RemoteSandbox } from '../../../cli/src/remote/index.js';
import { initializeApp } from '../../src/app/index.js';
import { FieldValue, getFirestore } from '../../src/firestore/index.js';
import { isAdminVectorValue } from '../../src/firestore/admin-vector-and-errors.js';
import {
  syncThrewAny,
  type AdminVectorLike,
  type AdminVectorQueryAndDiscoverySubject,
} from '../../../conformance/probes/firestore-admin/firestore-admin-vector-query-and-discovery.ts';

interface ConvertedModel {
  readonly id: string;
  readonly label: string;
  readonly score: number;
}

export function createAdminVectorQueryReplaySubject(
  adminSandbox: Sandbox | RemoteSandbox,
  basePath: string,
  armTag: string,
): AdminVectorQueryAndDiscoverySubject {
  const mainApp = initializeApp(
    { sandbox: adminSandbox, projectId: 'proj-1' },
    `fs-admin-vq-${armTag}`,
  );
  const mainDb = getFirestore(mainApp);
  const itemsCol = mainDb.collection(`${basePath}/items`) as ReturnType<typeof mainDb.collection> & {
    orderBy(f: string, dir?: 'asc' | 'desc'): typeof itemsCol;
    offset(n: number): typeof itemsCol;
    limitToLast(n: number): typeof itemsCol;
    select(...fields: string[]): typeof itemsCol;
    count(): { get(): Promise<{ data(): { count: number } }> };
    stream(): AsyncIterable<{ readonly id: string }>;
    findNearest(
      field: string,
      qv: number[],
      opts: { limit: number; distanceMeasure: 'COSINE' | 'EUCLIDEAN' | 'DOT_PRODUCT' },
    ): { get(): Promise<unknown>; query: { isEqual(other: unknown): boolean } };
    explain(opts?: { analyze?: boolean }): Promise<{
      metrics: {
        planSummary: { indexesUsed: unknown[] };
        executionStats: {
          resultsReturned: number;
          readOperations: number;
          executionDuration: { seconds: number };
        } | null;
      };
      snapshot: { docs: Array<{ id: string }> } | null;
    }>;
    explainStream(opts?: { analyze?: boolean }): AsyncIterable<{
      readonly document?: { readonly id: string };
      readonly metrics?: unknown;
    }>;
  };

  return {
    createVector: (values) => FieldValue.vector(values) as AdminVectorLike,
    isVector: (val): val is AdminVectorLike => isAdminVectorValue(val),
    async seedVectorAndQueryItems(v1, v2) {
      await itemsCol.doc('a').set({ title: 'Alpha', rank: 1, meta: { tag: 'x', secret: 'hide-a' }, embedding: v1 });
      await itemsCol.doc('b').set({ title: 'Beta', rank: 2, meta: { tag: 'y', secret: 'hide-b' }, embedding: v2 });
      await itemsCol.doc('c').set({ title: 'Gamma', rank: 3, meta: { tag: 'z', secret: 'hide-c' } });
    },
    readItem: async (id) =>
      (await itemsCol.doc(id).get()) as unknown as {
        readonly id: string;
        readonly exists: boolean;
        data(): Record<string, unknown> | undefined;
      },
    async runSelectAndOffset() {
      const snap = await itemsCol.orderBy('rank', 'asc').offset(1).select('title', 'meta.tag').get();
      const selectedIds = snap.docs.map((d) => d.id);
      const projectedRows = snap.docs.map((d) => d.data() as Record<string, unknown>);
      const emptySnap = await itemsCol.where('rank', '==', 1).select().get();
      let emptySelectKeys: string[] = [];
      const firstEmpty = emptySnap.docs[0];
      if (firstEmpty !== undefined) emptySelectKeys = Object.keys(firstEmpty.data()).sort();
      return {
        selectedIds,
        projectedRows,
        emptySelectKeys,
        invalidSelectFieldThrew: syncThrewAny(() => itemsCol.select('a..b')),
        nanOffsetThrew: syncThrewAny(() => itemsCol.offset(Number.NaN)),
        nonIntegerOffsetThrew: syncThrewAny(() => itemsCol.offset(1.5)),
      };
    },
    async runCountAndStream() {
      const totalSnap = await itemsCol.count().get();
      const filteredSnap = await (itemsCol.where('rank', '>=', 2) as typeof itemsCol).count().get();
      const streamedIds: string[] = [];
      for await (const docSnap of itemsCol.orderBy('rank', 'asc').stream()) {
        streamedIds.push(docSnap.id);
      }
      return {
        totalCount: totalSnap.data().count,
        filteredCount: filteredSnap.data().count,
        streamedIds,
        limitToLastStreamThrew: syncThrewAny(() => itemsCol.orderBy('rank', 'asc').limitToLast(1).stream()),
      };
    },
    inspectFindNearest() {
      const vq = itemsCol.findNearest('embedding', [0.25, -0.5, 1.5], { limit: 2, distanceMeasure: 'COSINE' });
      return {
        zeroLimitThrew: syncThrewAny(() => itemsCol.findNearest('embedding', [0.25, -0.5, 1.5], { limit: 0, distanceMeasure: 'COSINE' })),
        emptyVectorThrew: syncThrewAny(() => itemsCol.findNearest('embedding', [], { limit: 2, distanceMeasure: 'COSINE' })),
        invalidFieldThrew: syncThrewAny(() => itemsCol.findNearest('a..b', [0.25, -0.5, 1.5], { limit: 2, distanceMeasure: 'COSINE' })),
        hasGetMethod: typeof vq.get === 'function',
        queryMatchesBase: vq.query.isEqual(itemsCol),
      };
    },
    async runExplainAndExplainStream() {
      const ordered = itemsCol.orderBy('rank', 'asc');
      const planOnly = await ordered.explain();
      const analyzed = await ordered.explain({ analyze: true });
      let analyzedResultsReturned: number | null = null;
      let analyzedHasReadOpsNumber = false;
      let analyzedHasDurationSeconds = false;
      if (analyzed.metrics.executionStats !== null) {
        analyzedResultsReturned = analyzed.metrics.executionStats.resultsReturned;
        analyzedHasReadOpsNumber = typeof analyzed.metrics.executionStats.readOperations === 'number';
        analyzedHasDurationSeconds = typeof analyzed.metrics.executionStats.executionDuration.seconds === 'number';
      }
      let analyzedSnapshotDocIds: string[] = [];
      if (analyzed.snapshot !== null) analyzedSnapshotDocIds = analyzed.snapshot.docs.map((d) => d.id);
      const streamDocIds: string[] = [];
      let streamSawMetrics = false;
      for await (const chunk of ordered.explainStream({ analyze: true })) {
        if (chunk.document !== undefined) streamDocIds.push(chunk.document.id);
        if (chunk.metrics !== undefined) streamSawMetrics = true;
      }
      return {
        planOnlyIndexesIsArray: Array.isArray(planOnly.metrics.planSummary.indexesUsed),
        planOnlyExecutionStatsIsNull: planOnly.metrics.executionStats === null,
        planOnlySnapshotIsNull: planOnly.snapshot === null,
        analyzedIndexesIsArray: Array.isArray(analyzed.metrics.planSummary.indexesUsed),
        analyzedResultsReturned,
        analyzedHasReadOpsNumber,
        analyzedHasDurationSeconds,
        analyzedSnapshotDocIds,
        streamDocIds,
        streamSawMetrics,
        limitToLastExplainStreamThrew: syncThrewAny(() => ordered.limitToLast(1).explainStream()),
      };
    },
    async runWithConverterRoundtrip() {
      const rawCol = mainDb.collection(`${basePath}/converted`) as ReturnType<typeof mainDb.collection> & {
        withConverter<T>(c: {
          toFirestore(m: T): Record<string, unknown>;
          fromFirestore(s: { id: string; data(): Record<string, unknown> }): T;
        }): {
          doc(id: string): { set(m: T): Promise<unknown>; get(): Promise<{ data(): T | undefined }> };
          where(f: string, op: '>', v: number): { get(): Promise<{ docs: Array<{ data(): T }> }> };
        };
      };
      const typedCol = rawCol.withConverter<ConvertedModel>({
        toFirestore: (m) => ({ label: m.label.toUpperCase(), score: m.score }),
        fromFirestore: (s) => ({ id: s.id, label: String(s.data().label).toLowerCase(), score: Number(s.data().score) * 10 }),
      });
      await typedCol.doc('c1').set({ id: 'c1', label: 'Hello', score: 4 });
      await typedCol.doc('c2').set({ id: 'c2', label: 'World', score: 7 });
      const rawData = (await rawCol.doc('c1').get()).data();
      let rawStoredDoc: Record<string, unknown> | null = null;
      if (rawData !== undefined) rawStoredDoc = rawData as Record<string, unknown>;
      const convData = (await typedCol.doc('c1').get()).data();
      let convertedDoc: Record<string, unknown> | null = null;
      if (convData !== undefined) convertedDoc = { id: convData.id, label: convData.label, score: convData.score };
      const convertedQueryDocs = (await typedCol.where('score', '>', 5).get()).docs.map((d) => {
        const row = d.data();
        return { id: row.id, label: row.label, score: row.score };
      });
      return { rawStoredDoc, convertedDoc, convertedQueryDocs };
    },
    async runReferenceDiscovery() {
      const discCol = mainDb.collection(`${basePath}/discovery`) as ReturnType<typeof mainDb.collection> & {
        listDocuments(): Promise<Array<{ id: string; get(): Promise<{ exists: boolean }> }>>;
      };
      const realDoc = discCol.doc('real-doc') as ReturnType<typeof mainDb.doc> & {
        listCollections(): Promise<Array<{ id: string }>>;
      };
      await realDoc.set({ ok: true });
      await realDoc.collection('sub-b').doc('leaf-1').set({ v: 2 });
      await realDoc.collection('sub-a').doc('leaf-1').set({ v: 1 });
      await discCol.doc('phantom-doc').collection('sub-only').doc('leaf-1').set({ v: 3 });
      const docSubcollectionIds = (await realDoc.listCollections()).map((c) => c.id);
      const docRefs = await discCol.listDocuments();
      const listedDocIds = docRefs.map((r) => r.id).sort();
      const listedDocExistsById: Record<string, boolean> = {};
      for (const ref of docRefs) listedDocExistsById[ref.id] = (await ref.get()).exists;
      return { docSubcollectionIds, listedDocIds, listedDocExistsById };
    },
  };
}
