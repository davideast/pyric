import { expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DOC_VALUE_ENCODING,
  openAuthenticatedSwiftFirestoreBridge,
  parseWireDoc,
  requireWireFields,
  SWIFT_FIRESTORE_ROOT,
  type HostedFirestoreRulesBridge,
  type WireDocSnap,
} from './firestore-swift-oracle-replay-harness.ts';

export interface FirestoreSwiftWave5InstanceCodableObservation {
  appliedMemoryCacheSettings: boolean;
  asyncDocSnapshotId: string;
  asyncQuerySnapshotIds: string[];
  codableDecodedDocumentId: string;
  codableDecodedHasTimestamp: boolean;
  codableDecodedLabel: string;
  codableDecodedPoints: number;
  codableMergedActive: boolean;
  codableMergedLabel: string;
  codableMergedPoints: number;
  codableOmittedDocumentIdField: boolean;
  codableServerTimestampResolved: boolean;
  dataWithEstimateHasStamped: boolean;
  defaultFirestoreAppIsDefault: boolean;
  defaultFirestoreIdentical: boolean;
  defaultSettingsHost: string;
  docListenerObservedLabels: string[];
  docParentCollectionId: string;
  docPathSuffixMatches: boolean;
  emptyBundleSucceeded: boolean;
  emptyQueryCount: number;
  emptyQueryIsEmpty: boolean;
  emulatorHostApplied: boolean;
  generatedDocIdLength: number;
  getByFieldPathTag: string;
  getByStringLabel: string;
  inSyncFired: boolean;
  malformedBundleRejected: boolean;
  missingNamedQueryIsNil: boolean;
  namedFirestoreAppMatches: boolean;
  namedFirestoreIdentical: boolean;
  nonEmptyQueryCount: number;
  nonEmptyQueryIsEmpty: boolean;
  optionsListenerObservedMetadata: boolean;
  queryOptionsObservedChanges: boolean;
  silentAfterListenerRemove: boolean;
  snapshotRefMatchesPath: boolean;
  subColParentMatchesDoc: boolean;
  subscriptLabel: string;
  topColParentMatchesRunDoc: boolean;
  updateMissingMatchesNotFound: boolean;
  vectorRoundTrip: number[];
}

export interface FirestoreSwiftWave5InequalityCgTxObservation {
  abortDocPersistedContenderValue: number;
  arrayContainsAnyIds: string[];
  batchMergeAddedFlag: boolean;
  batchMergeFieldsOmittedUnlisted: boolean;
  batchMergeFieldsUpdatedSelected: boolean;
  batchMergePreservedBase: boolean;
  collectionGroupDocIds: string[];
  collectionGroupParentIds: string[];
  defaultMaxAttempts: number;
  greaterThanIds: string[];
  greaterThanOrEqualIds: string[];
  lessThanIds: string[];
  lessThanOrEqualIds: string[];
  maxAttemptsExhaustedCode: number;
  maxAttemptsExhaustedDomain: string;
  maxAttemptsExhaustedRejected: boolean;
  notEqualIds: string[];
  notInIds: string[];
  retryAttemptsOnSingleConflict: number;
  retryFinalCounter: number;
  singleAttemptRunsBeforeFailure: number;
  startAfterDocEndBeforeDocIds: string[];
  startAfterEndAtIds: string[];
  startAtDocEndAtDocIds: string[];
  startAtEndBeforeIds: string[];
  txDeleteRemovedTarget: boolean;
  txSetAndMergeSucceeded: boolean;
  unscopedCollectionGroupDenied: boolean;
}

export const SWIFT_INSTANCE_CODABLE_STEM = 'firestore-swift-instance-snapshots-inSync-and-codable';
export const SWIFT_INEQUALITY_CG_TX_STEM =
  'firestore-swift-inequality-cursors-collectionGroup-and-txRetry';

export const SWIFT_WAVE5_FILENAMES = new Set([
  `${SWIFT_INSTANCE_CODABLE_STEM}.json`,
  `${SWIFT_INEQUALITY_CG_TX_STEM}.json`,
]);

