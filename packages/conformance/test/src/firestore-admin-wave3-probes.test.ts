import { describe, expect, test } from 'bun:test';
import { applicationDefault, deleteApp, initializeApp } from 'firebase-admin/app';
import * as adminFs from 'firebase-admin/firestore';
import {
  loadModularProbes,
  printModularProbePreview,
  selectModularProbes,
} from '../../src/sdk-probes.ts';
import { auditProbeSessionAuthModes } from '../../src/sdk-probe-runtime.ts';
import {
  type AdminVectorLike,
  type AdminVectorQueryAndDiscoverySubject,
  observeFirestoreAdminVectorQueryAndDiscovery,
  probe as vectorQueryProbe,
  syncThrewAny,
} from '../../probes/firestore-admin/firestore-admin-vector-query-and-discovery.ts';
import {
  type AdminFirestoreErrorLike,
  type AdminMetaDocSnapLike,
  type AdminMetaQueryLike,
  type AdminMetaQuerySnapLike,
  type AdminSnapshotAndReferenceMetadataSubject,
  type AdminTimestampLike,
  type AdminWriteResultLike,
  observeFirestoreAdminSnapshotAndReferenceMetadata,
  probe as snapshotMetaProbe,
} from '../../probes/firestore-admin/firestore-admin-snapshot-and-reference-metadata.ts';

const WAVE3_ADMIN_PROBE_IDS = [
  'firestore-admin-snapshot-and-reference-metadata',
  'firestore-admin-vector-query-and-discovery',
] as const;

