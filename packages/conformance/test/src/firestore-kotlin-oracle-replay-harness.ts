import { createMemoryBackend } from 'pyric/sandbox';
import { mintCustomToken } from 'pyric/sandbox/internal';
import { join } from 'node:path';
import type {
  BridgeMessage,
  WorkerOpFrame,
  WorkerResFrame,
  WorkerSubFrame,
} from '../../../cli/dist/bridge/protocol.js';
import { createHostedRuntime } from '../../../cli/dist/serve/hosted/runtime.js';
import { REPO_ROOT } from '../../src/ledger.ts';

export interface FirestoreKotlinCrudCodecsObservation {
  autoDocumentIdLength: number;
  collectionAddIdLength: number;
  collectionAddExistsBeforeDelete: boolean;
  collectionAddExistsAfterDelete: boolean;
  missingDocExists: boolean;
  missingDocDataIsNull: boolean;
  serverReadIsFromCache: boolean;
  serverReadHasPendingWrites: boolean;
  cacheReadIsFromCache: boolean;
  titleAfterMergeFields: string;
  ignoredFieldPresent: boolean;
  mergedFlag: boolean;
  nestedKeptValue: string;
  nestedReplacedPreserved: string;
  nestedIgnoredPresent: boolean;
  incrementLongResult: number;
  incrementDoubleResult: number;
  tagsAfterUnionAndRemove: string[];
  deletedFieldPresent: boolean;
  serverTimestampResolved: boolean;
  timestampSecondsPreserved: boolean;
  timestampNanosecondsPreserved: boolean;
  geoPointMatches: boolean;
  blobBytesMatch: boolean;
  documentReferenceRelativeSuffixMatches: boolean;
}

export interface FirestoreKotlinQueriesListenersAggregationsObservation {
  equalToIds: string[];
  rangeFilterAndIds: string[];
  filterOrIdsSorted: string[];
  whereInIdsSorted: string[];
  arrayContainsIdsSorted: string[];
  arrayContainsAnyIdsSorted: string[];
  orderByDescLimit2Ids: string[];
  orderByAscLimitToLast2Ids: string[];
  cursorStartAtEndBeforeIds: string[];
  startAfterDocumentSnapshotIds: string[];
  documentIdCursorIds: string[];
  countQueryCount: number;
  aggregateCount: number;
  aggregateSumScore: number;
  aggregateAverageScore: number;
  listenerDocumentChanges: string[];
  listenerQuietAfterRemove: boolean;
}

export interface FirestoreKotlinBatchesTransactionsOfflineErrorsObservation {
  batchItemScore: number;
  batchItemMergedFlag: boolean;
  batchDeletedDocExists: boolean;
  transactionReturnBalance: number;
  transactionReceiptBalance: number;
  transactionAbortRejected: boolean;
  balanceUnchangedAfterAbort: number;
  offlineCacheHasPendingWrites: boolean;
  offlineCacheIsFromCache: boolean;
  offlineServerReadErrorCode: string;
  flushedServerHasPendingWrites: boolean;
  flushedServerIsFromCache: boolean;
  permissionDeniedCodeName: string;
  permissionDeniedCodeValue: number;
  clearPersistenceWhileActiveCodeName: string;
  clearPersistenceAfterTerminateSucceeded: boolean;
}

export interface WireDocSnap {
  id: string;
  path: string;
  exists: boolean;
  hasPendingWrites?: boolean;
  data: { json: string; valueEncoding?: string } | null;
}

export interface HostedFirestoreRulesBridge {
  readonly actAs: { readonly mode: 'as'; readonly uid: string };
  sendOp(op: Record<string, unknown>): Promise<WorkerResFrame>;
  subscribe(subId: string, sub: Record<string, unknown>, onSnap: (value: unknown) => void): void;
  unsubscribe(subId: string): void;
  close(): Promise<void>;
}

export const FIRESTORE_KOTLIN_OBSERVATIONS_DIR = join(
  REPO_ROOT,
  'packages',
  'conformance',
  'observations',
  'firestore-kotlin',
);

export const KT_MAIN_ROOT = join(REPO_ROOT, 'packages', 'kt-client', 'src', 'main', 'kotlin');
export const DOC_VALUE_ENCODING = 'pyric/firestore-values/1';

const CLIENT_SESSION_ID = 'kt-firestore-oracle-replay-client';