export function swiftDocCursorConstraint(
  kind: 'startAt' | 'startAfter' | 'endAt' | 'endBefore',
  score: number,
  docPath: string,
): Record<string, unknown> {
  return {
    kind,
    values: [score, { __type: 'reference', path: docPath }],
    fromSnapshot: true,
    valueEncoding: DOC_VALUE_ENCODING,
  };
}

export async function seedSwiftWave5QueriesCollection(
  harness: HostedFirestoreRulesBridge,
  colPath: string,
): Promise<void> {
  const res = await harness.sendOp({
    method: 'batchCommit',
    writes: [
      { method: 'set', path: `${colPath}/d1`, data: { score: 10, tier: 'free', tags: ['a'] } },
      { method: 'set', path: `${colPath}/d2`, data: { score: 20, tier: 'pro', tags: ['b'] } },
      { method: 'set', path: `${colPath}/d3`, data: { score: 30, tier: 'pro', tags: ['c'] } },
      {
        method: 'set',
        path: `${colPath}/d4`,
        data: { score: 40, tier: 'enterprise', tags: ['a', 'd'] },
      },
    ],
    actAs: harness.actAs,
  });
  expect(res.ok).toBe(true);
}

export function verifySwiftInstanceSettingsBundleAndCodableInvariants(
  obs: FirestoreSwiftWave5InstanceCodableObservation,
): void {
  const firestoreSwift = readFileSync(
    join(SWIFT_FIRESTORE_ROOT, 'Public', 'Firestore.swift'),
    'utf8',
  );
  const settingsSwift = readFileSync(
    join(SWIFT_FIRESTORE_ROOT, 'Public', 'FirestoreSettings.swift'),
    'utf8',
  );
  const bundleSwift = readFileSync(
    join(SWIFT_FIRESTORE_ROOT, 'Public', 'LoadBundleTask.swift'),
    'utf8',
  );
  const codableSwift = readFileSync(join(SWIFT_FIRESTORE_ROOT, 'Public', 'Codable.swift'), 'utf8');
  const colRefSwift = readFileSync(
    join(SWIFT_FIRESTORE_ROOT, 'Public', 'CollectionReference.swift'),
    'utf8',
  );
  const docRefSwift = readFileSync(
    join(SWIFT_FIRESTORE_ROOT, 'Public', 'DocumentReference.swift'),
    'utf8',
  );
  const queryListenersSwift = readFileSync(
    join(SWIFT_FIRESTORE_ROOT, 'Public', 'Query+Listeners.swift'),
    'utf8',
  );

  expect(obs.defaultFirestoreIdentical).toBe(true);
  expect(obs.defaultFirestoreAppIsDefault).toBe(true);
  expect(obs.namedFirestoreIdentical).toBe(true);
  expect(obs.namedFirestoreAppMatches).toBe(true);
  expect(firestoreSwift).toContain('public static func firestore() -> Firestore');
  expect(firestoreSwift).toContain('public static func firestore(app: FirebaseApp) -> Firestore');
  expect(firestoreSwift).toContain('public let app: FirebaseApp');

  // Production FirebaseFirestore defaults host to firestore.googleapis.com; PyricFirestore
  // configures local bridge defaults while supporting custom host, sslEnabled, and MemoryCacheSettings.
  expect(obs.defaultSettingsHost).toBe('firestore.googleapis.com');
  expect(obs.appliedMemoryCacheSettings).toBe(true);
  expect(obs.emulatorHostApplied).toBe(true);
  expect(settingsSwift).toContain('public struct MemoryCacheSettings: LocalCacheSettings');
  expect(settingsSwift).toContain('public struct SnapshotListenOptions: Sendable, Equatable');
  expect(firestoreSwift).toContain('public func useEmulator(withHost host: String, port: Int)');
  expect(firestoreSwift).toContain('settings.host = "\\(host):\\(port)"');
  expect(firestoreSwift).toContain('public func addSnapshotsInSyncListener(');

  expect(obs.generatedDocIdLength).toBe(20);
  expect(obs.docPathSuffixMatches).toBe(true);
  expect(obs.docParentCollectionId).toBe('wave5_items');
  expect(obs.subColParentMatchesDoc).toBe(true);
  expect(obs.topColParentMatchesRunDoc).toBe(true);
  expect(colRefSwift).toContain('public var parent: DocumentReference?');
  expect(colRefSwift).toContain('public func document() -> DocumentReference');
  expect(docRefSwift).toContain('public var parent: CollectionReference');
  expect(docRefSwift).toContain('public var snapshots: AsyncThrowingStream<DocumentSnapshot, Error>');
  expect(queryListenersSwift).toContain(
    'public var snapshots: AsyncThrowingStream<QuerySnapshot, Error>',
  );

  expect(obs.emptyBundleSucceeded).toBe(true);
  expect(obs.malformedBundleRejected).toBe(true);
  expect(obs.missingNamedQueryIsNil).toBe(true);
  expect(bundleSwift).toContain('public func loadBundle(_ bundleData: Data)');
  expect(bundleSwift).toContain('public func getQuery(named name: String)');

  expect(codableSwift).toContain('public struct DocumentID<Value: Sendable & Equatable>');
  expect(codableSwift).toContain('public struct ServerTimestamp<Value: Codable & Sendable & Equatable>');
  expect(codableSwift).toContain('public func data<T: Decodable>(');
}

