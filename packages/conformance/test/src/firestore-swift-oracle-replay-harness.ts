import { expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createMemoryBackend } from 'pyric/sandbox';
import { mintCustomToken } from 'pyric/sandbox/internal';
import type {
  BridgeMessage,
  WorkerOpFrame,
  WorkerResFrame,
  WorkerSubFrame,
} from '../../../cli/dist/bridge/protocol.js';
import { createHostedRuntime } from '../../../cli/dist/serve/hosted/runtime.js';
import { REPO_ROOT } from '../../src/ledger.ts';

export interface FirestoreSwiftCrudCodecsObservation {
  autoExists: boolean;
  autoIdLength: number;
  autoOrigin: string;
  blobBytes: number[];
  deletedDataIsNil: boolean;
  deletedExists: boolean;
  deletedNestedExtraAbsent: boolean;
  finalTags: string[];
  fixedTsMatches: boolean;
  geoMatches: boolean;
  hasNullKey: boolean;
  incrementedCount: number;
  incrementedRatio: number;
  initialExists: boolean;
  initialFromCache: boolean;
  initialHasPendingWrites: boolean;
  mergeAddedNestedExtra: number;
  mergeFieldsNestedKeep: string;
  mergeFieldsPreservedExtra: number;
  mergeFieldsTitle: string;
  mergeFieldsUnlistedNestedAbsent: boolean;
  mergeFieldsUnlistedTopAbsent: boolean;
  mergePreservedCount: number;
  mergePreservedNestedKeep: string;
  refMatchesTarget: boolean;
  serverTimestampResolved: boolean;
}

export interface FirestoreSwiftQueriesCursorsAggregationsObservation {
  afterDocIds: string[];
  aggAverage: number;
  aggCount: number;
  aggSum: number;
  arrayContainsIds: string[];
  ascLimitIds: string[];
  cursorWindowIds: string[];
  descLimitIds: string[];
  eqIds: string[];
  gtIds: string[];
  inIds: string[];
  initialAddedIds: string[];
  initialListenerIds: string[];
  limitToLastIds: string[];
  lteIds: string[];
  noEventsAfterRemove: boolean;
  orFilterIds: string[];
  secondEventModifiedIds: string[];
}

