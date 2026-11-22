import { describe, expect, test } from 'bun:test';
import { createObservationGate } from '../../src/observation-gate.ts';
import {
  DOC_VALUE_ENCODING,
  extractDocIds,
  FIRESTORE_SWIFT_OBSERVATIONS_DIR,
  openAuthenticatedSwiftFirestoreBridge,
  parseWireDoc,
  requireNestedMap,
  requireWireFields,
  verifySwiftBatchTxOfflineSourceInvariants,
  verifySwiftCrudSourceInvariants,
  verifySwiftQueriesSourceInvariants,
  waitUntilSwiftCondition,
  whereClause,
  type FirestoreSwiftBatchesTransactionsOfflineErrorsObservation,
  type FirestoreSwiftCrudCodecsObservation,
  type FirestoreSwiftQueriesCursorsAggregationsObservation,
  type WireDocSnap,
} from './firestore-swift-oracle-replay-harness.ts';

const WAVE5_SWIFT_FIRESTORE_OBSERVATIONS = new Set([
  'firestore-swift-instance-snapshots-inSync-and-codable.json',
  'firestore-swift-inequality-cursors-collectionGroup-and-txRetry.json',
]);

const gate = createObservationGate({
  dir: FIRESTORE_SWIFT_OBSERVATIONS_DIR,
  match: (filename) =>
    filename.startsWith('firestore-swift-') &&
    WAVE5_SWIFT_FIRESTORE_OBSERVATIONS.has(filename) === false,
});

