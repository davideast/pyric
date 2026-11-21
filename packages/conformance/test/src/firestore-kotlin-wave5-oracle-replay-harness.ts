import { expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createMemoryBackend } from 'pyric/sandbox';
import { mintCustomToken } from 'pyric/sandbox/internal';
import type {
  BridgeMessage,
  WorkerOpFrame,
  WorkerResFrame,
} from '../../../cli/dist/bridge/protocol.js';
import { createHostedRuntime } from '../../../cli/dist/serve/hosted/runtime.js';
import { REPO_ROOT } from '../../src/ledger.ts';
import {
  DOC_VALUE_ENCODING,
  KT_MAIN_ROOT,
  parseWireDoc,
  type HostedFirestoreRulesBridge,
  type WireDocSnap,
} from './firestore-kotlin-oracle-replay-harness.ts';

export interface FirestoreKotlinWave5InstanceFlowsObservation {
  defaultInstanceSameAsKtx: boolean;
  defaultInstanceAppName: string;
  namedInstanceSameAsKtx: boolean;
  defaultAndNamedInstancesDistinct: boolean;
  settingsDefaultHost: string;
  settingsDefaultSslEnabled: boolean;
  settingsPersistentCacheConfigured: boolean;
  settingsPersistentCacheSizeBytes: number;
  settingsCustomHost: string;
  settingsCustomSslEnabled: boolean;
  settingsMemoryCacheConfigured: boolean;
  settingsReconfigureAfterStartThrowsIllegalState: boolean;
  directDocEqualsCollectionChain: boolean;
  directDocId: string;
  directDocParentId: string;
  directDocOddSegmentsThrowsIllegalArgument: boolean;
  updateMapPreservedHandle: string;
  updateMapUpdatedLevel: number;
  updateMapNestedReviews: number;
  updateMapPreservedCommits: number;
  updateMapDeletedFieldPresent: boolean;
  updateMissingDocErrorCodeName: string;
  updateMissingDocErrorCodeValue: number;
  toObjectDocumentId: string;
  toObjectHandle: string;
  toObjectLevel: number;
  toObjectScore: number;
  toObjectActive: boolean;
  toObjectTags: string[];
  toObjectNestedBadgeCode: string;
  toObjectNestedBadgeTier: number;
  toObjectClassMatchesReified: boolean;
  toObjectMissingDocReturnsNull: boolean;
  inSyncFiredOnAttach: boolean;
  inSyncFiredAfterWrite: boolean;
  inSyncQuietAfterRemove: boolean;
  docSnapshotsExcludeStages: string[];
  docSnapshotsIncludeObservedPendingAndSynced: boolean;
  docSnapshotsQuietAfterCancel: boolean;
  querySnapshotsEmissionHistory: string[][];
  querySnapshotsLatestToObjects: string[];
  querySnapshotsQuietAfterCancel: boolean;
}

export interface FirestoreKotlinWave5InequalityCgTxObservation {
  whereNotEqualToTierIds: string[];
  whereNotEqualToScoreIds: string[];
  whereLessThanIds: string[];
  whereLessThanOrEqualToIds: string[];
  whereGreaterThanIds: string[];
  whereGreaterThanOrEqualToIds: string[];
  openRangeDescIds: string[];
  whereNotInTierIds: string[];
  whereNotInScoreIds: string[];
  cursorStartAtValuesLimit2Ids: string[];
  cursorStartAfterEndAtValuesIds: string[];
  cursorDescStartAfterEndBeforeValuesIds: string[];
  cursorStartAtEndAtDocSnapshotIds: string[];
  cursorStartAfterEndBeforeDocSnapshotIds: string[];
  cursorDescStartAtEndAtDocSnapshotIds: string[];
  collectionGroupEmptyThrowsIllegalArgument: boolean;
  collectionGroupSlashThrowsIllegalArgument: boolean;
  collectionGroupIdsSorted: string[];
  collectionGroupRedactedPathsSorted: string[];
  collectionGroupUnscopedDeniedCodeName: string;
  txInvalidMaxAttemptsThrowsIllegalArgument: boolean;
  txRetryAttempts: number;
  txRetryObservedCounters: number[];
  txRetryReturnCounter: number;
  txRetryFinalCounter: number;
  txDeletedTargetExistsAfterCommit: boolean;
  txExhaustedMaxAttempts: number;
  txExhaustedAttempts: number;
  txExhaustedThrew: boolean;
  txExhaustedErrorCodeName: string;
  txExhaustedErrorCodeValue: number;
  txExhaustedFinalCounter: number;
}

export const INSTANCE_FLOWS_STEM = 'firestore-kotlin-instance-flows-inSync-and-toObject';
export const INEQUALITY_CG_TX_STEM =
  'firestore-kotlin-inequality-cursors-collectionGroup-and-txRetry';

