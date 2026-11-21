import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createObservationGate } from '../../src/observation-gate.ts';
import {
  DOC_VALUE_ENCODING,
  extractDocIds,
  FIRESTORE_KOTLIN_OBSERVATIONS_DIR,
  KT_MAIN_ROOT,
  openAuthenticatedFirestoreBridge,
  parseWireDoc,
  whereClause,
  type WireDocSnap,
} from './firestore-kotlin-oracle-replay-harness.ts';
import {
  docCursorConstraint,
  INEQUALITY_CG_TX_STEM,
  INSTANCE_FLOWS_STEM,
  seedWave5ScoreCollection,
  waitUntilCondition,
  WAVE5_FILENAMES,
  type FirestoreKotlinWave5InequalityCgTxObservation,
  type FirestoreKotlinWave5InstanceFlowsObservation,
} from './firestore-kotlin-wave5-oracle-replay-harness.ts';

const gate = createObservationGate({
  dir: FIRESTORE_KOTLIN_OBSERVATIONS_DIR,
  match: (filename) => WAVE5_FILENAMES.has(filename),
});

describe('Wave 5 firestore-kotlin Android SDK production observation replay over hosted worker bridge', () => {
  test('firestore-kotlin#1 firestore-kotlin#4 firestore-kotlin#13 firestore-kotlin#17 firestore-kotlin#20 firestore-kotlin#36 firestore-kotlin#42 replay getInstance, document(path), update(Map), toObject, inSync, and snapshots Flows', async () => {
    const obs = gate.load<FirestoreKotlinWave5InstanceFlowsObservation>(INSTANCE_FLOWS_STEM);

    const firestoreKt = readFileSync(
      join(KT_MAIN_ROOT, 'com', 'google', 'firebase', 'firestore', 'FirebaseFirestore.kt'),
      'utf8',
    );
    const ktxKt = readFileSync(
      join(KT_MAIN_ROOT, 'com', 'google', 'firebase', 'firestore', 'Firestore.kt'),
      'utf8',
    );
    const docRefKt = readFileSync(
      join(KT_MAIN_ROOT, 'com', 'google', 'firebase', 'firestore', 'DocumentReference.kt'),
      'utf8',
    );
    const pojoCodecKt = readFileSync(
      join(KT_MAIN_ROOT, 'dev', 'pyric', 'codecs', 'PojoCodec.kt'),
      'utf8',
    );
    const coordinatorKt = readFileSync(
      join(KT_MAIN_ROOT, 'com', 'google', 'firebase', 'firestore', 'FirestoreOfflineCoordinator.kt'),
      'utf8',
    );

    expect(obs.defaultInstanceSameAsKtx).toBe(true);
    expect(obs.defaultInstanceAppName).toBe('[DEFAULT]');
    expect(obs.namedInstanceSameAsKtx).toBe(true);
    expect(obs.defaultAndNamedInstancesDistinct).toBe(true);
    expect(firestoreKt).toContain('getInstance(FirebaseApp.getInstance(), "(default)")');
    expect(ktxKt).toContain('val Firebase.firestore: FirebaseFirestore');
    expect(ktxKt).toContain('fun Firebase.firestore(app: FirebaseApp): FirebaseFirestore');

    expect(obs.directDocEqualsCollectionChain).toBe(true);
    expect(obs.directDocId).toBe('direct_profile');
    expect(obs.directDocParentId).toBe('instance_flows');
    expect(obs.directDocOddSegmentsThrowsIllegalArgument).toBe(true);
    expect(firestoreKt).toContain('require(segments.isNotEmpty() && segments.size % 2 == 0)');
    expect(docRefKt).toContain('return path == other.path && firestore == other.firestore');

    expect(obs.toObjectClassMatchesReified).toBe(true);
    expect(obs.toObjectMissingDocReturnsNull).toBe(true);
    expect(obs.inSyncFiredOnAttach).toBe(true);
    expect(obs.inSyncFiredAfterWrite).toBe(true);
    expect(obs.inSyncQuietAfterRemove).toBe(true);
    expect(obs.docSnapshotsIncludeObservedPendingAndSynced).toBe(true);
    expect(pojoCodecKt).toContain('field.isAnnotationPresent(DocumentId::class.java)');
    expect(coordinatorKt).toContain('fun addSnapshotsInSyncListener(');
    expect(ktxKt).toContain('fun DocumentReference.snapshots(');
    expect(ktxKt).toContain('fun Query.snapshots(');

    const runId = 'replay_wave5_inst_1';
    const harness = await openAuthenticatedFirestoreBridge(
      `demo-kt-fs-w5-inst-${Date.now()}`,
      runId,
      'android-fs-w5-inst-uid',
    );
    let docSubActive = false;
    let querySubActive = false;
    try {
      const { actAs } = harness;
      const basePath = `pyric_oracle/${runId}/instance_flows`;
      const directProfilePath = `${basePath}/direct_profile`;

      const seedRes = await harness.sendOp({
        method: 'setDoc',
        path: directProfilePath,
        data: {
          handle: 'grace',
          level: 3,
          score: 42.5,
          active: true,
          tags: ['kotlin', 'android'],
          counters: { commits: 10, reviews: 4 },
          primaryBadge: { code: 'pioneer', tier: 2 },
          obsolete: 'remove-via-map-update',
        },
        actAs,
      });
      expect(seedRes.ok).toBe(true);

      const updateMapRes = await harness.sendOp({
        method: 'updateDoc',
        path: directProfilePath,
        data: {
          level: 5,
          'counters.reviews': 9,
          obsolete: { __sentinel: 'deleteField' },
        },
        actAs,
      });
      expect(updateMapRes.ok).toBe(true);

      const missingUpdateRes = await harness.sendOp({
        method: 'updateDoc',
        path: `${basePath}/missing_for_update`,
        data: { level: 1 },
        actAs,
      });
      expect(missingUpdateRes.ok).toBe(false);
      let missingCode = '';
      if (missingUpdateRes.error !== undefined) {
        missingCode = missingUpdateRes.error.code;
      }
      expect(missingCode.replace(/^firestore\//, '').toUpperCase().replace(/-/g, '_')).toBe(
        obs.updateMissingDocErrorCodeName,
      );

      const updatedRead = parseWireDoc(
        await harness.sendOp({ method: 'getDoc', path: directProfilePath, actAs }),
      );
      expect(updatedRead.snap.id).toBe(obs.toObjectDocumentId);
      expect(updatedRead.fields).not.toBeNull();
      if (updatedRead.fields === null) {
        throw new Error('Expected direct_profile fields to exist');
      }
      expect(updatedRead.fields['handle']).toBe(obs.updateMapPreservedHandle);
      expect(updatedRead.fields['handle']).toBe(obs.toObjectHandle);
      expect(updatedRead.fields['level']).toBe(obs.updateMapUpdatedLevel);
      expect(updatedRead.fields['level']).toBe(obs.toObjectLevel);
      expect(updatedRead.fields['score']).toBe(obs.toObjectScore);
      expect(updatedRead.fields['active']).toBe(obs.toObjectActive);
      expect(updatedRead.fields['tags']).toEqual(obs.toObjectTags);
      const counters = updatedRead.fields['counters'] as Record<string, unknown>;
      expect(counters['reviews']).toBe(obs.updateMapNestedReviews);
      expect(counters['commits']).toBe(obs.updateMapPreservedCommits);
      expect('obsolete' in updatedRead.fields).toBe(obs.updateMapDeletedFieldPresent);
      const badge = updatedRead.fields['primaryBadge'] as Record<string, unknown>;
      expect(badge['code']).toBe(obs.toObjectNestedBadgeCode);
      expect(badge['tier']).toBe(obs.toObjectNestedBadgeTier);

      const docFlowPath = `${basePath}/doc_flow_target`;
      expect(
        (
          await harness.sendOp({
            method: 'setDoc',
            path: docFlowPath,
            data: { stage: 'alpha', seq: 1 },
            actAs,
          })
        ).ok,
      ).toBe(true);

      const observedStages: string[] = [];
      harness.subscribe(
        'w5-doc-flow',
        { target: { __ref: 'doc', path: docFlowPath }, actAs },
        (rawVal) => {
          const docSnap = rawVal as WireDocSnap;
          if (docSnap.exists && docSnap.data !== null) {
            const parsed = JSON.parse(docSnap.data.json) as { stage: string; seq: number };
            const entry = `${parsed.stage}:${parsed.seq}`;
            if (observedStages[observedStages.length - 1] !== entry) {
              observedStages.push(entry);
            }
          }
        },
      );
      docSubActive = true;
      await waitUntilCondition('docFlow.alpha', () => observedStages.includes('alpha:1'));

      expect(
        (
          await harness.sendOp({
            method: 'updateDoc',
            path: docFlowPath,
            data: { stage: 'beta', seq: 2 },
            actAs,
          })
        ).ok,
      ).toBe(true);
      await waitUntilCondition('docFlow.beta', () => observedStages.includes('beta:2'));
      expect(observedStages).toEqual(obs.docSnapshotsExcludeStages);

      harness.unsubscribe('w5-doc-flow');
      docSubActive = false;
      const stagesAtCancel = observedStages.length;
      expect(
        (
          await harness.sendOp({
            method: 'updateDoc',
            path: docFlowPath,
            data: { stage: 'gamma', seq: 3 },
            actAs,
          })
        ).ok,
      ).toBe(true);
      await new Promise<void>((resolveTick) => setTimeout(resolveTick, 40));
      expect(observedStages.length === stagesAtCancel).toBe(obs.docSnapshotsQuietAfterCancel);

      const queryFlowCol = `pyric_oracle/${runId}/query_flows`;
      expect(
        (
          await harness.sendOp({
            method: 'setDoc',
            path: `${queryFlowCol}/qf_1`,
            data: { handle: 'linus', level: 20, score: 88.0, active: true },
            actAs,
          })
        ).ok,
      ).toBe(true);

      const queryHistory: string[][] = [];
      const latestPojoHandles: string[][] = [];
      harness.subscribe(
        'w5-query-flow',
        {
          target: {
            __ref: 'query',
            source: { __ref: 'collection', path: queryFlowCol },
            constraints: [
              whereClause('level', '<', 100),
              { kind: 'orderBy', field: 'level', fieldSegments: ['level'], direction: 'asc' },
            ],
          },
          actAs,
        },
        (rawVal) => {
          const snapMsg = rawVal as { docs: WireDocSnap[] };
          const ids = snapMsg.docs.map((d) => d.id);
          const prev = queryHistory[queryHistory.length - 1];
          let changed = prev === undefined || prev.length !== ids.length;
          if (changed === false && prev !== undefined) {
            for (let i = 0; i < ids.length; i += 1) {
              if (prev[i] !== ids[i]) {
                changed = true;
              }
            }
          }
          if (changed) {
            queryHistory.push(ids);
          }
          const handles: string[] = [];
          for (const d of snapMsg.docs) {
            if (d.data !== null) {
              const fields = JSON.parse(d.data.json) as { handle: string };
              handles.push(`${d.id}:${fields.handle}`);
            }
          }
          latestPojoHandles.push(handles);
        },
      );
      querySubActive = true;
      await waitUntilCondition('queryFlow.initial', () => queryHistory.length >= 1);

      expect(
        (
          await harness.sendOp({
            method: 'setDoc',
            path: `${queryFlowCol}/qf_2`,
            data: { handle: 'margaret', level: 10, score: 95.0, active: true },
            actAs,
          })
        ).ok,
      ).toBe(true);
      await waitUntilCondition('queryFlow.added2', () => queryHistory.length >= 2);

      expect(
        (
          await harness.sendOp({
            method: 'updateDoc',
            path: `${queryFlowCol}/qf_1`,
            data: { level: 200 },
            actAs,
          })
        ).ok,
      ).toBe(true);
      await waitUntilCondition('queryFlow.filtered1', () => queryHistory.length >= 3);

      expect(queryHistory).toEqual(obs.querySnapshotsEmissionHistory);
      expect(latestPojoHandles[latestPojoHandles.length - 1]).toEqual(
        obs.querySnapshotsLatestToObjects,
      );

      harness.unsubscribe('w5-query-flow');
      querySubActive = false;
      const queryCountAtCancel = queryHistory.length;
      expect(
        (
          await harness.sendOp({
            method: 'setDoc',
            path: `${queryFlowCol}/qf_3`,
            data: { handle: 'barbara', level: 5, score: 99.0, active: true },
            actAs,
          })
        ).ok,
      ).toBe(true);
      await new Promise<void>((resolveTick) => setTimeout(resolveTick, 40));
      expect(queryHistory.length === queryCountAtCancel).toBe(obs.querySnapshotsQuietAfterCancel);
    } finally {
      if (docSubActive) {
        harness.unsubscribe('w5-doc-flow');
      }
      if (querySubActive) {
        harness.unsubscribe('w5-query-flow');
      }
      await harness.close();
    }
  });

  test('firestore-kotlin#8 firestore-kotlin#22 firestore-kotlin#23 firestore-kotlin#27 firestore-kotlin#32 firestore-kotlin#34 firestore-kotlin#52 replay inequality filters, cursors, and contended runTransaction + delete', async () => {
    const obs = gate.load<FirestoreKotlinWave5InequalityCgTxObservation>(INEQUALITY_CG_TX_STEM);

    const txOptionsKt = readFileSync(
      join(KT_MAIN_ROOT, 'com', 'google', 'firebase', 'firestore', 'TransactionOptions.kt'),
      'utf8',
    );
    const txKt = readFileSync(
      join(KT_MAIN_ROOT, 'com', 'google', 'firebase', 'firestore', 'Transaction.kt'),
      'utf8',
    );
    expect(obs.txInvalidMaxAttemptsThrowsIllegalArgument).toBe(true);
    expect(txOptionsKt).toContain('require(maxAttempts > 0)');
    expect(txKt).toContain('fun delete(documentRef: DocumentReference): Transaction');

    const runId = 'replay_wave5_qtx_1';
    const harness = await openAuthenticatedFirestoreBridge(
      `demo-kt-fs-w5-qtx-${Date.now()}`,
      runId,
      'android-fs-w5-qtx-uid',
    );
    try {
      const { actAs } = harness;
      const colPath = `pyric_oracle/${runId}/query_wave5`;
      await seedWave5ScoreCollection(harness, colPath);

      const queryIds = async (constraints: Array<Record<string, unknown>>): Promise<string[]> =>
        extractDocIds(
          await harness.sendOp({
            method: 'getDocs',
            source: {
              __ref: 'query',
              source: { __ref: 'collection', path: colPath },
              constraints,
            },
            actAs,
          }),
        );

      const ascScore = { kind: 'orderBy', field: 'score', fieldSegments: ['score'], direction: 'asc' };
      const descScore = {
        kind: 'orderBy',
        field: 'score',
        fieldSegments: ['score'],
        direction: 'desc',
      };

      expect(await queryIds([whereClause('tier', '!=', 'gold')])).toEqual(
        obs.whereNotEqualToTierIds,
      );
      expect(await queryIds([whereClause('score', '!=', 30), ascScore])).toEqual(
        obs.whereNotEqualToScoreIds,
      );

      expect(await queryIds([whereClause('score', '<', 30), ascScore])).toEqual(
        obs.whereLessThanIds,
      );
      expect(await queryIds([whereClause('score', '<=', 30), ascScore])).toEqual(
        obs.whereLessThanOrEqualToIds,
      );
      expect(await queryIds([whereClause('score', '>', 30), ascScore])).toEqual(
        obs.whereGreaterThanIds,
      );
      expect(await queryIds([whereClause('score', '>=', 30), ascScore])).toEqual(
        obs.whereGreaterThanOrEqualToIds,
      );
      expect(
        await queryIds([whereClause('score', '>', 10), whereClause('score', '<', 50), descScore]),
      ).toEqual(obs.openRangeDescIds);

      expect(await queryIds([whereClause('tier', 'not-in', ['bronze', 'gold', 'diamond'])])).toEqual(
        obs.whereNotInTierIds,
      );
      expect(await queryIds([whereClause('score', 'not-in', [10, 50]), ascScore])).toEqual(
        obs.whereNotInScoreIds,
      );

      expect(
        await queryIds([
          ascScore,
          { kind: 'startAt', values: [20], valueEncoding: DOC_VALUE_ENCODING },
          { kind: 'limit', n: 2 },
        ]),
      ).toEqual(obs.cursorStartAtValuesLimit2Ids);
      expect(
        await queryIds([
          ascScore,
          { kind: 'startAfter', values: [20], valueEncoding: DOC_VALUE_ENCODING },
          { kind: 'endAt', values: [40], valueEncoding: DOC_VALUE_ENCODING },
        ]),
      ).toEqual(obs.cursorStartAfterEndAtValuesIds);
      expect(
        await queryIds([
          descScore,
          { kind: 'startAfter', values: [40], valueEncoding: DOC_VALUE_ENCODING },
          { kind: 'endBefore', values: [10], valueEncoding: DOC_VALUE_ENCODING },
        ]),
      ).toEqual(obs.cursorDescStartAfterEndBeforeValuesIds);

      expect(
        await queryIds([
          ascScore,
          docCursorConstraint('startAt', 20, `${colPath}/d2`),
          docCursorConstraint('endAt', 40, `${colPath}/d4`),
        ]),
      ).toEqual(obs.cursorStartAtEndAtDocSnapshotIds);
      expect(
        await queryIds([
          ascScore,
          docCursorConstraint('startAfter', 20, `${colPath}/d2`),
          docCursorConstraint('endBefore', 40, `${colPath}/d4`),
        ]),
      ).toEqual(obs.cursorStartAfterEndBeforeDocSnapshotIds);
      expect(
        await queryIds([
          descScore,
          docCursorConstraint('startAt', 40, `${colPath}/d4`),
          docCursorConstraint('endAt', 20, `${colPath}/d2`),
        ]),
      ).toEqual(obs.cursorDescStartAtEndAtDocSnapshotIds);

      const retryPath = `pyric_oracle/${runId}/tx_wave5/retry_counter`;
      const deleteTargetPath = `pyric_oracle/${runId}/tx_wave5/delete_in_tx`;
      expect(
        (await harness.sendOp({ method: 'setDoc', path: retryPath, data: { counter: 0 }, actAs }))
          .ok,
      ).toBe(true);
      expect(
        (
          await harness.sendOp({
            method: 'setDoc',
            path: deleteTargetPath,
            data: { ephemeral: true },
            actAs,
          })
        ).ok,
      ).toBe(true);

      const observedCounters: number[] = [];
      let committedReturn = -1;
      let attemptsUsed = 0;
      const maxAttempts = 3;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        attemptsUsed = attempt;
        const txnId = `kt-w5-txn-${attempt}`;
        const readSnap = parseWireDoc(
          await harness.sendOp({ method: 'getDoc', path: retryPath, txnId, actAs }),
        );
        let currentCounter = 0;
        if (readSnap.fields !== null && typeof readSnap.fields['counter'] === 'number') {
          currentCounter = readSnap.fields['counter'];
        }
        observedCounters.push(currentCounter);
        if (attempt === 1) {
          expect(
            (
              await harness.sendOp({
                method: 'updateDoc',
                path: retryPath,
                data: { counter: 40 },
                actAs,
              })
            ).ok,
          ).toBe(true);
        }
        const nextCounter = currentCounter + 2;
        const commitRes = await harness.sendOp({
          method: 'txnCommit',
          txnId,
          reads: [{ path: retryPath, data: readSnap.snap.data }],
          writes: [
            { method: 'update', path: retryPath, data: { counter: nextCounter } },
            { method: 'delete', path: deleteTargetPath },
          ],
          actAs,
        });
        if (commitRes.ok) {
          committedReturn = nextCounter;
          break;
        }
        let commitCode = '';
        if (commitRes.error !== undefined) {
          commitCode = commitRes.error.code;
        }
        expect(commitCode).toBe('aborted');
      }

      expect(attemptsUsed).toBe(obs.txRetryAttempts);
      expect(observedCounters).toEqual(obs.txRetryObservedCounters);
      expect(committedReturn).toBe(obs.txRetryReturnCounter);

      const afterRetry = parseWireDoc(
        await harness.sendOp({ method: 'getDoc', path: retryPath, actAs }),
      );
      let finalCounter = -1;
      if (afterRetry.fields !== null && typeof afterRetry.fields['counter'] === 'number') {
        finalCounter = afterRetry.fields['counter'];
      }
      expect(finalCounter).toBe(obs.txRetryFinalCounter);

      const afterDeleteTarget = parseWireDoc(
        await harness.sendOp({ method: 'getDoc', path: deleteTargetPath, actAs }),
      );
      expect(afterDeleteTarget.snap.exists).toBe(obs.txDeletedTargetExistsAfterCommit);
    } finally {
      await harness.close();
    }
  });

  test('covers both Wave 5 firestore-kotlin observations through createObservationGate', () => {
    const report = gate.report();
    expect(report.committed).toEqual([INEQUALITY_CG_TX_STEM, INSTANCE_FLOWS_STEM]);
    expect(report.loadedButUnused).toEqual([]);
    expect(report.uncovered).toEqual([]);
  });
});