describe('Firestore Admin Wave 3 vector/query/discovery and snapshot/reference metadata probes', () => {
  test('links both Wave 3 admin sdk-probes with inert preview safety', async () => {
    expect(auditProbeSessionAuthModes()).toEqual([]);
    const loaded = await loadModularProbes('sdk-probes');
    const loadedIds = loaded.map((entry) => entry.id);
    for (const id of WAVE3_ADMIN_PROBE_IDS) {
      expect(loadedIds).toContain(id);
    }

    expect(vectorQueryProbe.rig).toBe('sdk-probes');
    expect(vectorQueryProbe.pendingRowLink).toBeUndefined();
    expect(vectorQueryProbe.rowIds).toEqual(['firestore-admin#10']);
    expect(vectorQueryProbe.description.length).toBeGreaterThan(20);

    expect(snapshotMetaProbe.rig).toBe('sdk-probes');
    expect(snapshotMetaProbe.pendingRowLink).toBeUndefined();
    expect(snapshotMetaProbe.rowIds).toEqual(['firestore-admin#11', 'firestore#RS3']);
    expect(snapshotMetaProbe.description.length).toBeGreaterThan(20);

    const unfilteredIds = new Set(
      selectModularProbes(loaded, [], 'sdk-probes', {
        includeUncapturedStaged: false,
      }).map((entry) => entry.id),
    );
    for (const id of WAVE3_ADMIN_PROBE_IDS) {
      expect(unfilteredIds.has(id)).toBe(true);
    }

    const previewLines: string[] = [];
    printModularProbePreview({
      rig: 'sdk-probes',
      scriptPath: 'packages/conformance/src/sdk-probes.ts',
      probes: loaded.filter((entry) =>
        (WAVE3_ADMIN_PROBE_IDS as readonly string[]).includes(entry.id),
      ),
      log: (line) => previewLines.push(line),
    });
    const previewText = previewLines.join('\n');
    expect(previewText).toContain('firestore-admin-vector-query-and-discovery');
    expect(previewText).toContain('firestore-admin-snapshot-and-reference-metadata');
  });

  test('verifies offline firebase-admin VectorValue, findNearest preflight, references, and FirebaseFirestoreError', async () => {
    const app = initializeApp(
      { projectId: 'demo-wave3-probe', credential: applicationDefault() },
      'wave3-offline-admin',
    );
    try {
      const db = adminFs.getFirestore(app);
      const col = db.collection('pyric_oracle/run-1/items');
      expect(db.collection('pyric_oracle').parent).toBeNull();
      expect(col.parent?.path).toBe('pyric_oracle/run-1');
      expect(col.firestore).toBe(db);
      expect(col.doc('d1').firestore).toBe(db);
      expect(col.where('rank', '==', 1).firestore).toBe(db);
      expect(col.isEqual(db.collection('pyric_oracle/run-1/items'))).toBe(true);
      expect(col.doc('d1').isEqual(db.doc('pyric_oracle/run-1/items/d1'))).toBe(true);

      expect(
        syncThrewAny(() =>
          col.findNearest('embedding', [1, 2], { limit: 0, distanceMeasure: 'COSINE' }),
        ),
      ).toBe(true);
      expect(
        syncThrewAny(() =>
          col.findNearest('embedding', [], { limit: 2, distanceMeasure: 'COSINE' }),
        ),
      ).toBe(true);
      expect(
        syncThrewAny(() =>
          col.findNearest('a..b', [1, 2], { limit: 2, distanceMeasure: 'COSINE' }),
        ),
      ).toBe(true);
      expect(syncThrewAny(() => col.select('a..b'))).toBe(true);
      expect(syncThrewAny(() => col.offset(Number.NaN))).toBe(true);
      expect(syncThrewAny(() => col.offset(1.5))).toBe(true);
      expect(syncThrewAny(() => col.limitToLast(1).stream())).toBe(true);
      expect(syncThrewAny(() => col.limitToLast(1).explainStream())).toBe(true);

      const vq = col.findNearest('embedding', [0.25, -0.5, 1.5], {
        limit: 2,
        distanceMeasure: 'COSINE',
      });
      expect(typeof vq.get).toBe('function');
      expect(vq.query.isEqual(col)).toBe(true);

      const sampleVec = adminFs.FieldValue.vector([0.25, -0.5, 1.5]) as unknown as AdminVectorLike;
      const VectorCtor = sampleVec.constructor;

      const store = new Map<string, Record<string, unknown>>();
      const vqSubject: AdminVectorQueryAndDiscoverySubject = {
        createVector: (vals) => adminFs.FieldValue.vector([...vals]) as unknown as AdminVectorLike,
        isVector: (val): val is AdminVectorLike =>
          val !== null && typeof val === 'object' && val.constructor === VectorCtor,
        async seedVectorAndQueryItems(v1, v2) {
          store.set('a', { title: 'Alpha', rank: 1, meta: { tag: 'x' }, embedding: v1 });
          store.set('b', { title: 'Beta', rank: 2, meta: { tag: 'y' }, embedding: v2 });
          store.set('c', { title: 'Gamma', rank: 3, meta: { tag: 'z' } });
        },
        readItem: async (id) => ({
          id,
          exists: store.has(id),
          data: () => store.get(id),
        }),
        runSelectAndOffset: async () => ({
          selectedIds: ['b', 'c'],
          projectedRows: [
            { title: 'Beta', meta: { tag: 'y' } },
            { title: 'Gamma', meta: { tag: 'z' } },
          ],
          emptySelectKeys: [],
          invalidSelectFieldThrew: true,
          nanOffsetThrew: true,
          nonIntegerOffsetThrew: true,
        }),
        runCountAndStream: async () => ({
          totalCount: 3,
          filteredCount: 2,
          streamedIds: ['a', 'b', 'c'],
          limitToLastStreamThrew: true,
        }),
        inspectFindNearest: () => ({
          zeroLimitThrew: true,
          emptyVectorThrew: true,
          invalidFieldThrew: true,
          hasGetMethod: true,
          queryMatchesBase: true,
        }),
        runExplainAndExplainStream: async () => ({
          planOnlyIndexesIsArray: true,
          planOnlyExecutionStatsIsNull: true,
          planOnlySnapshotIsNull: true,
          analyzedIndexesIsArray: true,
          analyzedResultsReturned: 3,
          analyzedHasReadOpsNumber: true,
          analyzedHasDurationSeconds: true,
          analyzedSnapshotDocIds: ['a', 'b', 'c'],
          streamDocIds: ['a', 'b', 'c'],
          streamSawMetrics: true,
          limitToLastExplainStreamThrew: true,
        }),
        runWithConverterRoundtrip: async () => ({
          rawStoredDoc: { label: 'HELLO', score: 4 },
          convertedDoc: { id: 'c1', label: 'hello', score: 40 },
          convertedQueryDocs: [{ id: 'c2', label: 'world', score: 70 }],
        }),
        runReferenceDiscovery: async () => ({
          docSubcollectionIds: ['sub-a', 'sub-b'],
          listedDocIds: ['phantom-doc', 'real-doc'],
          listedDocExistsById: { 'phantom-doc': false, 'real-doc': true },
        }),
      };

      const vqObserved = await observeFirestoreAdminVectorQueryAndDiscovery(vqSubject);
      expect(vqObserved.vector).toEqual({
        toArray: [0.25, -0.5, 1.5],
        emptyToArray: [],
        isEqualSame: true,
        isEqualDifferent: false,
        storedIsVector: true,
        storedArray: [0.25, -0.5, 1.5],
        storedIsEqual: true,
      });

      const FirestoreErrorCtor = adminFs.FirebaseFirestoreError as unknown as new (info: {
        code: string;
        message: string;
      }) => AdminFirestoreErrorLike;

      let clockMs = 1700000000000;
      const metaStore = new Map<
        string,
        { data: Record<string, unknown>; createTime: AdminTimestampLike; updateTime: AdminTimestampLike }
      >();
      const makeTs = (ms: number): AdminTimestampLike =>
        adminFs.Timestamp.fromMillis(ms) as unknown as AdminTimestampLike;
      const makeWriteResult = (ts: AdminTimestampLike): AdminWriteResultLike => ({
        writeTime: ts,
        isEqual: (other) => ts.isEqual(other.writeTime),
      });

      const metaSubject: AdminSnapshotAndReferenceMetadataSubject = {
        dbHandle: db,
        isTimestamp: (val): val is AdminTimestampLike => val instanceof adminFs.Timestamp,
        isWriteResultInstance: (val) => typeof (val as { isEqual?: unknown }).isEqual === 'function',
        hasFirestoreErrorExport: typeof adminFs.FirebaseFirestoreError === 'function',
        createFirestoreError: (code, message) => new FirestoreErrorCtor({ code, message }),
        checkReferenceMetadataAndEquality: () => ({
          rootColParentIsNull: true,
          subColParentPathMatchesBase: true,
          colFirestoreSameAsDb: true,
          docFirestoreSameAsDb: true,
          queryFirestoreSameAsDb: true,
          colIsEqualSame: true,
          colIsEqualDifferent: false,
          docIsEqualSame: true,
          docIsEqualDifferent: false,
          queryIsEqualSame: true,
          queryIsEqualDifferent: false,
        }),
        async readDoc(id): Promise<AdminMetaDocSnapLike> {
          clockMs += 10;
          const entry = metaStore.get(id);
          const readTime = makeTs(clockMs);
          return {
            id,
            exists: entry !== undefined,
            createTime: entry?.createTime,
            updateTime: entry?.updateTime,
            readTime,
            data: () => entry?.data,
            isEqual(other) {
              return (
                other.id === id &&
                other.exists === (entry !== undefined) &&
                JSON.stringify(other.data()) === JSON.stringify(entry?.data)
              );
            },
          };
        },
        async createDoc(id, data) {
          clockMs += 10;
          const ts = makeTs(clockMs);
          metaStore.set(id, { data: { ...data }, createTime: ts, updateTime: ts });
          return makeWriteResult(ts);
        },
        async updateDoc(id, data) {
          clockMs += 10;
          const existing = metaStore.get(id);
          const ts = makeTs(clockMs);
          if (existing !== undefined) {
            metaStore.set(id, {
              data: { ...existing.data, ...data },
              createTime: existing.createTime,
              updateTime: ts,
            });
          }
          return makeWriteResult(ts);
        },
        buildRankQuery(rank): AdminMetaQueryLike {
          return {
            firestore: db,
            isEqual: (other) =>
              (other as { _rank?: number })._rank === rank,
            ...({ _rank: rank } as Record<string, unknown>),
          };
        },
        async runRankQuery(rank): Promise<AdminMetaQuerySnapLike> {
          clockMs += 10;
          const q = metaSubject.buildRankQuery(rank);
          return {
            size: 1,
            readTime: makeTs(clockMs),
            query: q,
            isEqual: (other) => q.isEqual(other.query) && other.size === 1,
          };
        },
      };

      const metaObserved = await observeFirestoreAdminSnapshotAndReferenceMetadata(metaSubject);
      expect(metaObserved.firestoreErrorClass).toEqual({
        hasExport: true,
        isErrorInstance: true,
        code: 'firestore/not-found',
        message: 'Sample missing document',
        jsonCode: 'firestore/not-found',
      });
      expect(metaObserved.documentSnapshots).toMatchObject({
        missingExists: false,
        missingCreateTimeUndefined: true,
        missingUpdateTimeUndefined: true,
        createEqualsInitialUpdate: true,
        createMatchesWriteResult: true,
        isEqualSameUnchangedDoc: true,
        isEqualAfterMutation: false,
      });
    } finally {
      await deleteApp(app).catch(() => undefined);
    }
  });
});