export async function verifySwiftCollectionGroupAndTxContention(
  obs: FirestoreSwiftWave5InequalityCgTxObservation,
): Promise<void> {
  const txSwift = readFileSync(join(SWIFT_FIRESTORE_ROOT, 'Public', 'Transaction.swift'), 'utf8');
  const fsTxSwift = readFileSync(
    join(SWIFT_FIRESTORE_ROOT, 'Public', 'Firestore+Transactions.swift'),
    'utf8',
  );
  const exceptionsSwift = readFileSync(
    join(SWIFT_FIRESTORE_ROOT, 'Transport', 'Exceptions.swift'),
    'utf8',
  );
  expect(obs.defaultMaxAttempts).toBe(5);
  expect(txSwift).toContain('public init(maxAttempts: Int = 5)');
  expect(txSwift).toContain('public func getDocument(_ document: DocumentReference) throws -> DocumentSnapshot');
  expect(fsTxSwift).toContain('with options: TransactionOptions?');
  expect(fsTxSwift).toContain('code: .failedPrecondition');
  expect(exceptionsSwift).toContain('public let FirestoreErrorDomain = "FIRFirestoreErrorDomain"');
  expect(exceptionsSwift).toContain('case .failedPrecondition: return 9');

  const runId = 'replay_swift_w5_cg_tx';
  const cgId = `cg_${runId}`;
  const extraRules = `    match /{path=**}/${cgId}/{docId} {
      allow read, write: if request.auth != null;
    }`;
  const harness = await openAuthenticatedSwiftFirestoreBridge(
    `demo-swift-fs-cg-${String(Date.now())}`,
    runId,
    'swift-fs-cg-uid',
    extraRules,
  );

  try {
    const { actAs } = harness;
    const cgDocAPath = `pyric_oracle/${runId}/cg_parents/p1/${cgId}/item_a`;
    const cgDocBPath = `pyric_oracle/${runId}/cg_parents/p2/${cgId}/item_b`;
    expect(
      (await harness.sendOp({ method: 'setDoc', path: cgDocAPath, data: { slot: 'first' }, actAs }))
        .ok,
    ).toBe(true);
    expect(
      (await harness.sendOp({ method: 'setDoc', path: cgDocBPath, data: { slot: 'second' }, actAs }))
        .ok,
    ).toBe(true);

    const cgRes = await harness.sendOp({
      method: 'getDocs',
      source: { __ref: 'group', collectionId: cgId },
      actAs,
    });
    expect(cgRes.ok).toBe(true);
    const cgDocs = (cgRes.value as { docs: WireDocSnap[] }).docs;
    const cgDocIds = cgDocs.map((d) => d.id).sort();
    const cgParentIds = cgDocs
      .map((d) => {
        const segs = d.path.split('/');
        const parentSeg = segs[segs.length - 3];
        if (parentSeg === undefined) {
          return '';
        }
        return parentSeg;
      })
      .sort();
    expect(cgDocIds).toEqual(obs.collectionGroupDocIds);
    expect(cgParentIds).toEqual(obs.collectionGroupParentIds);

    const unscopedRes = await harness.sendOp({
      method: 'getDocs',
      source: { __ref: 'group', collectionId: `cg_unscoped_${runId}` },
      actAs,
    });
    let unscopedDenied = false;
    if (!unscopedRes.ok && unscopedRes.error !== undefined) {
      unscopedDenied = unscopedRes.error.code === 'permission-denied';
    }
    expect(unscopedDenied).toBe(obs.unscopedCollectionGroupDenied);

    const retryPath = `pyric_oracle/${runId}/wave5_queries/tx_retry_doc`;
    expect(
      (await harness.sendOp({ method: 'setDoc', path: retryPath, data: { counter: 1 }, actAs })).ok,
    ).toBe(true);

    let retryAttempts = 0;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      retryAttempts = attempt;
      const txnId = `swift-w5-retry-${String(attempt)}`;
      const readSnap = parseWireDoc(
        await harness.sendOp({ method: 'getDoc', path: retryPath, txnId, actAs }),
      );
      if (attempt === 1) {
        expect(
          (await harness.sendOp({ method: 'setDoc', path: retryPath, data: { counter: 2 }, actAs }))
            .ok,
        ).toBe(true);
      }
      const curFields = requireWireFields(readSnap, 'tx_retry_doc');
      const curVal = curFields['counter'] as number;
      const commitRes = await harness.sendOp({
        method: 'txnCommit',
        txnId,
        reads: [{ path: retryPath, data: readSnap.snap.data }],
        writes: [{ method: 'update', path: retryPath, data: { counter: curVal + 10 } }],
        actAs,
      });
      if (commitRes.ok) {
        break;
      }
      if (commitRes.error === undefined) {
        throw new Error('Expected txnCommit conflict error');
      }
      expect(commitRes.error.code).toBe('aborted');
    }
    const retryFinal = parseWireDoc(await harness.sendOp({ method: 'getDoc', path: retryPath, actAs }));
    expect(retryAttempts).toBe(obs.retryAttemptsOnSingleConflict);
    expect(requireWireFields(retryFinal, 'retryFinal')['counter']).toBe(obs.retryFinalCounter);

    const abortPath = `pyric_oracle/${runId}/wave5_queries/tx_abort_doc`;
    expect(
      (await harness.sendOp({ method: 'setDoc', path: abortPath, data: { counter: 1 }, actAs })).ok,
    ).toBe(true);

    let singleRuns = 0;
    let exhaustedRejected = false;
    for (let attempt = 1; attempt <= 1; attempt += 1) {
      singleRuns += 1;
      const txnId = `swift-w5-exhaust-${String(attempt)}`;
      const readSnap = parseWireDoc(
        await harness.sendOp({ method: 'getDoc', path: abortPath, txnId, actAs }),
      );
      expect(
        (await harness.sendOp({ method: 'setDoc', path: abortPath, data: { counter: 50 }, actAs }))
          .ok,
      ).toBe(true);
      const commitRes = await harness.sendOp({
        method: 'txnCommit',
        txnId,
        reads: [{ path: abortPath, data: readSnap.snap.data }],
        writes: [{ method: 'update', path: abortPath, data: { counter: 999 } }],
        actAs,
      });
      if (!commitRes.ok) {
        exhaustedRejected = true;
        if (commitRes.error === undefined) {
          throw new Error('Expected exhausted txnCommit error');
        }
        expect(commitRes.error.code).toBe('aborted');
      }
    }
    const abortFinal = parseWireDoc(await harness.sendOp({ method: 'getDoc', path: abortPath, actAs }));
    expect(singleRuns).toBe(obs.singleAttemptRunsBeforeFailure);
    expect(exhaustedRejected).toBe(obs.maxAttemptsExhaustedRejected);
    expect(obs.maxAttemptsExhaustedDomain).toBe('FIRFirestoreErrorDomain');
    expect(obs.maxAttemptsExhaustedCode).toBe(9);
    expect(requireWireFields(abortFinal, 'abortFinal')['counter']).toBe(
      obs.abortDocPersistedContenderValue,
    );
  } finally {
    await harness.close();
  }
}