export const WAVE5_FILENAMES = new Set([
  `${INSTANCE_FLOWS_STEM}.json`,
  `${INEQUALITY_CG_TX_STEM}.json`,
]);

export function waitUntilCondition(
  label: string,
  predicate: () => boolean,
  timeoutMs = 3_000,
): Promise<void> {
  if (predicate()) {
    return Promise.resolve();
  }
  return new Promise<void>((resolveWait, rejectWait) => {
    const started = Date.now();
    const interval = setInterval(() => {
      if (predicate()) {
        clearInterval(interval);
        resolveWait();
        return;
      }
      if (Date.now() - started >= timeoutMs) {
        clearInterval(interval);
        rejectWait(new Error(`Timed out waiting for Wave 5 replay condition '${label}'`));
      }
    }, 15);
  });
}

export function docCursorConstraint(
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

export async function seedWave5ScoreCollection(
  harness: HostedFirestoreRulesBridge,
  colPath: string,
): Promise<void> {
  const entries = [
    { id: 'd1', tier: 'bronze', score: 10 },
    { id: 'd2', tier: 'silver', score: 20 },
    { id: 'd3', tier: 'gold', score: 30 },
    { id: 'd4', tier: 'platinum', score: 40 },
    { id: 'd5', tier: 'diamond', score: 50 },
  ];
  const writes = entries.map((entry) => ({
    method: 'set',
    path: `${colPath}/${entry.id}`,
    data: { tier: entry.tier, score: entry.score },
  }));
  const batchRes = await harness.sendOp({
    method: 'batchCommit',
    writes,
    actAs: harness.actAs,
  });
  expect(batchRes.ok).toBe(true);
}

const CG_CLIENT_SESSION_ID = 'kt-firestore-wave5-cg-replay-client';

function makeCollectionGroupMemoryPersistence() {
  const storageStub = {
    scoped: () => storageStub,
    reset: async () => {},
    close: async () => {},
    objectFile: async () => undefined,
    uploadProgress: async () => undefined,
    appendUpload: async () => ({ received: 0, size: 0 }),
  };
  return {
    backend: createMemoryBackend(),
    storage: storageStub,
    checkpoints: {},
    state: { seed: async () => false },
    repairedObjects: [],
    sweep: Promise.resolve({ removed: 0, bytesRemoved: 0 }),
    close() {},
    status: () => ({ state: 'healthy' as const }),
    onFailure: () => () => {},
    markUnhealthy() {},
  };
}

async function openCollectionGroupFirestoreBridge(
  projectId: string,
  runId: string,
  uid: string,
): Promise<{
  readonly actAs: { readonly mode: 'as'; readonly uid: string };
  sendOp(op: Record<string, unknown>): Promise<WorkerResFrame>;
  close(): Promise<void>;
}> {
  const pendingReplies = new Map<string, (frame: WorkerResFrame) => void>();
  const pendingTimers = new Set<ReturnType<typeof setTimeout>>();
  const persistence = makeCollectionGroupMemoryPersistence();
  const cgId = `cg_${runId}`;
  const firestoreRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /pyric_oracle/${runId}/{document=**} {
      allow read, write: if request.auth != null;
    }
    match /{path=**}/${cgId}/{docId} {
      allow read, write: if request.auth != null;
    }
  }
}`;

  const runtime = await createHostedRuntime(
    {
      rules: firestoreRules,
      rulesHash: null,
      databaseRules: { rules: { '.read': false, '.write': false } },
      databaseRulesHash: null,
      databaseInstances: {
        defaultInstance: `${projectId}-default-rtdb`,
        projectId,
        rules: {},
      },
      storageRules: null,
      storageRulesHash: null,
      bridgeUrl: '/__pyric/sandbox',
      seed: null,
      capture: false,
      hosted: true,
      permissive: false,
      projectKey: projectId,
      sessionToken: `tok-${projectId}`,
    },
    'http://127.0.0.1:4400',
    (frame: BridgeMessage) => {
      if (frame.type === 'worker-res') {
        const resolver = pendingReplies.get(frame.id);
        if (resolver !== undefined) {
          pendingReplies.delete(frame.id);
          resolver(frame);
        }
      }
    },
    REPO_ROOT,
    { persistence: persistence as never, record: false },
  );

  let seq = 0;
  const sendOp = (op: Record<string, unknown>): Promise<WorkerResFrame> => {
    seq += 1;
    const id = `kt-fs-cg-op-${seq}`;
    return new Promise<WorkerResFrame>((resolveReply, rejectReply) => {
      const timer = setTimeout(() => {
        pendingTimers.delete(timer);
        pendingReplies.delete(id);
        rejectReply(new Error(`Hosted Firestore CG worker-op '${id}' timed out`));
      }, 5_000);
      pendingTimers.add(timer);
      pendingReplies.set(id, (frame) => {
        clearTimeout(timer);
        pendingTimers.delete(timer);
        resolveReply(frame);
      });
      runtime.receive({
        type: 'worker-op',
        id,
        clientSessionId: CG_CLIENT_SESSION_ID,
        op: op as unknown as WorkerOpFrame['op'],
      });
    });
  };

  const close = async (): Promise<void> => {
    for (const timer of pendingTimers) {
      clearTimeout(timer);
    }
    pendingTimers.clear();
    pendingReplies.clear();
    await runtime.close();
  };

  try {
    const customToken = mintCustomToken({ uid, projectId, nowMs: Date.now() });
    const signInRes = await sendOp({ method: 'auth.signInWithCustomToken', customToken });
    if (!signInRes.ok) {
      throw new Error(`Custom token sign-in failed: ${JSON.stringify(signInRes.error)}`);
    }
  } catch (err) {
    await close();
    throw err;
  }

  return {
    actAs: { mode: 'as', uid },
    sendOp,
    close,
  };
}

export async function verifyWave5SettingsCollectionGroupAndTxExhaustion(
  obsInst: FirestoreKotlinWave5InstanceFlowsObservation,
  obsCgTx: FirestoreKotlinWave5InequalityCgTxObservation,
): Promise<void> {
  const settingsKt = readFileSync(
    join(KT_MAIN_ROOT, 'com', 'google', 'firebase', 'firestore', 'FirebaseFirestoreSettings.kt'),
    'utf8',
  );
  const localCacheKt = readFileSync(
    join(KT_MAIN_ROOT, 'com', 'google', 'firebase', 'firestore', 'LocalCacheSettings.kt'),
    'utf8',
  );
  const ktxKt = readFileSync(
    join(KT_MAIN_ROOT, 'com', 'google', 'firebase', 'firestore', 'Firestore.kt'),
    'utf8',
  );
  const firestoreKt = readFileSync(
    join(KT_MAIN_ROOT, 'com', 'google', 'firebase', 'firestore', 'FirebaseFirestore.kt'),
    'utf8',
  );
  const exceptionKt = readFileSync(
    join(KT_MAIN_ROOT, 'com', 'google', 'firebase', 'firestore', 'FirebaseFirestoreException.kt'),
    'utf8',
  );

  // firestore-kotlin#3: FirebaseFirestoreSettings defaults, LocalCacheSettings, KTX DSL, and post-start immutability
  expect(obsInst.settingsDefaultHost).toBe('firestore.googleapis.com');
  expect(obsInst.settingsDefaultSslEnabled).toBe(true);
  expect(obsInst.settingsPersistentCacheConfigured).toBe(true);
  expect(obsInst.settingsPersistentCacheSizeBytes).toBe(20971520);
  expect(obsInst.settingsCustomHost).toBe('127.0.0.1:8085');
  expect(obsInst.settingsCustomSslEnabled).toBe(false);
  expect(obsInst.settingsMemoryCacheConfigured).toBe(true);
  expect(obsInst.settingsReconfigureAfterStartThrowsIllegalState).toBe(true);

  expect(settingsKt).toContain(`const val DEFAULT_HOST: String = "${obsInst.settingsDefaultHost}"`);
  expect(settingsKt).toContain('private var sslEnabledField: Boolean = true');
  expect(settingsKt).toContain('val cacheSettings: LocalCacheSettings?');
  expect(localCacheKt).toContain('class PersistentCacheSettings');
  expect(localCacheKt).toContain('class MemoryCacheSettings');
  expect(ktxKt).toContain('fun memoryCacheSettings(');
  expect(ktxKt).toContain('fun persistentCacheSettings(');

  // firestore-kotlin#6: collectionGroup("") allowed, '/' rejected, scoped multi-depth getDocs + unscoped PERMISSION_DENIED
  expect(obsCgTx.collectionGroupEmptyThrowsIllegalArgument).toBe(false);
  expect(obsCgTx.collectionGroupSlashThrowsIllegalArgument).toBe(true);
  expect(firestoreKt).toContain("require(!collectionId.contains('/'))");
  expect(firestoreKt).not.toContain('Provided collection ID must not be empty');

  // firestore-kotlin#53: exhausted maxAttempts=1 contention maps ABORTED -> FAILED_PRECONDITION (code 9)
  expect(obsCgTx.txExhaustedMaxAttempts).toBe(1);
  expect(obsCgTx.txExhaustedAttempts).toBe(1);
  expect(obsCgTx.txExhaustedThrew).toBe(true);
  expect(obsCgTx.txExhaustedErrorCodeName).toBe('FAILED_PRECONDITION');
  expect(obsCgTx.txExhaustedErrorCodeValue).toBe(9);
  expect(firestoreKt).toContain('exhaustedOnCommitContention = true');
  expect(firestoreKt).toContain('code = FirebaseFirestoreException.Code.FAILED_PRECONDITION');
  expect(exceptionKt).toContain(
    `${obsCgTx.txExhaustedErrorCodeName}(${String(obsCgTx.txExhaustedErrorCodeValue)})`,
  );

  const runId = 'replay_wave5_cg_tx53';
  const cgId = `cg_${runId}`;
  const harness = await openCollectionGroupFirestoreBridge(
    `demo-kt-fs-w5-cg-${Date.now()}`,
    runId,
    'android-fs-w5-cg-uid',
  );
  try {
    const { actAs } = harness;
    const seededPaths = [
      `${cgId}/cg_root`,
      `pyric_oracle/${runId}/orgs/org_a/${cgId}/cg_org_a`,
      `pyric_oracle/${runId}/orgs/org_b/teams/team_x/${cgId}/cg_team_x`,
    ];
    for (const docPath of seededPaths) {
      const writeRes = await harness.sendOp({
        method: 'setDoc',
        path: docPath,
        data: { marker: runId },
        actAs,
      });
      expect(writeRes.ok).toBe(true);
    }

    const cgRes = await harness.sendOp({
      method: 'getDocs',
      source: { __ref: 'group', collectionId: cgId },
      actAs,
    });
    expect(cgRes.ok).toBe(true);
    const cgDocs = (cgRes.value as { docs: WireDocSnap[] }).docs;
    const sortedIds = cgDocs.map((d) => d.id).sort();
    const redactedPaths = cgDocs.map((d) => d.path.replaceAll(runId, '<run>')).sort();
    expect(sortedIds).toEqual(obsCgTx.collectionGroupIdsSorted);
    expect(redactedPaths).toEqual(obsCgTx.collectionGroupRedactedPathsSorted);

    const unscopedRes = await harness.sendOp({
      method: 'getDocs',
      source: { __ref: 'group', collectionId: `unscoped_${runId}` },
      actAs,
    });
    expect(unscopedRes.ok).toBe(false);
    let unscopedCode = '';
    if (unscopedRes.error !== undefined) {
      unscopedCode = unscopedRes.error.code;
    }
    expect(unscopedCode.replace(/^firestore\//, '').toUpperCase().replace(/-/g, '_')).toBe(
      obsCgTx.collectionGroupUnscopedDeniedCodeName,
    );

    const exhaustPath = `pyric_oracle/${runId}/tx_wave5/exhaust_counter`;
    expect(
      (await harness.sendOp({ method: 'setDoc', path: exhaustPath, data: { counter: 0 }, actAs }))
        .ok,
    ).toBe(true);

    let exhaustedAttempts = 0;
    let exhaustedWireCode = '';
    for (let attempt = 1; attempt <= obsCgTx.txExhaustedMaxAttempts; attempt += 1) {
      exhaustedAttempts = attempt;
      const txnId = `kt-w5-exhaust-${String(attempt)}`;
      const readSnap = parseWireDoc(
        await harness.sendOp({ method: 'getDoc', path: exhaustPath, txnId, actAs }),
      );
      expect(
        (
          await harness.sendOp({
            method: 'updateDoc',
            path: exhaustPath,
            data: { counter: 99 },
            actAs,
          })
        ).ok,
      ).toBe(true);
      const commitRes = await harness.sendOp({
        method: 'txnCommit',
        txnId,
        reads: [{ path: exhaustPath, data: readSnap.snap.data }],
        writes: [{ method: 'update', path: exhaustPath, data: { counter: 1 } }],
        actAs,
      });
      expect(commitRes.ok).toBe(false);
      if (commitRes.error !== undefined) {
        exhaustedWireCode = commitRes.error.code;
      }
    }
    expect(exhaustedAttempts).toBe(obsCgTx.txExhaustedAttempts);
    expect(exhaustedWireCode).toBe('aborted');

    const finalRead = parseWireDoc(
      await harness.sendOp({ method: 'getDoc', path: exhaustPath, actAs }),
    );
    let storedFinalCounter = -1;
    if (finalRead.fields !== null && typeof finalRead.fields['counter'] === 'number') {
      storedFinalCounter = finalRead.fields['counter'];
    }
    expect(storedFinalCounter).toBe(obsCgTx.txExhaustedFinalCounter);
  } finally {
    await harness.close();
  }
}
