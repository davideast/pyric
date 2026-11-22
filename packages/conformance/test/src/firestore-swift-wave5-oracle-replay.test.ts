import { describe, expect, test } from 'bun:test';
import { firestoreSwiftRows } from '../../registry/firestore-swift.ts';
import { createObservationGate } from '../../src/observation-gate.ts';
import {
  DOC_VALUE_ENCODING,
  extractDocIds,
  FIRESTORE_SWIFT_OBSERVATIONS_DIR,
  openAuthenticatedSwiftFirestoreBridge,
  parseWireDoc,
  requireNestedMap,
  requireWireFields,
  waitUntilSwiftCondition,
  whereClause,
  type WireDocSnap,
} from './firestore-swift-oracle-replay-harness.ts';
import {
  seedSwiftWave5QueriesCollection,
  SWIFT_INEQUALITY_CG_TX_STEM,
  SWIFT_INSTANCE_CODABLE_STEM,
  SWIFT_WAVE5_FILENAMES,
  swiftDocCursorConstraint,
  verifySwiftCollectionGroupAndTxContention,
  verifySwiftInstanceSettingsBundleAndCodableInvariants,
  type FirestoreSwiftWave5InequalityCgTxObservation,
  type FirestoreSwiftWave5InstanceCodableObservation,
} from './firestore-swift-wave5-oracle-replay-harness.ts';

const gate = createObservationGate({
  dir: FIRESTORE_SWIFT_OBSERVATIONS_DIR,
  match: (filename) => SWIFT_WAVE5_FILENAMES.has(filename),
});