function makeInMemoryHostedPersistence() {
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

export async function openAuthenticatedFirestoreBridge(
  projectId: string,
  runId: string,
  uid: string,
): Promise<HostedFirestoreRulesBridge> {
  const pendingReplies = new Map<string, (frame: WorkerResFrame) => void>();
  const pendingTimers = new Set<ReturnType<typeof setTimeout>>();
  const subListeners = new Map<string, (value: unknown) => void>();
  const persistence = makeInMemoryHostedPersistence();

  const firestoreRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /pyric_oracle/${runId}/{document=**} {
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
      } else if (frame.type === 'worker-snap') {
        const listener = subListeners.get(frame.subId);
        if (listener !== undefined) {
          listener(frame.value);
        }
      }
    },
    REPO_ROOT,
    { persistence: persistence as never, record: false },
  );

  let seq = 0;
  const sendOp = (op: Record<string, unknown>): Promise<WorkerResFrame> => {
    seq += 1;
    const id = `kt-fs-op-${seq}`;
    return new Promise<WorkerResFrame>((resolveReply, rejectReply) => {
      const timer = setTimeout(() => {
        pendingTimers.delete(timer);
        pendingReplies.delete(id);
        rejectReply(new Error(`Hosted Firestore worker-op '${id}' timed out`));
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
        clientSessionId: CLIENT_SESSION_ID,
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
    subListeners.clear();
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
    subscribe(subId: string, sub: Record<string, unknown>, onSnap: (value: unknown) => void): void {
      subListeners.set(subId, onSnap);
      runtime.receive({
        type: 'worker-sub',
        subId,
        clientSessionId: CLIENT_SESSION_ID,
        sub: sub as unknown as WorkerSubFrame['sub'],
      });
    },
    unsubscribe(subId: string): void {
      subListeners.delete(subId);
      runtime.receive({
        type: 'worker-unsub',
        subId,
        clientSessionId: CLIENT_SESSION_ID,
      });
    },
    close,
  };
}

export function parseWireDoc(frame: WorkerResFrame): {
  snap: WireDocSnap;
  fields: Record<string, unknown> | null;
} {
  if (!frame.ok) {
    throw new Error(`Expected worker-res ok, received error: ${JSON.stringify(frame.error)}`);
  }
  const snap = frame.value as WireDocSnap;
  if (!snap.exists || snap.data === null) {
    return { snap, fields: null };
  }
  const fields = JSON.parse(snap.data.json) as Record<string, unknown>;
  return { snap, fields };
}

export function extractDocIds(frame: WorkerResFrame): string[] {
  if (!frame.ok) {
    throw new Error(`Expected getDocs ok, received error: ${JSON.stringify(frame.error)}`);
  }
  const payload = frame.value as { docs: WireDocSnap[] };
  return payload.docs.map((d) => d.id);
}

export function whereClause(
  field: string,
  op: string,
  value: unknown,
): Record<string, unknown> {
  return {
    kind: 'where',
    field,
    fieldSegments: [field],
    op,
    value,
    valueEncoding: DOC_VALUE_ENCODING,
  };
}

export interface QueryChangeRecorder {
  readonly changeLog: string[];
  waitForChange(expected: string): Promise<void>;
  stop(): void;
}

export function attachQueryChangeRecorder(
  harness: HostedFirestoreRulesBridge,
  subId: string,
  watchColPath: string,
): QueryChangeRecorder {
  const changeLog: string[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let prevById: Map<string, string> | null = null;
  let snapNotify: (() => void) | null = null;

  harness.subscribe(
    subId,
    {
      target: {
        __ref: 'query',
        source: { __ref: 'collection', path: watchColPath },
        constraints: [{ kind: 'orderBy', field: 'step', fieldSegments: ['step'], direction: 'asc' }],
      },
      actAs: harness.actAs,
    },
    (rawVal) => {
      const snapMsg = rawVal as { docs: WireDocSnap[] };
      const currentById = new Map<string, string>();
      for (const doc of snapMsg.docs) {
        let rawJson = '';
        if (doc.data !== null) {
          rawJson = doc.data.json;
        }
        currentById.set(doc.id, rawJson);
      }
      if (prevById === null) {
        for (const doc of snapMsg.docs) {
          changeLog.push(`ADDED:${doc.id}`);
        }
      } else {
        for (const [oldId] of prevById) {
          if (!currentById.has(oldId)) {
            changeLog.push(`REMOVED:${oldId}`);
          }
        }
        for (const doc of snapMsg.docs) {
          if (!prevById.has(doc.id)) {
            changeLog.push(`ADDED:${doc.id}`);
          } else if (prevById.get(doc.id) !== currentById.get(doc.id)) {
            changeLog.push(`MODIFIED:${doc.id}`);
          }
        }
      }
      prevById = currentById;
      if (snapNotify !== null) {
        snapNotify();
      }
    },
  );

  return {
    changeLog,
    waitForChange(expected: string): Promise<void> {
      if (changeLog.includes(expected)) {
        return Promise.resolve();
      }
      return new Promise<void>((resolveWait, rejectWait) => {
        const timer = setTimeout(() => {
          timers.delete(timer);
          rejectWait(new Error(`Timed out waiting for listener change '${expected}'`));
        }, 5_000);
        timers.add(timer);
        snapNotify = () => {
          if (changeLog.includes(expected)) {
            clearTimeout(timer);
            timers.delete(timer);
            snapNotify = null;
            resolveWait();
          }
        };
      });
    },
    stop(): void {
      for (const timer of timers) {
        clearTimeout(timer);
      }
      timers.clear();
      snapNotify = null;
      harness.unsubscribe(subId);
    },
  };
}
