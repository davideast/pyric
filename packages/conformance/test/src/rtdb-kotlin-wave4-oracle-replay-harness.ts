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
import {
  openHostedKotlinBridge,
  type HostedKotlinBridgeHarness,
} from './kotlin-hosted-bridge-harness.ts';

export interface RtdbKotlinNavPushPrioritiesSnapshotsObservation {
  defaultInstanceMatchesFirebaseKtx: boolean;
  defaultRootMatchesUrl: boolean;
  namedDatabaseMatchesFirebaseKtx: boolean;
  rootKeyIsNull: boolean;
  rootParentIsNull: boolean;
  rootSelfEqualsRoot: boolean;
  nestedKey: string;
  nestedParentKey: string;
  nestedGrandParentKey: string;
  nestedRootKeyIsNull: boolean;
  nestedRootMatchesDatabaseRoot: boolean;
  normalizedRelativePathSuffixMatches: boolean;
  pushKeyLength: number;
  pushKeysLexicographicallyMonotonic: boolean;
  pushOrderedValues: string[];
  stringValueClass: string;
  integralValueClass: string;
  integralValueEquals42: boolean;
  floatingValueClass: string;
  booleanValueClass: string;
  listValueClass: string;
  mapValueClass: string;
  hasChildNested: boolean;
  hasChildMissing: boolean;
  hasChildrenTrue: boolean;
  missingSnapshotExists: boolean;
  missingSnapshotValueIsNull: boolean;
  missingSnapshotHasChildren: boolean;
  serverTimestampValueClass: string;
  serverTimestampEpochPlausible: boolean;
  setPriorityPreservedValue: string;
  setPriorityNumericValue: number;
  setPriorityNumericClass: string;
  setValueWithNumericPriority: number;
  setValueWithStringPriority: string;
  setValueWithStringPriorityClass: string;
  defaultPriorityOrderedValues: string[];
  existedBeforeSetNull: boolean;
  existsAfterSetNull: boolean;
  valueNullAfterSetNull: boolean;
  priorityNullAfterSetNull: boolean;
}

export interface RtdbKotlinQueriesRangesLimitsDeniedObservation {
  orderByKeyAll: string[];
  orderByKeyRangeBToD: string[];
  orderByKeyLimitToFirst2: string[];
  orderByKeyLimitToLast2: string[];
  orderByValueAll: string[];
  orderByValueEqualTo20: string[];
  orderByValueRange15To35: string[];
  orderByValueLimitToLast2: string[];
  orderByChildEqualToGold: string[];
  orderByChildEqualToGoldWithKeyP3: string[];
  orderByChildScoreRange20To30: string[];
  orderByChildScoreLimitToLast2: string[];
  deniedReadCancelledWithPermissionDenied: boolean;
  deniedReadErrorCode: number;
  deniedWriteThrewDatabaseException: boolean;
  deniedWriteMessageMentionsPermissionDenied: boolean;
}

export interface RtdbKotlinListenersTxConnectionOnDisconnectObservation {
  infoConnectedToggleTrueFalseTrue: boolean;
  infoServerTimeOffsetClass: string;
  valueListenerInitialCount: number;
  valueListenerObservedMutations: boolean;
  childTimeline: string[];
  silentAfterRemoveEventListener: boolean;
  txCommitErrorNull: boolean;
  txCommitCommitted: boolean;
  txCommitFinalValue: number;
  txAbortErrorNull: boolean;
  txAbortCommitted: boolean;
  txServerValueAfterAbort: number;
  onDisconnect: {
    statusAfterDisconnect: string;
    ephemeralExistsAfterDisconnect: boolean;
    canceledPathValueAfterDisconnect: string;
  };
}

export interface RtdbWireEntry {
  key: string;
  value: unknown;
  priority: string | number | null;
  exportValue: unknown;
}

export interface RtdbWireSnap {
  key: string | null;
  exists: boolean;
  value: unknown;
  size: number;
  priority: string | number | null;
  exportValue: unknown;
  entries: RtdbWireEntry[];
}

export const DEDICATED_INSTANCE = 'pyric-oracle-rtdb-2';
export const RTDB_KOTLIN_OBSERVATIONS_DIR = join(
  REPO_ROOT,
  'packages',
  'conformance',
  'observations',
  'rtdb-kotlin',
);
export const KT_MAIN_ROOT = join(REPO_ROOT, 'packages', 'kt-client', 'src', 'main', 'kotlin');