describe('Wave 5 firestore-swift Apple firebase-ios-sdk production observation replay over hosted worker bridge', () => {
  test('replays Firestore instances, settings, bundle/namedQuery, SnapshotListenOptions, AsyncSequence snapshots, vector, and Codable wrappers', async () => {
    const obs = gate.load<FirestoreSwiftWave5InstanceCodableObservation>(
      SWIFT_INSTANCE_CODABLE_STEM,
    );
    verifySwiftInstanceSettingsBundleAndCodableInvariants(obs);

    const runId = 'replay_swift_w5_inst_1';
    const harness = await openAuthenticatedSwiftFirestoreBridge(
      `demo-swift-fs-w5-inst-${String(Date.now())}`,
      runId,
      'swift-fs-w5-inst-uid',
    );
    let docSubActive = false;
    let querySubActive = false;

    try {
      const { actAs } = harness;
      const colPath = `pyric_oracle/${runId}/wave5_items`;
      const colSource = { __ref: 'collection', path: colPath };
      const docAlphaPath = `${colPath}/doc_alpha`;
      const docBetaPath = `${colPath}/doc_beta`;
      const codablePath = `${colPath}/codable_doc`;

      expect(
        (
          await harness.sendOp({
            method: 'setDoc',
            path: docAlphaPath,
            data: {
              label: 'alpha-v1',
              rank: 1,
              nested: { tag: 'core' },
              stamped: { __sentinel: 'serverTimestamp' },
              vec: { type: 'firestore/vectorValue/1.0', vectorValues: [1.0, 2.5, 3.75] },
            },
            actAs,
          })
        ).ok,
      ).toBe(true);
      expect(
        (
          await harness.sendOp({
            method: 'setDoc',
            path: docBetaPath,
            data: { label: 'beta-v1', rank: 2 },
            actAs,
          })
        ).ok,
      ).toBe(true);

      const alphaRead = parseWireDoc(
        await harness.sendOp({
          method: 'getDoc',
          path: docAlphaPath,
          docValueEncoding: DOC_VALUE_ENCODING,
          actAs,
        }),
      );
      expect(alphaRead.snap.path === docAlphaPath).toBe(obs.snapshotRefMatchesPath);
      const alphaFields = requireWireFields(alphaRead, 'doc_alpha');
      expect(alphaFields['label']).toBe(obs.getByStringLabel);
      expect(alphaFields['label']).toBe(obs.subscriptLabel);
      const nestedMap = requireNestedMap(alphaFields, 'nested');
      expect(nestedMap['tag']).toBe(obs.getByFieldPathTag);
      const stamped = alphaFields['stamped'] as { seconds?: number };
      expect(typeof stamped.seconds === 'number' && stamped.seconds > 1_700_000_000).toBe(
        obs.dataWithEstimateHasStamped,
      );
      const vecRaw = alphaFields['vec'] as {
        vectorValues?: number[];
        value?: number[];
        values?: number[];
      };
      let decodedVec: number[] = [];
      if (Array.isArray(vecRaw.vectorValues)) {
        decodedVec = vecRaw.vectorValues;
      } else if (Array.isArray(vecRaw.values)) {
        decodedVec = vecRaw.values;
      } else if (Array.isArray(vecRaw.value)) {
        decodedVec = vecRaw.value;
      }
      expect(decodedVec).toEqual(obs.vectorRoundTrip);

      expect(
        (await harness.sendOp({ method: 'updateDoc', path: docAlphaPath, data: { label: 'alpha-v2' }, actAs }))
          .ok,
      ).toBe(true);

      const missingUpdate = await harness.sendOp({
        method: 'updateDoc',
        path: `${colPath}/missing_doc_wave5`,
        data: { label: 'nope' },
        actAs,
      });
      let missingMatchesNotFound = false;
      if (!missingUpdate.ok && missingUpdate.error !== undefined) {
        missingMatchesNotFound = missingUpdate.error.code === 'not-found';
      }
      expect(missingMatchesNotFound).toBe(obs.updateMissingMatchesNotFound);

      expect(alphaRead.snap.id).toBe(obs.asyncDocSnapshotId);
      const orderedIds = extractDocIds(
        await harness.sendOp({
          method: 'getDocs',
          source: {
            __ref: 'query',
            source: colSource,
            constraints: [{ kind: 'orderBy', field: 'rank', fieldSegments: ['rank'], direction: 'asc' }],
          },
          actAs,
        }),
      );
      expect(orderedIds).toEqual(obs.asyncQuerySnapshotIds);
      expect(orderedIds.length === 0).toBe(obs.nonEmptyQueryIsEmpty);
      expect(orderedIds.length).toBe(obs.nonEmptyQueryCount);

      const emptyIds = extractDocIds(
        await harness.sendOp({
          method: 'getDocs',
          source: {
            __ref: 'query',
            source: colSource,
            constraints: [whereClause('rank', '==', 999)],
          },
          actAs,
        }),
      );
      expect(emptyIds.length === 0).toBe(obs.emptyQueryIsEmpty);
      expect(emptyIds.length).toBe(obs.emptyQueryCount);

      const observedLabels: string[] = [];
      const pendingFlags: boolean[] = [];
      const queryChanges: string[] = [];

      harness.subscribe(
        'swift-w5-doc',
        { target: { __ref: 'doc', path: docAlphaPath }, actAs },
        (rawVal) => {
          const snap = rawVal as WireDocSnap;
          pendingFlags.push(Boolean(snap.hasPendingWrites));
          if (snap.exists && snap.data !== null) {
            const parsed = JSON.parse(snap.data.json) as { label?: string };
            if (
              typeof parsed.label === 'string' &&
              observedLabels[observedLabels.length - 1] !== parsed.label
            ) {
              observedLabels.push(parsed.label);
            }
          }
        },
      );
      docSubActive = true;

      harness.subscribe(
        'swift-w5-query',
        {
          target: {
            __ref: 'query',
            source: colSource,
            constraints: [{ kind: 'orderBy', field: 'rank', fieldSegments: ['rank'], direction: 'asc' }],
          },
          actAs,
        },
        (rawVal) => {
          const snap = rawVal as { docs: WireDocSnap[] };
          for (let idx = 0; idx < snap.docs.length; idx += 1) {
            const d = snap.docs[idx];
            if (d !== undefined) {
              queryChanges.push(`0:${d.id}:-1->${String(idx)}`);
            }
          }
        },
      );
      querySubActive = true;

      await waitUntilSwiftCondition(
        'wave5-initial-listeners',
        () => observedLabels.length >= 1 && queryChanges.length >= 2,
      );
      expect(
        (await harness.sendOp({ method: 'updateDoc', path: docAlphaPath, data: { label: 'alpha-v3' }, actAs }))
          .ok,
      ).toBe(true);
      await waitUntilSwiftCondition('wave5-alpha-v3', () => observedLabels.includes('alpha-v3'));

      expect(obs.inSyncFired).toBe(true);
      expect(observedLabels).toEqual(obs.docListenerObservedLabels);
      expect(pendingFlags.length > 0).toBe(obs.optionsListenerObservedMetadata);
      expect(queryChanges.length > 0).toBe(obs.queryOptionsObservedChanges);

      harness.unsubscribe('swift-w5-doc');
      docSubActive = false;
      harness.unsubscribe('swift-w5-query');
      querySubActive = false;
      const countAtUnsub = observedLabels.length;
      expect(
        (await harness.sendOp({ method: 'updateDoc', path: docAlphaPath, data: { label: 'alpha-v4' }, actAs }))
          .ok,
      ).toBe(true);
      await harness.sendOp({ method: 'getDoc', path: docAlphaPath, actAs });
      expect(observedLabels.length === countAtUnsub).toBe(obs.silentAfterListenerRemove);

      // @DocumentID omits `id` from write payload; @ServerTimestamp writes serverTimestamp sentinel on nil.
      expect(
        (
          await harness.sendOp({
            method: 'setDoc',
            path: codablePath,
            data: {
              label: 'codable-v1',
              points: 42,
              active: true,
              stampedAt: { __sentinel: 'serverTimestamp' },
            },
            actAs,
          })
        ).ok,
      ).toBe(true);
      const codableInitial = parseWireDoc(
        await harness.sendOp({
          method: 'getDoc',
          path: codablePath,
          docValueEncoding: DOC_VALUE_ENCODING,
          actAs,
        }),
      );
      const cFields = requireWireFields(codableInitial, 'codableInitial');
      expect('id' in cFields === false).toBe(obs.codableOmittedDocumentIdField);
      const cStamped = cFields['stampedAt'] as { seconds?: number };
      expect(typeof cStamped.seconds === 'number' && cStamped.seconds > 1_700_000_000).toBe(
        obs.codableServerTimestampResolved,
      );
      expect(codableInitial.snap.id).toBe(obs.codableDecodedDocumentId);
      expect(cFields['label']).toBe(obs.codableDecodedLabel);
      expect(cFields['points']).toBe(obs.codableDecodedPoints);
      expect(typeof cStamped.seconds === 'number').toBe(obs.codableDecodedHasTimestamp);

      expect(
        (
          await harness.sendOp({
            method: 'setDoc',
            path: codablePath,
            data: { label: 'codable-v2', points: 99, active: false },
            options: { merge: true },
            actAs,
          })
        ).ok,
      ).toBe(true);
      const codableMerged = parseWireDoc(
        await harness.sendOp({ method: 'getDoc', path: codablePath, actAs }),
      );
      const cMergedFields = requireWireFields(codableMerged, 'codableMerged');
      expect(cMergedFields['label']).toBe(obs.codableMergedLabel);
      expect(cMergedFields['points']).toBe(obs.codableMergedPoints);
      expect(cMergedFields['active']).toBe(obs.codableMergedActive);
    } finally {
      if (docSubActive) {
        harness.unsubscribe('swift-w5-doc');
      }
      if (querySubActive) {
        harness.unsubscribe('swift-w5-query');
      }
      await harness.close();
    }
  });

  test('replays inequality filters, cursors, collectionGroup, WriteBatch/Transaction merge/mergeFields/delete, and TransactionOptions contention', async () => {
    const obs = gate.load<FirestoreSwiftWave5InequalityCgTxObservation>(SWIFT_INEQUALITY_CG_TX_STEM);

    const runId = 'replay_swift_w5_qtx_1';
    const harness = await openAuthenticatedSwiftFirestoreBridge(
      `demo-swift-fs-w5-qtx-${String(Date.now())}`,
      runId,
      'swift-fs-w5-qtx-uid',
    );

    try {
      const { actAs } = harness;
      const colPath = `pyric_oracle/${runId}/wave5_queries`;
      const colSource = { __ref: 'collection', path: colPath };
      await seedSwiftWave5QueriesCollection(harness, colPath);

      const queryIds = (constraints: Array<Record<string, unknown>>): Promise<string[]> =>
        harness
          .sendOp({ method: 'getDocs', source: { __ref: 'query', source: colSource, constraints }, actAs })
          .then(extractDocIds);
      const ascScore = { kind: 'orderBy', field: 'score', fieldSegments: ['score'], direction: 'asc' };

      expect((await queryIds([whereClause('tier', '!=', 'pro')])).sort()).toEqual(obs.notEqualIds);
      expect(await queryIds([whereClause('score', '<', 25), ascScore])).toEqual(obs.lessThanIds);
      expect(await queryIds([whereClause('score', '<=', 20), ascScore])).toEqual(
        obs.lessThanOrEqualIds,
      );
      expect(await queryIds([whereClause('score', '>', 20), ascScore])).toEqual(obs.greaterThanIds);
      expect(await queryIds([whereClause('score', '>=', 30), ascScore])).toEqual(
        obs.greaterThanOrEqualIds,
      );
      expect((await queryIds([whereClause('tags', 'array-contains-any', ['b', 'd'])])).sort()).toEqual(
        obs.arrayContainsAnyIds,
      );
      expect((await queryIds([whereClause('tier', 'not-in', ['pro', 'enterprise'])])).sort()).toEqual(
        obs.notInIds,
      );

      expect(
        await queryIds([
          ascScore,
          { kind: 'startAt', values: [20], valueEncoding: DOC_VALUE_ENCODING },
          { kind: 'endBefore', values: [40], valueEncoding: DOC_VALUE_ENCODING },
        ]),
      ).toEqual(obs.startAtEndBeforeIds);
      expect(
        await queryIds([
          ascScore,
          { kind: 'startAfter', values: [10], valueEncoding: DOC_VALUE_ENCODING },
          { kind: 'endAt', values: [30], valueEncoding: DOC_VALUE_ENCODING },
        ]),
      ).toEqual(obs.startAfterEndAtIds);

      expect(
        await queryIds([
          ascScore,
          swiftDocCursorConstraint('startAt', 20, `${colPath}/d2`),
          swiftDocCursorConstraint('endAt', 30, `${colPath}/d3`),
        ]),
      ).toEqual(obs.startAtDocEndAtDocIds);
      expect(
        await queryIds([
          ascScore,
          swiftDocCursorConstraint('startAfter', 10, `${colPath}/d1`),
          swiftDocCursorConstraint('endBefore', 40, `${colPath}/d4`),
        ]),
      ).toEqual(obs.startAfterDocEndBeforeDocIds);

      const wbMergePath = `${colPath}/wb_merge_doc`;
      expect(
        (
          await harness.sendOp({
            method: 'setDoc',
            path: wbMergePath,
            data: { base: 'kept', replaceMe: 'old' },
            actAs,
          })
        ).ok,
      ).toBe(true);
      expect(
        (
          await harness.sendOp({
            method: 'batchCommit',
            writes: [
              { method: 'set', path: wbMergePath, data: { mergedFlag: true }, options: { merge: true } },
              {
                method: 'set',
                path: wbMergePath,
                data: { replaceMe: 'selected', ignoredField: 'dropped' },
                options: { mergeFields: ['replaceMe'] },
              },
            ],
            actAs,
          })
        ).ok,
      ).toBe(true);
      const wbRead = parseWireDoc(await harness.sendOp({ method: 'getDoc', path: wbMergePath, actAs }));
      const wbFields = requireWireFields(wbRead, 'wbRead');
      expect(wbFields['base'] === 'kept').toBe(obs.batchMergePreservedBase);
      expect(wbFields['mergedFlag'] === true).toBe(obs.batchMergeAddedFlag);
      expect(wbFields['replaceMe'] === 'selected').toBe(obs.batchMergeFieldsUpdatedSelected);
      expect('ignoredField' in wbFields === false).toBe(obs.batchMergeFieldsOmittedUnlisted);

      const txWritePath = `${colPath}/tx_write_doc`;
      const txDeletePath = `${colPath}/tx_delete_target`;
      expect(
        (await harness.sendOp({ method: 'setDoc', path: txDeletePath, data: { ephemeral: true }, actAs }))
          .ok,
      ).toBe(true);
      const txnWriteId = 'swift-w5-txn-set-merge-del';
      expect(
        (
          await harness.sendOp({
            method: 'txnCommit',
            txnId: txnWriteId,
            reads: [],
            writes: [
              { method: 'set', path: txWritePath, data: { step: 1, keep: 'yes' }, options: { merge: false } },
              { method: 'set', path: txWritePath, data: { merged: true }, options: { merge: true } },
              {
                method: 'set',
                path: txWritePath,
                data: { selected: 'ok', skipped: 'no' },
                options: { mergeFields: ['selected'] },
              },
              { method: 'delete', path: txDeletePath },
            ],
            actAs,
          })
        ).ok,
      ).toBe(true);
      const txWriteRead = parseWireDoc(
        await harness.sendOp({ method: 'getDoc', path: txWritePath, actAs }),
      );
      const twFields = requireWireFields(txWriteRead, 'txWriteRead');
      const txSetAndMergeOk =
        twFields['keep'] === 'yes' &&
        twFields['merged'] === true &&
        twFields['selected'] === 'ok' &&
        'skipped' in twFields === false;
      expect(txSetAndMergeOk).toBe(obs.txSetAndMergeSucceeded);
      const txDelRead = parseWireDoc(
        await harness.sendOp({ method: 'getDoc', path: txDeletePath, actAs }),
      );
      expect(txDelRead.snap.exists === false).toBe(obs.txDeleteRemovedTarget);
    } finally {
      await harness.close();
    }

    await verifySwiftCollectionGroupAndTxContention(obs);
  });

  test('promotes 101 verified firestore-swift rows to oracle-backed and covers both Wave 5 observations via createObservationGate', () => {
    const report = gate.report();
    expect(report.committed).toEqual([SWIFT_INEQUALITY_CG_TX_STEM, SWIFT_INSTANCE_CODABLE_STEM]);
    expect(report.loadedButUnused).toEqual([]);
    expect(report.uncovered).toEqual([]);

    const oracleBackedIds = firestoreSwiftRows
      .filter((row) => row.automation === 'oracle-backed')
      .map((row) => row.id);
    const divergedIds = firestoreSwiftRows
      .filter((row) => row.status === 'diverged-documented')
      .map((row) => row.id);
    const remainingUnitIds = firestoreSwiftRows
      .filter((row) => row.status === 'conforms' && row.automation === 'unit-backed')
      .map((row) => row.id);

    expect(oracleBackedIds.length).toBe(101);
    expect(divergedIds).toEqual(['firestore-swift#3', 'firestore-swift#4']);
    expect(remainingUnitIds).toEqual(['firestore-swift#36', 'firestore-swift#61']);
  });
});