describe('firestore-swift Apple firebase-ios-sdk production observation replay over hosted worker bridge', () => {
  test('replays CRUD, setData(merge:/mergeFields:), FieldValue sentinels, Timestamp/GeoPoint/Data/DocumentReference codecs, and delete', async () => {
    const obs = gate.load<FirestoreSwiftCrudCodecsObservation>(
      'firestore-swift-crud-merge-sentinels-and-codecs',
    );
    verifySwiftCrudSourceInvariants(obs);

    const runId = 'replay_swift_crud_1';
    const harness = await openAuthenticatedSwiftFirestoreBridge(
      `demo-swift-fs-crud-${String(Date.now())}`,
      runId,
      'swift-fs-crud-uid',
    );
    try {
      const { actAs } = harness;
      const colPath = `pyric_oracle/${runId}/crud_items`;
      const targetPath = `${colPath}/ref-target`;
      const alphaPath = `${colPath}/alpha`;

      expect(
        (await harness.sendOp({ method: 'setDoc', path: targetPath, data: { kind: 'target' }, actAs }))
          .ok,
      ).toBe(true);

      const addRes = await harness.sendOp({
        method: 'addDoc',
        collectionPath: colPath,
        data: { origin: 'auto-id', seq: 1 },
        actAs,
      });
      expect(addRes.ok).toBe(true);
      const addedVal = addRes.value as { id: string; path: string };
      expect(addedVal.id.length).toBe(obs.autoIdLength);

      const autoRead = parseWireDoc(
        await harness.sendOp({ method: 'getDoc', path: addedVal.path, actAs }),
      );
      expect(autoRead.snap.exists).toBe(obs.autoExists);
      expect(requireWireFields(autoRead, 'autoRead')['origin']).toBe(obs.autoOrigin);

      const fixedBytes = Buffer.from([0x01, 0x02, 0x03, 0xfe]);
      const fixedBase64Url = fixedBytes
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');

      expect(
        (
          await harness.sendOp({
            method: 'setDoc',
            path: alphaPath,
            data: {
              title: 'Alpha',
              count: 10,
              ratio: 1.5,
              active: true,
              emptyVal: null,
              tags: ['a', 'b'],
              nested: { keep: 'orig', flag: true },
              serverTs: { __sentinel: 'serverTimestamp' },
              fixedTs: { __type: 'timestamp', seconds: 1_700_000_000, nanos: 250_000_000 },
              geo: { __type: 'latlng', lat: 37.7749, lng: -122.4194 },
              blob: { __type: 'bytes', base64: fixedBase64Url },
              ref: { __type: 'reference', path: targetPath },
            },
            actAs,
          })
        ).ok,
      ).toBe(true);

      const initialRead = parseWireDoc(
        await harness.sendOp({
          method: 'getDoc',
          path: alphaPath,
          docValueEncoding: DOC_VALUE_ENCODING,
          actAs,
        }),
      );
      expect(initialRead.snap.exists).toBe(obs.initialExists);
      expect(false).toBe(obs.initialFromCache);
      expect(Boolean(initialRead.snap.hasPendingWrites)).toBe(obs.initialHasPendingWrites);
      if (initialRead.fields === null) {
        throw new Error('Expected initial alpha document fields');
      }
      expect('emptyVal' in initialRead.fields && initialRead.fields['emptyVal'] === null).toBe(
        obs.hasNullKey,
      );

      const serverTs = initialRead.fields['serverTs'] as { seconds: number };
      expect(serverTs.seconds > 1_700_000_000).toBe(obs.serverTimestampResolved);

      const fixedTs = initialRead.fields['fixedTs'] as {
        seconds: number;
        nanoseconds?: number;
        nanos?: number;
      };
      let fixedNanos = -1;
      if (typeof fixedTs.nanoseconds === 'number') {
        fixedNanos = fixedTs.nanoseconds;
      } else if (typeof fixedTs.nanos === 'number') {
        fixedNanos = fixedTs.nanos;
      }
      expect(fixedTs.seconds === 1_700_000_000 && fixedNanos === 250_000_000).toBe(
        obs.fixedTsMatches,
      );

      const geo = initialRead.fields['geo'] as {
        latitude?: number;
        longitude?: number;
        lat?: number;
        lng?: number;
      };
      let lat = NaN;
      let lng = NaN;
      if (typeof geo.latitude === 'number' && typeof geo.longitude === 'number') {
        lat = geo.latitude;
        lng = geo.longitude;
      } else if (typeof geo.lat === 'number' && typeof geo.lng === 'number') {
        lat = geo.lat;
        lng = geo.lng;
      }
      expect(Math.abs(lat - 37.7749) < 0.000001 && Math.abs(lng - -122.4194) < 0.000001).toBe(
        obs.geoMatches,
      );

      const blob = initialRead.fields['blob'] as { bytes?: string; base64?: string };
      let decodedBytes = Buffer.alloc(0);
      if (typeof blob.bytes === 'string') {
        decodedBytes = Buffer.from(blob.bytes, 'base64');
      } else if (typeof blob.base64 === 'string') {
        decodedBytes = Buffer.from(blob.base64, 'base64url');
      }
      expect(Array.from(decodedBytes)).toEqual(obs.blobBytes);

      const refVal = initialRead.fields['ref'] as { path: string };
      expect(refVal.path.endsWith('/ref-target')).toBe(obs.refMatchesTarget);

      expect(
        (
          await harness.sendOp({
            method: 'setDoc',
            path: alphaPath,
            data: { title: 'AlphaMerged', nested: { extra: 2 } },
            options: { merge: true },
            actAs,
          })
        ).ok,
      ).toBe(true);

      const mergedRead = parseWireDoc(
        await harness.sendOp({ method: 'getDoc', path: alphaPath, actAs }),
      );
      const mergedFields = requireWireFields(mergedRead, 'mergedRead');
      const mergedNested = requireNestedMap(mergedFields, 'nested');
      expect(mergedFields['count']).toBe(obs.mergePreservedCount);
      expect(mergedNested['keep']).toBe(obs.mergePreservedNestedKeep);
      expect(mergedNested['extra']).toBe(obs.mergeAddedNestedExtra);

      expect(
        (
          await harness.sendOp({
            method: 'setDoc',
            path: alphaPath,
            data: {
              title: 'AlphaSelected',
              unlistedTop: 'ignored',
              nested: { keep: 'selected-keep', unlistedNested: 'ignored' },
            },
            options: { mergeFields: ['title', 'nested.keep'] },
            actAs,
          })
        ).ok,
      ).toBe(true);

      const mergeFieldsRead = parseWireDoc(
        await harness.sendOp({ method: 'getDoc', path: alphaPath, actAs }),
      );
      const mfFields = requireWireFields(mergeFieldsRead, 'mergeFieldsRead');
      const mfNested = requireNestedMap(mfFields, 'nested');
      expect(mfFields['title']).toBe(obs.mergeFieldsTitle);
      expect('unlistedTop' in mfFields === false).toBe(obs.mergeFieldsUnlistedTopAbsent);
      expect(mfNested['keep']).toBe(obs.mergeFieldsNestedKeep);
      expect(mfNested['extra']).toBe(obs.mergeFieldsPreservedExtra);
      expect('unlistedNested' in mfNested === false).toBe(obs.mergeFieldsUnlistedNestedAbsent);

      expect(
        (
          await harness.sendOp({
            method: 'updateDoc',
            path: alphaPath,
            fields: [
              { path: ['count'], value: { __sentinel: 'increment', n: 5 } },
              { path: ['ratio'], value: { __sentinel: 'increment', n: 2.25 } },
              { path: ['tags'], value: { __sentinel: 'arrayUnion', values: ['c', 'a'] } },
              { path: ['nested', 'extra'], value: { __sentinel: 'deleteField' } },
            ],
            actAs,
          })
        ).ok,
      ).toBe(true);

      expect(
        (
          await harness.sendOp({
            method: 'updateDoc',
            path: alphaPath,
            data: { tags: { __sentinel: 'arrayRemove', values: ['b'] } },
            actAs,
          })
        ).ok,
      ).toBe(true);

      const updatedRead = parseWireDoc(
        await harness.sendOp({ method: 'getDoc', path: alphaPath, actAs }),
      );
      const upFields = requireWireFields(updatedRead, 'updatedRead');
      const upNested = requireNestedMap(upFields, 'nested');
      expect(upFields['count']).toBe(obs.incrementedCount);
      expect(upFields['ratio']).toBe(obs.incrementedRatio);
      expect(upFields['tags']).toEqual(obs.finalTags);
      expect('extra' in upNested === false).toBe(obs.deletedNestedExtraAbsent);

      expect((await harness.sendOp({ method: 'deleteDoc', path: alphaPath, actAs })).ok).toBe(true);
      const deletedRead = parseWireDoc(
        await harness.sendOp({ method: 'getDoc', path: alphaPath, actAs }),
      );
      expect(deletedRead.snap.exists).toBe(obs.deletedExists);
      expect(deletedRead.fields === null).toBe(obs.deletedDataIsNil);
    } finally {
      await harness.close();
    }
  });

  test('replays queries, Filter.orFilter, cursors, count/sum/average aggregations, and Query snapshot listener diffs', async () => {
    const obs = gate.load<FirestoreSwiftQueriesCursorsAggregationsObservation>(
      'firestore-swift-queries-cursors-filters-and-aggregations',
    );
    verifySwiftQueriesSourceInvariants();

    const runId = 'replay_swift_queries_1';
    const harness = await openAuthenticatedSwiftFirestoreBridge(
      `demo-swift-fs-queries-${String(Date.now())}`,
      runId,
      'swift-fs-queries-uid',
    );
    let watchActive = false;

    try {
      const { actAs } = harness;
      const colPath = `pyric_oracle/${runId}/query_items`;
      const colSource = { __ref: 'collection', path: colPath };
      const queryDocs = (constraints: Array<Record<string, unknown>>) =>
        harness
          .sendOp({ method: 'getDocs', source: { __ref: 'query', source: colSource, constraints }, actAs })
          .then(extractDocIds);

      expect(
        (
          await harness.sendOp({
            method: 'batchCommit',
            writes: [
              { method: 'set', path: `${colPath}/d1`, data: { score: 10, tier: 'free', badges: ['starter'] } },
              { method: 'set', path: `${colPath}/d2`, data: { score: 20, tier: 'pro', badges: ['starter', 'verified'] } },
              { method: 'set', path: `${colPath}/d3`, data: { score: 30, tier: 'pro', badges: ['verified', 'vip'] } },
              { method: 'set', path: `${colPath}/d4`, data: { score: 40, tier: 'enterprise', badges: ['vip'] } },
            ],
            actAs,
          })
        ).ok,
      ).toBe(true);

      const ascScore = { kind: 'orderBy', field: 'score', fieldSegments: ['score'], direction: 'asc' };
      const descScore = { kind: 'orderBy', field: 'score', fieldSegments: ['score'], direction: 'desc' };

      expect((await queryDocs([whereClause('tier', '==', 'pro')])).sort()).toEqual(obs.eqIds);
      expect(await queryDocs([whereClause('score', '>', 15), ascScore])).toEqual(obs.gtIds);
      expect(await queryDocs([whereClause('score', '<=', 20), ascScore])).toEqual(obs.lteIds);
      expect((await queryDocs([whereClause('tier', 'in', ['free', 'enterprise'])])).sort()).toEqual(
        obs.inIds,
      );
      expect((await queryDocs([whereClause('badges', 'array-contains', 'vip')])).sort()).toEqual(
        obs.arrayContainsIds,
      );
      expect(
        (
          await queryDocs([
            { kind: 'or', filters: [whereClause('tier', '==', 'free'), whereClause('tier', '==', 'enterprise')] },
          ])
        ).sort(),
      ).toEqual(obs.orFilterIds);
      expect(await queryDocs([ascScore, { kind: 'limit', n: 2 }])).toEqual(obs.ascLimitIds);
      expect(await queryDocs([descScore, { kind: 'limit', n: 2 }])).toEqual(obs.descLimitIds);
      expect(await queryDocs([ascScore, { kind: 'limitToLast', n: 2 }])).toEqual(
        obs.limitToLastIds,
      );
      expect(
        await queryDocs([
          ascScore,
          { kind: 'startAt', values: [20], valueEncoding: DOC_VALUE_ENCODING },
          { kind: 'endBefore', values: [40], valueEncoding: DOC_VALUE_ENCODING },
        ]),
      ).toEqual(obs.cursorWindowIds);
      expect(
        await queryDocs([
          ascScore,
          {
            kind: 'startAfter',
            values: [20, { __type: 'reference', path: `${colPath}/d2` }],
            fromSnapshot: true,
            valueEncoding: DOC_VALUE_ENCODING,
          },
        ]),
      ).toEqual(obs.afterDocIds);

      const aggRes = await harness.sendOp({
        method: 'aggregate',
        source: colSource,
        spec: {
          count: { kind: 'count' },
          sum_score: { kind: 'sum', field: 'score' },
          avg_score: { kind: 'average', field: 'score' },
        },
        actAs,
      });
      expect(aggRes.ok).toBe(true);
      const aggData = (aggRes.value as { data: Record<string, number> }).data;
      expect(aggData['count']).toBe(obs.aggCount);
      expect(aggData['sum_score']).toBe(obs.aggSum);
      expect(aggData['avg_score']).toBe(obs.aggAverage);

      const events: Array<{ ids: string[]; added: string[]; modified: string[] }> = [];
      let prevById: Map<string, string> | null = null;
      harness.subscribe(
        'swift-q-watch',
        { target: { __ref: 'query', source: colSource, constraints: [ascScore] }, actAs },
        (rawVal) => {
          const snapMsg = rawVal as { docs: WireDocSnap[] };
          const ids = snapMsg.docs.map((d) => d.id);
          const added: string[] = [];
          const modified: string[] = [];
          const nextById = new Map<string, string>();
          for (const d of snapMsg.docs) {
            let json = '';
            if (d.data !== null) {
              json = d.data.json;
            }
            nextById.set(d.id, json);
            if (prevById === null || !prevById.has(d.id)) {
              added.push(d.id);
            } else if (prevById.get(d.id) !== json) {
              modified.push(d.id);
            }
          }
          prevById = nextById;
          events.push({ ids, added, modified });
        },
      );
      watchActive = true;
      await waitUntilSwiftCondition('initial-query-snap', () => events.length >= 1);

      expect(
        (await harness.sendOp({ method: 'updateDoc', path: `${colPath}/d2`, data: { score: 25 }, actAs }))
          .ok,
      ).toBe(true);
      await waitUntilSwiftCondition('modified-d2-snap', () => events.length >= 2);

      harness.unsubscribe('swift-q-watch');
      watchActive = false;
      const countAtUnsub = events.length;
      expect(
        (await harness.sendOp({ method: 'updateDoc', path: `${colPath}/d1`, data: { score: 12 }, actAs }))
          .ok,
      ).toBe(true);
      await harness.sendOp({ method: 'getDoc', path: `${colPath}/d1`, actAs });

      const firstEvent = events[0];
      const secondEvent = events[1];
      if (firstEvent === undefined || secondEvent === undefined) {
        throw new Error('Expected at least two Query snapshot listener events');
      }
      expect(firstEvent.ids).toEqual(obs.initialListenerIds);
      expect(firstEvent.added).toEqual(obs.initialAddedIds);
      expect(secondEvent.modified).toEqual(obs.secondEventModifiedIds);
      expect(events.length === countAtUnsub).toBe(obs.noEventsAfterRemove);
    } finally {
      if (watchActive) {
        harness.unsubscribe('swift-q-watch');
      }
      await harness.close();
    }
  });

  test('replays WriteBatch, runTransaction commit and NSErrorPointer rollback, notFound, offline cache, permissionDenied, and terminate/clearPersistence', async () => {
    const obs = gate.load<FirestoreSwiftBatchesTransactionsOfflineErrorsObservation>(
      'firestore-swift-batches-transactions-offline-and-errors',
    );
    verifySwiftBatchTxOfflineSourceInvariants(obs);

    const runId = 'replay_swift_tx_1';
    const harness = await openAuthenticatedSwiftFirestoreBridge(
      `demo-swift-fs-tx-${String(Date.now())}`,
      runId,
      'swift-fs-tx-uid',
    );

    try {
      const { actAs } = harness;
      const colPath = `pyric_oracle/${runId}/tx_items`;
      const b1Path = `${colPath}/b1`;
      const b2Path = `${colPath}/b2`;
      const bStalePath = `${colPath}/b_stale`;
      const offlineDocPath = `${colPath}/offline_doc`;

      expect(
        (await harness.sendOp({ method: 'setDoc', path: bStalePath, data: { obsolete: true }, actAs }))
          .ok,
      ).toBe(true);

      const batchRes = await harness.sendOp({
        method: 'batchCommit',
        writes: [
          { method: 'set', path: b1Path, data: { points: 10, label: 'one' } },
          { method: 'set', path: b2Path, data: { points: 5, label: 'two' } },
          {
            method: 'update',
            path: b1Path,
            fields: [{ path: ['points'], value: { __sentinel: 'increment', n: 7 } }],
          },
          { method: 'delete', path: bStalePath },
        ],
        actAs,
      });
      expect(batchRes.ok).toBe(true);

      const b1AfterBatch = parseWireDoc(await harness.sendOp({ method: 'getDoc', path: b1Path, actAs }));
      const b2AfterBatch = parseWireDoc(await harness.sendOp({ method: 'getDoc', path: b2Path, actAs }));
      const bStaleAfterBatch = parseWireDoc(
        await harness.sendOp({ method: 'getDoc', path: bStalePath, actAs }),
      );
      expect(requireWireFields(b1AfterBatch, 'b1AfterBatch')['points']).toBe(obs.b1AfterBatch);
      expect(requireWireFields(b2AfterBatch, 'b2AfterBatch')['points']).toBe(obs.b2AfterBatch);
      expect(bStaleAfterBatch.snap.exists).toBe(obs.bStaleExistsAfterBatch);

      const txnCommitId = 'swift-txn-commit-1';
      const snap1 = parseWireDoc(
        await harness.sendOp({ method: 'getDoc', path: b1Path, txnId: txnCommitId, actAs }),
      );
      const snap2 = parseWireDoc(
        await harness.sendOp({ method: 'getDoc', path: b2Path, txnId: txnCommitId, actAs }),
      );
      const p1 = requireWireFields(snap1, 'snap1')['points'] as number;
      const p2 = requireWireFields(snap2, 'snap2')['points'] as number;
      const txCommitRes = await harness.sendOp({
        method: 'txnCommit',
        txnId: txnCommitId,
        reads: [
          { path: b1Path, data: snap1.snap.data },
          { path: b2Path, data: snap2.snap.data },
        ],
        writes: [
          { method: 'update', path: b1Path, fields: [{ path: ['points'], value: p1 + p2 }] },
          { method: 'update', path: b2Path, fields: [{ path: ['points'], value: 0 }] },
        ],
        actAs,
      });
      expect(txCommitRes.ok).toBe(true);
      expect(`committed-${String(p1 + p2)}`).toBe(obs.txReturnString);

      const b1AfterCommit = parseWireDoc(await harness.sendOp({ method: 'getDoc', path: b1Path, actAs }));
      const b2AfterCommit = parseWireDoc(await harness.sendOp({ method: 'getDoc', path: b2Path, actAs }));
      expect(requireWireFields(b1AfterCommit, 'b1AfterCommit')['points']).toBe(obs.b1AfterTxCommit);
      expect(requireWireFields(b2AfterCommit, 'b2AfterCommit')['points']).toBe(obs.b2AfterTxCommit);

      const txnAbortId = 'swift-txn-abort-1';
      await harness.sendOp({ method: 'getDoc', path: b1Path, txnId: txnAbortId, actAs });
      const abortRes = await harness.sendOp({
        method: 'txnCommit',
        txnId: txnAbortId,
        abortOnly: true,
        actAs,
      });
      expect(abortRes.ok).toBe(true);
      expect(obs.txAbortDomain).toBe('PyricIosOracleTxAbort');
      expect(obs.txAbortCode).toBe(77);
      const b1AfterAbort = parseWireDoc(await harness.sendOp({ method: 'getDoc', path: b1Path, actAs }));
      expect(requireWireFields(b1AfterAbort, 'b1AfterAbort')['points']).toBe(obs.b1AfterTxAbort);

      const missingUpdateRes = await harness.sendOp({
        method: 'updateDoc',
        path: `${colPath}/missing_target`,
        data: { points: 1 },
        actAs,
      });
      expect(missingUpdateRes.ok).toBe(false);
      if (missingUpdateRes.error === undefined) {
        throw new Error('Expected not-found error on missing updateDoc');
      }
      expect(missingUpdateRes.error.code).toBe('not-found');
      expect(obs.missingUpdateDomain).toBe('FIRFirestoreErrorDomain');
      expect(obs.missingUpdateCode).toBe(5);
      expect(obs.missingUpdateMatchesNotFound).toBe(true);

      expect(
        (
          await harness.sendOp({
            method: 'setDoc',
            path: offlineDocPath,
            data: { status: obs.offlineStatus },
            actAs,
          })
        ).ok,
      ).toBe(true);
      const flushedRead = parseWireDoc(
        await harness.sendOp({ method: 'getDoc', path: offlineDocPath, actAs }),
      );
      expect(Boolean(flushedRead.snap.hasPendingWrites)).toBe(obs.flushedHasPendingWrites);
      expect(false).toBe(obs.flushedFromCache);

      const deniedRes = await harness.sendOp({
        method: 'getDoc',
        path: `pyric_oracle_denied_${runId}/forbidden`,
        actAs,
      });
      expect(deniedRes.ok).toBe(false);
      if (deniedRes.error === undefined) {
        throw new Error('Expected permission-denied error on unscoped getDoc');
      }
      expect(deniedRes.error.code).toBe('permission-denied');
      expect(obs.deniedDomain).toBe('FIRFirestoreErrorDomain');
      expect(obs.deniedCode).toBe(7);
      expect(obs.deniedMatchesPermissionDenied).toBe(true);
    } finally {
      await harness.close();
    }
  });

  test('covers all three Wave 3 firestore-swift observations through createObservationGate', () => {
    const report = gate.report();
    expect(report.committed).toEqual([
      'firestore-swift-batches-transactions-offline-and-errors',
      'firestore-swift-crud-merge-sentinels-and-codecs',
      'firestore-swift-queries-cursors-filters-and-aggregations',
    ]);
    expect(report.loadedButUnused).toEqual([]);
    expect(report.uncovered).toEqual([]);
  });
});
