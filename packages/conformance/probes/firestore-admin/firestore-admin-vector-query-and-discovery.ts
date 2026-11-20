import type { Probe } from '../../rigs/types.ts';

export interface AdminVectorLike {
  toArray(): number[];
  isEqual(other: AdminVectorLike): boolean;
}

interface AdminVectorQueryDocLike {
  readonly id: string;
  readonly exists: boolean;
  data(): Record<string, unknown> | undefined;
}

interface AdminExplainSummary {
  readonly planOnlyIndexesIsArray: boolean;
  readonly planOnlyExecutionStatsIsNull: boolean;
  readonly planOnlySnapshotIsNull: boolean;
  readonly analyzedIndexesIsArray: boolean;
  readonly analyzedResultsReturned: number | null;
  readonly analyzedHasReadOpsNumber: boolean;
  readonly analyzedHasDurationSeconds: boolean;
  readonly analyzedSnapshotDocIds: readonly string[];
  readonly streamDocIds: readonly string[];
  readonly streamSawMetrics: boolean;
  readonly limitToLastExplainStreamThrew: boolean;
}

interface AdminConverterRoundtripSummary {
  readonly rawStoredDoc: Record<string, unknown> | null;
  readonly convertedDoc: Record<string, unknown> | null;
  readonly convertedQueryDocs: ReadonlyArray<Record<string, unknown>>;
}

interface AdminDiscoverySummary {
  readonly docSubcollectionIds: readonly string[];
  readonly listedDocIds: readonly string[];
  readonly listedDocExistsById: Readonly<Record<string, boolean>>;
}

export interface AdminVectorQueryAndDiscoverySubject {
  createVector(values: readonly number[]): AdminVectorLike;
  isVector(value: unknown): value is AdminVectorLike;
  seedVectorAndQueryItems(
    v1: AdminVectorLike,
    v2: AdminVectorLike,
  ): Promise<void>;
  readItem(id: string): Promise<AdminVectorQueryDocLike>;
  runSelectAndOffset(): Promise<{
    readonly selectedIds: readonly string[];
    readonly projectedRows: ReadonlyArray<Record<string, unknown>>;
    readonly emptySelectKeys: readonly string[];
    readonly invalidSelectFieldThrew: boolean;
    readonly nanOffsetThrew: boolean;
    readonly nonIntegerOffsetThrew: boolean;
  }>;
  runCountAndStream(): Promise<{
    readonly totalCount: number;
    readonly filteredCount: number;
    readonly streamedIds: readonly string[];
    readonly limitToLastStreamThrew: boolean;
  }>;
  inspectFindNearest(): {
    readonly zeroLimitThrew: boolean;
    readonly emptyVectorThrew: boolean;
    readonly invalidFieldThrew: boolean;
    readonly hasGetMethod: boolean;
    readonly queryMatchesBase: boolean;
  };
  runExplainAndExplainStream(): Promise<AdminExplainSummary>;
  runWithConverterRoundtrip(): Promise<AdminConverterRoundtripSummary>;
  runReferenceDiscovery(): Promise<AdminDiscoverySummary>;
}