export interface FirestoreSwiftBatchesTransactionsOfflineErrorsObservation {
  b1AfterBatch: number;
  b1AfterTxAbort: number;
  b1AfterTxCommit: number;
  b2AfterBatch: number;
  b2AfterTxCommit: number;
  bStaleExistsAfterBatch: boolean;
  deniedCode: number;
  deniedDomain: string;
  deniedMatchesPermissionDenied: boolean;
  flushedFromCache: boolean;
  flushedHasPendingWrites: boolean;
  missingUpdateCode: number;
  missingUpdateDomain: string;
  missingUpdateMatchesNotFound: boolean;
  offlineCacheExists: boolean;
  offlineHasPendingWrites: boolean;
  offlineServerReadCode: number;
  offlineServerReadMatchesUnavailable: boolean;
  offlineStatus: string;
  terminatedAndClearedPersistence: boolean;
  txAbortCode: number;
  txAbortDomain: string;
  txReturnString: string;
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

export const FIRESTORE_SWIFT_OBSERVATIONS_DIR = join(
  REPO_ROOT,
  'packages',
  'conformance',
  'observations',
  'firestore-swift',
);

export const SWIFT_FIRESTORE_ROOT = join(
  REPO_ROOT,
  'packages',
  'swift-client',
  'Sources',
  'PyricFirestore',
);

export const DOC_VALUE_ENCODING = 'pyric/firestore-values/1';
const CLIENT_SESSION_ID = 'swift-firestore-oracle-replay-client';

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

export async function openAuthenticatedSwiftFirestoreBridge(
  projectId: string,
  runId: string,
  uid: string,
  extraRulesBlock = '',
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
${extraRulesBlock}
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
    const id = `swift-fs-op-${String(seq)}`;
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
  return payload.docs.map((doc) => doc.id);
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

export function requireWireFields(
  parsed: { fields: Record<string, unknown> | null },
  label: string,
): Record<string, unknown> {
  if (parsed.fields === null) {
    throw new Error(`Expected non-null document fields for ${label}`);
  }
  return parsed.fields;
}

export function requireNestedMap(
  fields: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const candidate = fields[key];
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    throw new Error(`Expected nested object field '${key}'`);
  }
  return candidate as Record<string, unknown>;
}

export function verifySwiftCrudSourceInvariants(obs: FirestoreSwiftCrudCodecsObservation): void {
  const autoIdSwift = readFileSync(join(SWIFT_FIRESTORE_ROOT, 'Public', 'AutoId.swift'), 'utf8');
  const docSnapSwift = readFileSync(
    join(SWIFT_FIRESTORE_ROOT, 'Public', 'DocumentSnapshot.swift'),
    'utf8',
  );
  const fieldPathSwift = readFileSync(
    join(SWIFT_FIRESTORE_ROOT, 'Public', 'FieldPath.swift'),
    'utf8',
  );
  expect(autoIdSwift).toContain('while idChars.count < 20');
  expect(obs.autoIdLength).toBe(20);
  expect(docSnapSwift).toContain('public let exists: Bool');
  expect(docSnapSwift).toContain('public func data() -> [String: Any]?');
  expect(fieldPathSwift).toContain('public struct FieldPath: Equatable, Hashable, Sendable');
}

export function verifySwiftQueriesSourceInvariants(): void {
  const aggSwift = readFileSync(
    join(SWIFT_FIRESTORE_ROOT, 'Public', 'AggregateQuery.swift'),
    'utf8',
  );
  const querySnapSwift = readFileSync(
    join(SWIFT_FIRESTORE_ROOT, 'Public', 'QuerySnapshot.swift'),
    'utf8',
  );
  expect(aggSwift).toContain('public static func count() -> AggregateField');
  expect(aggSwift).toContain('public static func sum(_ field: String) -> AggregateField');
  expect(aggSwift).toContain('public static func average(_ field: String) -> AggregateField');
  expect(querySnapSwift).toContain('public private(set) var documentChanges: [DocumentChange]');
}

export function verifySwiftBatchTxOfflineSourceInvariants(
  obs: FirestoreSwiftBatchesTransactionsOfflineErrorsObservation,
): void {
  const firestoreSwift = readFileSync(
    join(SWIFT_FIRESTORE_ROOT, 'Public', 'Firestore.swift'),
    'utf8',
  );
  const fsTxSwift = readFileSync(
    join(SWIFT_FIRESTORE_ROOT, 'Public', 'Firestore+Transactions.swift'),
    'utf8',
  );
  const txSwift = readFileSync(join(SWIFT_FIRESTORE_ROOT, 'Public', 'Transaction.swift'), 'utf8');
  const exceptionsSwift = readFileSync(
    join(SWIFT_FIRESTORE_ROOT, 'Transport', 'Exceptions.swift'),
    'utf8',
  );
  const docRefSwift = readFileSync(
    join(SWIFT_FIRESTORE_ROOT, 'Public', 'DocumentReference.swift'),
    'utf8',
  );
  const lifecycleSwift = readFileSync(
    join(SWIFT_FIRESTORE_ROOT, 'Transport', 'FirestoreClientLifecycle.swift'),
    'utf8',
  );
  expect(firestoreSwift).toContain('public func disableNetwork() async throws');
  expect(firestoreSwift).toContain('public func enableNetwork() async throws');
  expect(firestoreSwift).toContain('public func waitForPendingWrites() async throws');
  expect(firestoreSwift).toContain('public func terminate() async throws');
  expect(firestoreSwift).toContain('public func clearPersistence() async throws');
  expect(fsTxSwift).toContain('_ updateBlock: @escaping @Sendable (Transaction, NSErrorPointer) -> Any?');
  expect(txSwift).toContain('public func getDocument(_ document: DocumentReference) throws -> DocumentSnapshot');
  expect(exceptionsSwift).toContain('public let FirestoreErrorDomain = "FIRFirestoreErrorDomain"');
  expect(exceptionsSwift).toContain('public struct PyricBridgeError: Error, CustomStringConvertible, LocalizedError, CustomNSError');
  expect(exceptionsSwift).toContain('case .notFound: return 5');
  expect(exceptionsSwift).toContain('case .permissionDenied: return 7');
  expect(exceptionsSwift).toContain('case .unavailable: return 14');
  expect(docRefSwift).toContain('source == .server && !firestore.lifecycle.isNetworkEnabled');
  expect(docRefSwift).toContain('PyricBridgeError.unavailable');
  expect(lifecycleSwift).toContain('func clearPersistence() throws');

  expect(obs.offlineCacheExists).toBe(true);
  expect(obs.offlineHasPendingWrites).toBe(true);
  expect(obs.offlineStatus).toBe('queued-offline');
  expect(obs.offlineServerReadCode).toBe(14);
  expect(obs.offlineServerReadMatchesUnavailable).toBe(true);
  expect(obs.terminatedAndClearedPersistence).toBe(true);
}

export function waitUntilSwiftCondition(
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
        rejectWait(new Error(`Timed out waiting for Swift replay condition '${label}'`));
      }
    }, 15);
  });
}
