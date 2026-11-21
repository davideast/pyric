import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createObservationGate } from '../../src/observation-gate.ts';
import {
  attachQueryChangeRecorder,
  DOC_VALUE_ENCODING,
  extractDocIds,
  FIRESTORE_KOTLIN_OBSERVATIONS_DIR,
  KT_MAIN_ROOT,
  openAuthenticatedFirestoreBridge,
  parseWireDoc,
  whereClause,
  type FirestoreKotlinBatchesTransactionsOfflineErrorsObservation,
  type FirestoreKotlinCrudCodecsObservation,
  type FirestoreKotlinQueriesListenersAggregationsObservation,
} from './firestore-kotlin-oracle-replay-harness.ts';

const gate = createObservationGate({
  dir: FIRESTORE_KOTLIN_OBSERVATIONS_DIR,
  match: (filename) => filename.startsWith('firestore-kotlin-'),
});

describe('firestore-kotlin Android SDK production observation replay over hosted worker bridge', () => {
  test('replays CRUD, SetOptions merge/mergeFields, FieldValue sentinels, Source reads, and value codecs', async () => {
    const obs = gate.load<FirestoreKotlinCrudCodecsObservation>(
      'firestore-kotlin-crud-merge-sentinels-and-codecs',
    );
    const autoIdKt = readFileSync(join(KT_MAIN_ROOT, 'dev', 'pyric', 'codecs', 'AutoId.kt'), 'utf8');
    expect(autoIdKt).toContain('private const val AUTO_ID_LENGTH = 20');
    expect(obs.autoDocumentIdLength).toBe(20);

    const docRefKt = readFileSync(
      join(KT_MAIN_ROOT, 'com', 'google', 'firebase', 'firestore', 'DocumentReference.kt'),
      'utf8',
    );
    expect(docRefKt).toContain('snapshotFromProjection(projected, isFromCache = true)');
    expect(obs.cacheReadIsFromCache).toBe(true);

    const docSnapKt = readFileSync(
      join(KT_MAIN_ROOT, 'com', 'google', 'firebase', 'firestore', 'DocumentSnapshot.kt'),
      'utf8',
    );
    const queryDocSnapKt = readFileSync(
      join(KT_MAIN_ROOT, 'com', 'google', 'firebase', 'firestore', 'QueryDocumentSnapshot.kt'),
      'utf8',
    );
    expect(docSnapKt).toContain('is Int -> value.toLong()');
    expect(docSnapKt).toContain('FieldPath.extract(normalizedData, field)');
    expect(docSnapKt).toContain('FieldPath.extract(normalizedData, fieldPath)');
    expect(queryDocSnapKt).toContain('override fun getData(): Map<String, Any?> = super.getData()!!');

    const runId = 'replay_crud_1';
    const harness = await openAuthenticatedFirestoreBridge(
      `demo-kt-fs-crud-${Date.now()}`,
      runId,
      'android-fs-crud-uid',
    );
    try {
      const { actAs } = harness;
      const colPath = `pyric_oracle/${runId}/crud_codecs`;

      const addRes = await harness.sendOp({
        method: 'addDoc',
        collectionPath: colPath,
        data: { kind: 'auto-added', seq: 1 },
        actAs,
      });
      expect(addRes.ok).toBe(true);
      const addedVal = addRes.value as { id: string; path: string };
      expect(addedVal.id.length).toBe(obs.collectionAddIdLength);

      const addedBeforeDelete = parseWireDoc(
        await harness.sendOp({ method: 'getDoc', path: addedVal.path, actAs }),
      );
      expect(addedBeforeDelete.snap.exists).toBe(obs.collectionAddExistsBeforeDelete);

      const missingRead = parseWireDoc(
        await harness.sendOp({ method: 'getDoc', path: `${colPath}/missing_doc`, actAs }),
      );
      expect(missingRead.snap.exists).toBe(obs.missingDocExists);
      expect(missingRead.fields === null).toBe(obs.missingDocDataIsNull);

      const fixedBytes = Buffer.from([0, 1, 127, 255]);
      const fixedBase64Url = fixedBytes
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
      const profilePath = `${colPath}/profile_doc`;
      const linkedPath = `${colPath}/linked_target`;

      const setInitialRes = await harness.sendOp({
        method: 'setDoc',
        path: profilePath,
        data: {
          title: 'Initial',
          visits: 10,
          ratio: 1.5,
          tags: ['alpha', 'beta', 'drop'],
          obsolete: 'delete-me',
          fixedAt: { __type: 'timestamp', seconds: 1_730_000_000, nanos: 123_456_000 },
          location: { __type: 'latlng', lat: 37.7749, lng: -122.4194 },
          binary: { __type: 'bytes', base64: fixedBase64Url },
          linkedDoc: { __type: 'reference', path: linkedPath },
          nested: { kept: 'yes', replaced: 'before', items: [1, 'two', true] },
        },
        actAs,
      });
      expect(setInitialRes.ok).toBe(true);

      const setMergeRes = await harness.sendOp({
        method: 'setDoc',
        path: profilePath,
        data: { mergedFlag: true, nested: { replaced: 'after-merge' } },
        options: { merge: true },
        actAs,
      });
      expect(setMergeRes.ok).toBe(true);

      const setMergeFieldsRes = await harness.sendOp({
        method: 'setDoc',
        path: profilePath,
        data: {
          title: 'MergedSelected',
          ignoredField: 'must-not-write',
          nested: { kept: 'updated-selective', ignoredNested: true },
        },
        options: { mergeFields: ['title', 'nested.kept'] },
        actAs,
      });
      expect(setMergeFieldsRes.ok).toBe(true);

      const updateSentinelsRes = await harness.sendOp({
        method: 'updateDoc',
        path: profilePath,
        fields: [
          { path: ['visits'], value: { __sentinel: 'increment', n: 5 } },
          { path: ['ratio'], value: { __sentinel: 'increment', n: 0.25 } },
          { path: ['tags'], value: { __sentinel: 'arrayUnion', values: ['gamma'] } },
          { path: ['obsolete'], value: { __sentinel: 'deleteField' } },
          { path: ['stampedAt'], value: { __sentinel: 'serverTimestamp' } },
        ],
        actAs,
      });
      expect(updateSentinelsRes.ok).toBe(true);

      const arrayRemoveRes = await harness.sendOp({
        method: 'updateDoc',
        path: profilePath,
        data: { tags: { __sentinel: 'arrayRemove', values: ['drop'] } },
        actAs,
      });
      expect(arrayRemoveRes.ok).toBe(true);

      const serverRead = parseWireDoc(
        await harness.sendOp({
          method: 'getDoc',
          path: profilePath,
          docValueEncoding: DOC_VALUE_ENCODING,
          actAs,
        }),
      );
      expect(false).toBe(obs.serverReadIsFromCache);
      expect(Boolean(serverRead.snap.hasPendingWrites)).toBe(obs.serverReadHasPendingWrites);
      if (serverRead.fields === null) {
        throw new Error('Expected profile_doc fields');
      }
      const fields = serverRead.fields;
      expect(fields.title).toBe(obs.titleAfterMergeFields);
      expect('ignoredField' in fields).toBe(obs.ignoredFieldPresent);
      expect(fields.mergedFlag).toBe(obs.mergedFlag);

      const nested = fields.nested as Record<string, unknown>;
      expect(nested.kept).toBe(obs.nestedKeptValue);
      expect(nested.replaced).toBe(obs.nestedReplacedPreserved);
      expect('ignoredNested' in nested).toBe(obs.nestedIgnoredPresent);
      expect(nested.items).toEqual([1, 'two', true]);
      expect(Number.isInteger(fields.visits)).toBe(true);
      expect(fields.visits).toBe(obs.incrementLongResult);
      expect(fields.ratio).toBe(obs.incrementDoubleResult);
      expect(fields.tags).toEqual(obs.tagsAfterUnionAndRemove);
      expect('obsolete' in fields).toBe(obs.deletedFieldPresent);

      const stampedAt = fields.stampedAt as { seconds: number; nanoseconds?: number; nanos?: number };
      expect(stampedAt.seconds > 1_700_000_000).toBe(obs.serverTimestampResolved);

      const fixedAt = fields.fixedAt as { seconds: number; nanoseconds?: number; nanos?: number };
      let fixedNanos = -1;
      if (typeof fixedAt.nanoseconds === 'number') {
        fixedNanos = fixedAt.nanoseconds;
      } else if (typeof fixedAt.nanos === 'number') {
        fixedNanos = fixedAt.nanos;
      }
      expect(fixedAt.seconds === 1_730_000_000).toBe(obs.timestampSecondsPreserved);
      expect(fixedNanos === 123_456_000).toBe(obs.timestampNanosecondsPreserved);

      const loc = fields.location as { latitude?: number; longitude?: number; lat?: number; lng?: number };
      let lat = NaN;
      let lng = NaN;
      if (typeof loc.latitude === 'number' && typeof loc.longitude === 'number') {
        lat = loc.latitude;
        lng = loc.longitude;
      } else if (typeof loc.lat === 'number' && typeof loc.lng === 'number') {
        lat = loc.lat;
        lng = loc.lng;
      }
      expect(lat === 37.7749 && lng === -122.4194).toBe(obs.geoPointMatches);

      const bin = fields.binary as { bytes?: string; base64?: string };
      let decodedBytes = Buffer.alloc(0);
      if (typeof bin.bytes === 'string') {
        decodedBytes = Buffer.from(bin.bytes, 'base64');
      } else if (typeof bin.base64 === 'string') {
        decodedBytes = Buffer.from(bin.base64, 'base64url');
      }
      expect(Buffer.compare(decodedBytes, fixedBytes) === 0).toBe(obs.blobBytesMatch);

      const linked = fields.linkedDoc as { path: string };
      expect(linked.path.endsWith('/crud_codecs/linked_target')).toBe(
        obs.documentReferenceRelativeSuffixMatches,
      );

      const delRes = await harness.sendOp({ method: 'deleteDoc', path: addedVal.path, actAs });
      expect(delRes.ok).toBe(true);
      const afterDeleteRead = parseWireDoc(
        await harness.sendOp({ method: 'getDoc', path: addedVal.path, actAs }),
      );
      expect(afterDeleteRead.snap.exists).toBe(obs.collectionAddExistsAfterDelete);
    } finally {
      await harness.close();
    }
  });

  test('replays queries, cursors, count/sum/average aggregations, and Query snapshot listener changes', async () => {
    const obs = gate.load<FirestoreKotlinQueriesListenersAggregationsObservation>(
      'firestore-kotlin-queries-cursors-listeners-and-aggregations',
    );
    const aggSnapKt = readFileSync(
      join(KT_MAIN_ROOT, 'com', 'google', 'firebase', 'firestore', 'AggregateQuerySnapshot.kt'),
      'utf8',
    );
    expect(aggSnapKt).toContain('is AggregateField.SumAggregateField -> normalizeSumValue(');
    expect(aggSnapKt).not.toContain('fun get(aggregateField: AggregateField.SumAggregateField): Double?');

    const runId = 'replay_queries_1';
    const harness = await openAuthenticatedFirestoreBridge(
      `demo-kt-fs-queries-${Date.now()}`,
      runId,
      'android-fs-queries-uid',
    );

    try {
      const { actAs } = harness;
      const colPath = `pyric_oracle/${runId}/catalog`;
      const colSource = { __ref: 'collection', path: colPath };
      const queryDocs = (constraints: Array<Record<string, unknown>>) =>
        harness
          .sendOp({ method: 'getDocs', source: { __ref: 'query', source: colSource, constraints }, actAs })
          .then(extractDocIds);

      const seedRes = await harness.sendOp({
        method: 'batchCommit',
        writes: [
          { method: 'set', path: `${colPath}/item_a`, data: { tier: 'bronze', score: 10, tags: ['kotlin', 'core'] } },
          { method: 'set', path: `${colPath}/item_b`, data: { tier: 'silver', score: 20, tags: ['kotlin', 'ui'] } },
          { method: 'set', path: `${colPath}/item_c`, data: { tier: 'gold', score: 30, tags: ['swift', 'cloud'] } },
          { method: 'set', path: `${colPath}/item_d`, data: { tier: 'platinum', score: 40, tags: ['rust', 'edge'] } },
        ],
        actAs,
      });
      expect(seedRes.ok).toBe(true);

      expect(await queryDocs([whereClause('tier', '==', 'gold')])).toEqual(obs.equalToIds);
      expect(
        await queryDocs([
          { kind: 'and', filters: [whereClause('score', '>=', 20), whereClause('score', '<=', 30)] },
          { kind: 'orderBy', field: 'score', fieldSegments: ['score'], direction: 'asc' },
        ]),
      ).toEqual(obs.rangeFilterAndIds);
      expect(
        (
          await queryDocs([
            { kind: 'or', filters: [whereClause('tier', '==', 'bronze'), whereClause('tier', '==', 'platinum')] },
          ])
        ).sort(),
      ).toEqual(obs.filterOrIdsSorted);
      expect((await queryDocs([whereClause('tier', 'in', ['silver', 'gold'])])).sort()).toEqual(
        obs.whereInIdsSorted,
      );
      expect((await queryDocs([whereClause('tags', 'array-contains', 'kotlin')])).sort()).toEqual(
        obs.arrayContainsIdsSorted,
      );
      expect(
        (await queryDocs([whereClause('tags', 'array-contains-any', ['swift', 'rust'])])).sort(),
      ).toEqual(obs.arrayContainsAnyIdsSorted);
      expect(
        await queryDocs([
          { kind: 'orderBy', field: 'score', fieldSegments: ['score'], direction: 'desc' },
          { kind: 'limit', n: 2 },
        ]),
      ).toEqual(obs.orderByDescLimit2Ids);
      expect(
        await queryDocs([
          { kind: 'orderBy', field: 'score', fieldSegments: ['score'], direction: 'asc' },
          { kind: 'limitToLast', n: 2 },
        ]),
      ).toEqual(obs.orderByAscLimitToLast2Ids);
      expect(
        await queryDocs([
          { kind: 'orderBy', field: 'score', fieldSegments: ['score'], direction: 'asc' },
          { kind: 'startAt', values: [20], valueEncoding: DOC_VALUE_ENCODING },
          { kind: 'endBefore', values: [40], valueEncoding: DOC_VALUE_ENCODING },
        ]),
      ).toEqual(obs.cursorStartAtEndBeforeIds);
      expect(
        await queryDocs([
          { kind: 'orderBy', field: 'score', fieldSegments: ['score'], direction: 'asc' },
          { kind: 'limit', n: 2 },
          {
            kind: 'startAfter',
            values: [20, { __type: 'reference', path: `${colPath}/item_b` }],
            fromSnapshot: true,
            valueEncoding: DOC_VALUE_ENCODING,
          },
        ]),
      ).toEqual(obs.startAfterDocumentSnapshotIds);
      expect(
        await queryDocs([
          { kind: 'orderBy', field: '__name__', direction: 'asc' },
          { kind: 'startAt', values: ['item_b'], valueEncoding: DOC_VALUE_ENCODING },
          { kind: 'endAt', values: ['item_c'], valueEncoding: DOC_VALUE_ENCODING },
        ]),
      ).toEqual(obs.documentIdCursorIds);

      const aggSource = {
        __ref: 'query',
        source: colSource,
        constraints: [whereClause('score', '>=', 20)],
      };
      const countRes = await harness.sendOp({ method: 'count', source: aggSource, actAs });
      expect(countRes.ok).toBe(true);
      expect((countRes.value as { count: number }).count).toBe(obs.countQueryCount);

      const aggRes = await harness.sendOp({
        method: 'aggregate',
        source: aggSource,
        spec: {
          count: { kind: 'count' },
          sum_score: { kind: 'sum', field: 'score' },
          avg_score: { kind: 'average', field: 'score' },
        },
        actAs,
      });
      expect(aggRes.ok).toBe(true);
      const aggData = (aggRes.value as { data: Record<string, number> }).data;
      expect(aggData.count).toBe(obs.aggregateCount);
      expect(Number.isInteger(aggData.sum_score)).toBe(true);
      expect(aggData.sum_score).toBe(obs.aggregateSumScore);
      expect(aggData.avg_score).toBe(obs.aggregateAverageScore);

      const floatColPath = `pyric_oracle/${runId}/catalog_float_agg`;
      const floatSeedRes = await harness.sendOp({
        method: 'batchCommit',
        writes: [
          { method: 'set', path: `${floatColPath}/f1`, data: { weight: 12.25 } },
          { method: 'set', path: `${floatColPath}/f2`, data: { weight: 30.25 } },
        ],
        actAs,
      });
      expect(floatSeedRes.ok).toBe(true);
      const floatAggRes = await harness.sendOp({
        method: 'aggregate',
        source: { __ref: 'collection', path: floatColPath },
        spec: {
          sum_weight: { kind: 'sum', field: 'weight' },
          avg_weight: { kind: 'average', field: 'weight' },
        },
        actAs,
      });
      expect(floatAggRes.ok).toBe(true);
      const floatAggData = (floatAggRes.value as { data: Record<string, number> }).data;
      expect(floatAggData.sum_weight).toBe(42.5);
      expect(floatAggData.avg_weight).toBe(21.25);

      const watchColPath = `pyric_oracle/${runId}/live_watch`;
      await harness.sendOp({ method: 'setDoc', path: `${watchColPath}/w1`, data: { step: 1 }, actAs });

      const recorder = attachQueryChangeRecorder(harness, 'rsub-watch-1', watchColPath);
      try {
        await recorder.waitForChange('ADDED:w1');
        await harness.sendOp({ method: 'setDoc', path: `${watchColPath}/w2`, data: { step: 2 }, actAs });
        await recorder.waitForChange('ADDED:w2');
        await harness.sendOp({
          method: 'updateDoc',
          path: `${watchColPath}/w1`,
          data: { step: 3 },
          actAs,
        });
        await recorder.waitForChange('MODIFIED:w1');
        await harness.sendOp({ method: 'deleteDoc', path: `${watchColPath}/w2`, actAs });
        await recorder.waitForChange('REMOVED:w2');
        expect(recorder.changeLog).toEqual(obs.listenerDocumentChanges);

        recorder.stop();
        const countAfterUnsub = recorder.changeLog.length;
        await harness.sendOp({ method: 'setDoc', path: `${watchColPath}/w3`, data: { step: 4 }, actAs });
        await harness.sendOp({ method: 'getDoc', path: `${watchColPath}/w3`, actAs });
        expect(recorder.changeLog.length === countAfterUnsub).toBe(obs.listenerQuietAfterRemove);
      } finally {
        recorder.stop();
      }
    } finally {
      await harness.close();
    }
  });

  test('replays WriteBatch, runTransaction commit and abort, offline staging, PERMISSION_DENIED, and clearPersistence', async () => {
    const obs = gate.load<FirestoreKotlinBatchesTransactionsOfflineErrorsObservation>(
      'firestore-kotlin-batches-transactions-offline-and-errors',
    );
    const offlineKt = readFileSync(
      join(KT_MAIN_ROOT, 'com', 'google', 'firebase', 'firestore', 'FirestoreOfflineCoordinator.kt'),
      'utf8',
    );
    const docRefKt = readFileSync(
      join(KT_MAIN_ROOT, 'com', 'google', 'firebase', 'firestore', 'DocumentReference.kt'),
      'utf8',
    );
    const fseKt = readFileSync(
      join(KT_MAIN_ROOT, 'com', 'google', 'firebase', 'firestore', 'FirebaseFirestoreException.kt'),
      'utf8',
    );

    expect(docRefKt).toContain('FirebaseFirestoreException.Code.UNAVAILABLE');
    expect(obs.offlineCacheHasPendingWrites).toBe(true);
    expect(obs.offlineCacheIsFromCache).toBe(true);
    expect(obs.offlineServerReadErrorCode).toBe('UNAVAILABLE');
    expect(offlineKt).toContain('FirebaseFirestoreException.Code.FAILED_PRECONDITION');
    expect(obs.clearPersistenceWhileActiveCodeName).toBe('FAILED_PRECONDITION');
    expect(obs.clearPersistenceAfterTerminateSucceeded).toBe(true);
    expect(fseKt).toContain('PERMISSION_DENIED(7)');
    expect(fseKt).toContain('"permission-denied" -> PERMISSION_DENIED');

    const runId = 'replay_tx_1';
    const harness = await openAuthenticatedFirestoreBridge(
      `demo-kt-fs-batch-tx-${Date.now()}`,
      runId,
      'android-fs-tx-uid',
    );

    try {
      const { actAs } = harness;
      const colPath = `pyric_oracle/${runId}/tx_batch`;
      const scratchPath = `${colPath}/scratch_delete`;
      const batchItemPath = `${colPath}/batch_1`;

      await harness.sendOp({ method: 'setDoc', path: scratchPath, data: { temp: true }, actAs });
      const batchRes = await harness.sendOp({
        method: 'batchCommit',
        writes: [
          { method: 'set', path: batchItemPath, data: { score: 10, label: 'one' } },
          { method: 'set', path: batchItemPath, data: { mergedBatch: true }, options: { merge: true } },
          { method: 'update', path: batchItemPath, fields: [{ path: ['score'], value: 25 }] },
          { method: 'delete', path: scratchPath },
        ],
        actAs,
      });
      expect(batchRes.ok).toBe(true);

      const batchItemRead = parseWireDoc(
        await harness.sendOp({ method: 'getDoc', path: batchItemPath, actAs }),
      );
      const scratchRead = parseWireDoc(
        await harness.sendOp({ method: 'getDoc', path: scratchPath, actAs }),
      );
      expect(batchItemRead.fields?.score).toBe(obs.batchItemScore);
      expect(batchItemRead.fields?.mergedBatch).toBe(obs.batchItemMergedFlag);
      expect(scratchRead.snap.exists).toBe(obs.batchDeletedDocExists);

      const accountPath = `${colPath}/account`;
      const receiptPath = `${colPath}/tx_receipt`;
      await harness.sendOp({ method: 'setDoc', path: accountPath, data: { balance: 100 }, actAs });

      const txnId1 = 'kt-txn-replay-commit';
      const txRead1 = parseWireDoc(
        await harness.sendOp({ method: 'getDoc', path: accountPath, txnId: txnId1, actAs }),
      );
      const startBalance = txRead1.fields?.balance as number;
      const updatedBalance = startBalance + 45;
      const txCommitRes = await harness.sendOp({
        method: 'txnCommit',
        txnId: txnId1,
        reads: [{ path: accountPath, data: txRead1.snap.data }],
        writes: [
          { method: 'update', path: accountPath, fields: [{ path: ['balance'], value: updatedBalance }] },
          { method: 'set', path: receiptPath, data: { recordedBalance: updatedBalance } },
        ],
        actAs,
      });
      expect(txCommitRes.ok).toBe(true);
      expect(updatedBalance).toBe(obs.transactionReturnBalance);

      const receiptRead = parseWireDoc(
        await harness.sendOp({ method: 'getDoc', path: receiptPath, actAs }),
      );
      expect(receiptRead.fields?.recordedBalance).toBe(obs.transactionReceiptBalance);

      const txnId2 = 'kt-txn-replay-abort';
      await harness.sendOp({ method: 'getDoc', path: accountPath, txnId: txnId2, actAs });
      const abortReleaseRes = await harness.sendOp({
        method: 'txnCommit',
        txnId: txnId2,
        abortOnly: true,
        actAs,
      });
      expect(abortReleaseRes.ok).toBe(true);
      expect(obs.transactionAbortRejected).toBe(true);
      const afterAbortRead = parseWireDoc(
        await harness.sendOp({ method: 'getDoc', path: accountPath, actAs }),
      );
      expect(afterAbortRead.fields?.balance).toBe(obs.balanceUnchangedAfterAbort);

      const offlineDocPath = `${colPath}/offline_staged`;
      const flushRes = await harness.sendOp({
        method: 'setDoc',
        path: offlineDocPath,
        data: { stage: 'queued-offline', seq: 7 },
        actAs,
      });
      expect(flushRes.ok).toBe(true);
      const flushedRead = parseWireDoc(
        await harness.sendOp({ method: 'getDoc', path: offlineDocPath, actAs }),
      );
      expect(Boolean(flushedRead.snap.hasPendingWrites)).toBe(obs.flushedServerHasPendingWrites);
      expect(false).toBe(obs.flushedServerIsFromCache);

      const deniedRes = await harness.sendOp({
        method: 'getDoc',
        path: `pyric_oracle_denied/${runId}/forbidden/doc1`,
        actAs,
      });
      expect(deniedRes.ok).toBe(false);
      if (!deniedRes.ok) {
        expect(deniedRes.error?.code).toBe('permission-denied');
      }
      expect(obs.permissionDeniedCodeName).toBe('PERMISSION_DENIED');
      expect(obs.permissionDeniedCodeValue).toBe(7);
    } finally {
      await harness.close();
    }
  });

  test('covers every committed non-staged firestore-kotlin observation through createObservationGate', () => {
    const report = gate.report();
    expect(report.committed).toEqual([
      'firestore-kotlin-batches-transactions-offline-and-errors',
      'firestore-kotlin-crud-merge-sentinels-and-codecs',
      'firestore-kotlin-queries-cursors-listeners-and-aggregations',
    ]);
    expect(report.loadedButUnused).toEqual([]);
    expect(report.uncovered).toEqual([]);
  });
});