export async function openAuthenticatedDedicatedRtdbBridge(
  projectId: string,
  runId: string,
  uid: string,
  runSubtreeRules: Record<string, unknown>,
): Promise<{
  harness: HostedKotlinBridgeHarness;
  actAs: { readonly mode: 'as'; readonly uid: string };
}> {
  const defaultRules = { rules: { '.read': false, '.write': false } };
  const dedicatedRules = {
    rules: {
      pyric_oracle: {
        [runId]: runSubtreeRules,
      },
    },
  };
  const harness = await openHostedKotlinBridge({
    projectId,
    permissive: false,
    databaseRules: defaultRules,
    databaseRulesByInstance: {
      [`${projectId}-default-rtdb`]: defaultRules,
      [DEDICATED_INSTANCE]: dedicatedRules,
    },
  });
  try {
    const customToken = mintCustomToken({ uid, projectId, nowMs: Date.now() });
    const signInRes = await harness.sendOp({ method: 'auth.signInWithCustomToken', customToken });
    if (!signInRes.ok) {
      throw new Error(`Custom token sign-in failed: ${JSON.stringify(signInRes.error)}`);
    }
    return { harness, actAs: { mode: 'as', uid } };
  } catch (err) {
    await harness.close();
    throw err;
  }
}

export function extractRtdbSnap(frame: WorkerResFrame): RtdbWireSnap {
  if (!frame.ok) {
    throw new Error(`Expected rtdb worker-res ok, received: ${JSON.stringify(frame.error)}`);
  }
  return frame.value as RtdbWireSnap;
}

export function extractEntryKeys(frame: WorkerResFrame): string[] {
  return extractRtdbSnap(frame).entries.map((entry) => entry.key);
}

export interface MultiSessionHostedRtdbBridge {
  readonly actAs: { readonly mode: 'as'; readonly uid: string };
  sendOpAsSession(clientSessionId: string, op: Record<string, unknown>): Promise<WorkerResFrame>;
  subscribeAsSession(
    clientSessionId: string,
    subId: string,
    sub: Record<string, unknown>,
    onSnap: (value: unknown) => void,
  ): void;
  unsubscribeAsSession(clientSessionId: string, subId: string): void;
  close(): Promise<void>;
}

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

export async function openMultiSessionDedicatedRtdbBridge(
  projectId: string,
  runId: string,
  uid: string,
): Promise<MultiSessionHostedRtdbBridge> {
  const pendingReplies = new Map<string, (frame: WorkerResFrame) => void>();
  const pendingTimers = new Set<ReturnType<typeof setTimeout>>();
  const subListeners = new Map<string, (value: unknown) => void>();
  const persistence = makeInMemoryHostedPersistence();
  const defaultRules = { rules: { '.read': false, '.write': false } };
  const dedicatedRules = {
    rules: {
      pyric_oracle: {
        [runId]: {
          rtdb_kotlin: {
            '.read': 'auth != null',
            '.write': 'auth != null',
            watched_scores: { '.indexOn': '.value' },
          },
        },
      },
    },
  };

  const runtime = await createHostedRuntime(
    {
      rules: null,
      rulesHash: null,
      databaseRules: defaultRules,
      databaseRulesHash: null,
      databaseInstances: {
        defaultInstance: `${projectId}-default-rtdb`,
        projectId,
        rules: {
          [`${projectId}-default-rtdb`]: defaultRules,
          [DEDICATED_INSTANCE]: dedicatedRules,
        },
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
  const sendOpAsSession = (
    clientSessionId: string,
    op: Record<string, unknown>,
  ): Promise<WorkerResFrame> => {
    seq += 1;
    const id = `kt-rtdb-ms-${seq}`;
    return new Promise<WorkerResFrame>((resolveReply, rejectReply) => {
      const timer = setTimeout(() => {
        pendingTimers.delete(timer);
        pendingReplies.delete(id);
        rejectReply(new Error(`Hosted RTDB multi-session op '${id}' timed out`));
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
        clientSessionId,
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
    const signInObserver = await sendOpAsSession('kt-rtdb-observer', {
      method: 'auth.signInWithCustomToken',
      customToken,
    });
    const signInWriter = await sendOpAsSession('kt-rtdb-writer', {
      method: 'auth.signInWithCustomToken',
      customToken,
    });
    if (!signInObserver.ok || !signInWriter.ok) {
      throw new Error('Multi-session custom token sign-in failed');
    }
  } catch (err) {
    await close();
    throw err;
  }

  return {
    actAs: { mode: 'as', uid },
    sendOpAsSession,
    subscribeAsSession(
      clientSessionId: string,
      subId: string,
      sub: Record<string, unknown>,
      onSnap: (value: unknown) => void,
    ): void {
      subListeners.set(subId, onSnap);
      runtime.receive({
        type: 'worker-sub',
        subId,
        clientSessionId,
        sub: sub as unknown as WorkerSubFrame['sub'],
      });
    },
    unsubscribeAsSession(clientSessionId: string, subId: string): void {
      subListeners.delete(subId);
      runtime.receive({
        type: 'worker-unsub',
        subId,
        clientSessionId,
      });
    },
    close,
  };
}