export function syncThrewAny(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

export async function observeFirestoreAdminVectorQueryAndDiscovery(
  subject: AdminVectorQueryAndDiscoverySubject,
): Promise<Record<string, unknown>> {
  const v1 = subject.createVector([0.25, -0.5, 1.5]);
  const v1Same = subject.createVector([0.25, -0.5, 1.5]);
  const v2 = subject.createVector([0.25, -0.5, 2.0]);
  const emptyVec = subject.createVector([]);

  await subject.seedVectorAndQueryItems(v1, v2);
  const storedDocA = await subject.readItem('a');
  const rawDataA = storedDocA.data();
  let rawEmbedding: unknown;
  if (rawDataA !== undefined) {
    rawEmbedding = rawDataA.embedding;
  }
  const storedIsVector = subject.isVector(rawEmbedding);
  let storedArray: number[] | null = null;
  let storedIsEqual = false;
  if (subject.isVector(rawEmbedding)) {
    storedArray = rawEmbedding.toArray();
    storedIsEqual = rawEmbedding.isEqual(v1Same);
  }

  const selectAndOffset = await subject.runSelectAndOffset();
  const countAndStream = await subject.runCountAndStream();
  const findNearest = subject.inspectFindNearest();
  const explain = await subject.runExplainAndExplainStream();
  const withConverter = await subject.runWithConverterRoundtrip();
  const discovery = await subject.runReferenceDiscovery();

  return {
    vector: {
      toArray: v1.toArray(),
      emptyToArray: emptyVec.toArray(),
      isEqualSame: v1.isEqual(v1Same),
      isEqualDifferent: v1.isEqual(v2),
      storedIsVector,
      storedArray,
      storedIsEqual,
    },
    selectAndOffset,
    countAndStream,
    findNearest,
    explain,
    withConverter,
    discovery,
  };
}

interface ConvertedNoteModel {
  readonly id: string;
  readonly label: string;
  readonly score: number;
}

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['admin-firestore'],
  matrixRow: 'firestore-admin#10',
  rowIds: ['firestore-admin#10'],
  description:
    'firebase-admin/firestore FieldValue.vector, Query.{select, offset, count, stream, findNearest, explain, explainStream, withConverter}, CollectionReference.listDocuments, and DocumentReference.listCollections.',
  async observe(): Promise<Record<string, unknown>> {
    const [adminAppMod, fsMod, { loadOracleServiceAccount, oracleAppOptions }] = await Promise.all([
      import('firebase-admin/app'),
      import('firebase-admin/firestore'),
      import('../../src/oracle-credential.ts'),
    ]);

    const sa = await loadOracleServiceAccount();
    const runId = `adm_vq_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const basePath = `pyric_oracle/${runId}`;

    const mainApp = adminAppMod.initializeApp(oracleAppOptions(sa), `sdk-probe-vq-${runId}`);
    const mainDb = fsMod.getFirestore(mainApp);
    const sampleVector = fsMod.FieldValue.vector([1]);
    const VectorCtor = sampleVector.constructor;

    try {
      const itemsCol = mainDb.collection(`${basePath}/items`);

      const subject: AdminVectorQueryAndDiscoverySubject = {
        createVector: (values) =>
          fsMod.FieldValue.vector([...values]) as unknown as AdminVectorLike,
        isVector: (val): val is AdminVectorLike =>
          val !== null && typeof val === 'object' && val.constructor === VectorCtor,
        async seedVectorAndQueryItems(v1, v2) {
          await itemsCol.doc('a').set({
            title: 'Alpha',
            rank: 1,
            meta: { tag: 'x', secret: 'hide-a' },
            embedding: v1,
          });
          await itemsCol.doc('b').set({
            title: 'Beta',
            rank: 2,
            meta: { tag: 'y', secret: 'hide-b' },
            embedding: v2,
          });
          await itemsCol.doc('c').set({
            title: 'Gamma',
            rank: 3,
            meta: { tag: 'z', secret: 'hide-c' },
          });
        },
        readItem: async (id) =>
          (await itemsCol.doc(id).get()) as unknown as AdminVectorQueryDocLike,
        async runSelectAndOffset() {
          const snap = await itemsCol
            .orderBy('rank', 'asc')
            .offset(1)
            .select('title', 'meta.tag')
            .get();
          const selectedIds = snap.docs.map((d) => d.id);
          const projectedRows = snap.docs.map((d) => d.data() as Record<string, unknown>);
          const emptySnap = await itemsCol.where('rank', '==', 1).select().get();
          let emptySelectKeys: string[] = [];
          const firstEmpty = emptySnap.docs[0];
          if (firstEmpty !== undefined) {
            emptySelectKeys = Object.keys(firstEmpty.data()).sort();
          }
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
          const filteredSnap = await itemsCol.where('rank', '>=', 2).count().get();
          const streamedIds: string[] = [];
          const stream = itemsCol.orderBy('rank', 'asc').stream() as AsyncIterable<{
            readonly id: string;
          }>;
          for await (const docSnap of stream) {
            streamedIds.push(docSnap.id);
          }
          return {
            totalCount: totalSnap.data().count,
            filteredCount: filteredSnap.data().count,
            streamedIds,
            limitToLastStreamThrew: syncThrewAny(() =>
              itemsCol.orderBy('rank', 'asc').limitToLast(1).stream(),
            ),
          };
        },
        inspectFindNearest() {
          const zeroLimitThrew = syncThrewAny(() =>
            itemsCol.findNearest('embedding', [0.25, -0.5, 1.5], {
              limit: 0,
              distanceMeasure: 'COSINE',
            }),
          );
          const emptyVectorThrew = syncThrewAny(() =>
            itemsCol.findNearest('embedding', [], {
              limit: 2,
              distanceMeasure: 'COSINE',
            }),
          );
          const invalidFieldThrew = syncThrewAny(() =>
            itemsCol.findNearest('a..b', [0.25, -0.5, 1.5], {
              limit: 2,
              distanceMeasure: 'COSINE',
            }),
          );
          const vq = itemsCol.findNearest('embedding', [0.25, -0.5, 1.5], {
            limit: 2,
            distanceMeasure: 'COSINE',
          });
          return {
            zeroLimitThrew,
            emptyVectorThrew,
            invalidFieldThrew,
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
            analyzedHasReadOpsNumber =
              typeof analyzed.metrics.executionStats.readOperations === 'number';
            analyzedHasDurationSeconds =
              typeof analyzed.metrics.executionStats.executionDuration.seconds === 'number';
          }
          let analyzedSnapshotDocIds: string[] = [];
          if (analyzed.snapshot !== null) {
            analyzedSnapshotDocIds = analyzed.snapshot.docs.map((d) => d.id);
          }

          const streamDocIds: string[] = [];
          let streamSawMetrics = false;
          const expStream = ordered.explainStream({ analyze: true }) as AsyncIterable<{
            readonly document?: { readonly id: string };
            readonly metrics?: unknown;
          }>;
          for await (const chunk of expStream) {
            if (chunk.document !== undefined && chunk.document !== null) {
              streamDocIds.push(chunk.document.id);
            }
            if (chunk.metrics !== undefined && chunk.metrics !== null) {
              streamSawMetrics = true;
            }
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
            limitToLastExplainStreamThrew: syncThrewAny(() =>
              ordered.limitToLast(1).explainStream(),
            ),
          };
        },
        async runWithConverterRoundtrip() {
          const rawCol = mainDb.collection(`${basePath}/converted`);
          const converter: FirebaseFirestore.FirestoreDataConverter<ConvertedNoteModel> = {
            toFirestore(model: ConvertedNoteModel): FirebaseFirestore.DocumentData {
              return { label: model.label.toUpperCase(), score: model.score };
            },
            fromFirestore(
              snap: FirebaseFirestore.QueryDocumentSnapshot,
            ): ConvertedNoteModel {
              const data = snap.data();
              return {
                id: snap.id,
                label: String(data.label).toLowerCase(),
                score: Number(data.score) * 10,
              };
            },
          };
          const typedCol = rawCol.withConverter(converter);
          await typedCol.doc('c1').set({ id: 'c1', label: 'Hello', score: 4 });
          await typedCol.doc('c2').set({ id: 'c2', label: 'World', score: 7 });

          const rawSnap = await rawCol.doc('c1').get();
          let rawStoredDoc: Record<string, unknown> | null = null;
          const rawData = rawSnap.data();
          if (rawData !== undefined) {
            rawStoredDoc = rawData as Record<string, unknown>;
          }

          const convSnap = await typedCol.doc('c1').get();
          let convertedDoc: Record<string, unknown> | null = null;
          const convData = convSnap.data();
          if (convData !== undefined) {
            convertedDoc = {
              id: convData.id,
              label: convData.label,
              score: convData.score,
            };
          }

          const convQuerySnap = await typedCol.where('score', '>', 5).get();
          const convertedQueryDocs = convQuerySnap.docs.map((d) => {
            const row = d.data();
            return { id: row.id, label: row.label, score: row.score };
          });

          return {
            rawStoredDoc,
            convertedDoc,
            convertedQueryDocs,
          };
        },
        async runReferenceDiscovery() {
          const discCol = mainDb.collection(`${basePath}/discovery`);
          const realDoc = discCol.doc('real-doc');
          await realDoc.set({ ok: true });
          await realDoc.collection('sub-b').doc('leaf-1').set({ v: 2 });
          await realDoc.collection('sub-a').doc('leaf-1').set({ v: 1 });

          const phantomDoc = discCol.doc('phantom-doc');
          await phantomDoc.collection('sub-only').doc('leaf-1').set({ v: 3 });

          const subCols = await realDoc.listCollections();
          const docSubcollectionIds = subCols.map((c) => c.id);

          const docRefs = await discCol.listDocuments();
          const listedDocIds = docRefs.map((r) => r.id).sort();
          const listedDocExistsById: Record<string, boolean> = {};
          for (const ref of docRefs) {
            const snap = await ref.get();
            listedDocExistsById[ref.id] = snap.exists;
          }

          return {
            docSubcollectionIds,
            listedDocIds,
            listedDocExistsById,
          };
        },
      };

      return await observeFirestoreAdminVectorQueryAndDiscovery(subject);
    } finally {
      await mainDb.recursiveDelete(mainDb.doc(basePath)).catch(() => undefined);
      await mainDb.terminate().catch(() => undefined);
      await adminAppMod.deleteApp(mainApp).catch(() => undefined);
    }
  },
};
