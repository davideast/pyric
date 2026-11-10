/**
 * Session-op classification and fail-closed invalidation policy for observed
 * calls accepted by a Live mode host (`live-host-state.ts`).
 *
 * Applies explicit per-service role overrides (`FIRESTORE_METHOD_ROLES`,
 * `RTDB_METHOD_ROLES`) for listeners, Admin methods, batch or transaction
 * commits, scalar aggregate queries (`getCountFromServer`,
 * `getAggregateFromServer`), and passive lifecycle calls, then derives read vs.
 * mutation roles from `observedMethod` and `rtdbRulesMethod`. Any unknown
 * Firestore or RTDB method defaults fail-closed to `'scoped-mutation'`.
 */
import { observedMethod, rtdbRulesMethod } from 'pyric/sandbox/internal';
import type { ObservedCall } from 'pyric/sandbox';
import type { SessionDeltaSkipReason } from './delta-validation.js';
import type { ObservedSessionDataStore } from './store.js';
import type { ObservedSessionDelta, ObservedSessionSource } from './wire.js';

export type SessionCallRole = 'passive' | 'read' | 'scoped-mutation' | 'unscoped-mutation';

const FIRESTORE_METHOD_ROLES: Readonly<Record<string, SessionCallRole>> = {
  initializeFirestore: 'passive',
  getFirestore: 'passive',
  terminate: 'passive',
  clearIndexedDbPersistence: 'passive',
  enableIndexedDbPersistence: 'passive',
  enableMultiTabIndexedDbPersistence: 'passive',
  enableNetwork: 'passive',
  disableNetwork: 'passive',
  waitForPendingWrites: 'passive',
  onSnapshotsInSync: 'passive',
  loadBundle: 'passive',
  namedQuery: 'passive',
  getCountFromServer: 'passive',
  getAggregateFromServer: 'passive',
  'DocumentReference.listCollections': 'passive',
  'CollectionReference.listDocuments': 'passive',
  onSnapshot: 'read',
  onSnapshotResume: 'read',
  'DocumentReference.get': 'read',
  'DocumentReference.onSnapshot': 'read',
  'Query.get': 'read',
  'Query.onSnapshot': 'read',
  'Firestore.getAll': 'read',
  writeBatch: 'unscoped-mutation',
  runTransaction: 'unscoped-mutation',
  'WriteBatch.commit': 'unscoped-mutation',
  'Firestore.runTransaction': 'unscoped-mutation',
  'Firestore.recursiveDelete': 'unscoped-mutation',
};

const RTDB_METHOD_ROLES: Readonly<Record<string, SessionCallRole>> = {
  getDatabase: 'passive',
  goOnline: 'passive',
  goOffline: 'passive',
  'onDisconnect.cancel': 'passive',
  'Query.get': 'read',
  'Query.once': 'read',
  'Query.on': 'read',
};

const DEFINITIVE_RULES_DENIALS: ReadonlySet<string> = new Set([
  'permission-denied',
  'permission_denied',
  'unauthenticated',
]);

export function isSessionDataService(
  service: ObservedCall['service'],
): service is 'firestore' | 'rtdb' | 'storage' {
  return service === 'firestore' || service === 'rtdb' || service === 'storage';
}

/** Classifies a Firestore, RTDB, or Storage call for session-store updates and invalidations. */
export function classifySessionCall(
  service: 'firestore' | 'rtdb' | 'storage',
  method: string,
): SessionCallRole {
  if (service === 'storage') return 'read';
  if (service === 'firestore') {
    if (Object.hasOwn(FIRESTORE_METHOD_ROLES, method)) {
      return FIRESTORE_METHOD_ROLES[method]!;
    }
    const mapped = observedMethod('firestore', method);
    if (mapped === 'get' || mapped === 'list') return 'read';
    return 'scoped-mutation';
  }
  if (Object.hasOwn(RTDB_METHOD_ROLES, method)) {
    return RTDB_METHOD_ROLES[method]!;
  }
  const rtdbMapped = rtdbRulesMethod(method);
  if (rtdbMapped === 'get') return 'read';
  return 'scoped-mutation';
}

function sessionSourceOf(call: ObservedCall): ObservedSessionSource {
  if (call.sdk === 'admin') return 'admin';
  return 'client';
}

/** Invalidates authoritative coverage for a call's target path, collection, or whole service. */
export function invalidateSessionCallTarget(
  sessionData: ObservedSessionDataStore,
  call: ObservedCall,
  role: SessionCallRole,
  projectHint: string,
): void {
  if (call.service === 'firestore') {
    let target: string | undefined = call.path;
    if (role === 'unscoped-mutation') target = undefined;
    sessionData.invalidateFirestore(target);
    return;
  }
  if (call.service === 'rtdb') {
    sessionData.invalidateRtdb(call.instance, call.path, projectHint);
  }
}

export interface AcceptedSessionObservation {
  readonly call: ObservedCall;
  readonly sessionData?: ObservedSessionDelta;
  readonly sessionDataSkip?: SessionDeltaSkipReason;
}

/** Applies an accepted observed call's session delta or fail-closed invalidation to `store`. */
export function applyAcceptedSessionCall(
  store: ObservedSessionDataStore,
  entry: AcceptedSessionObservation,
  projectHint: string,
): void {
  const { call } = entry;
  if (call.listener !== undefined || !isSessionDataService(call.service)) return;
  const role = classifySessionCall(call.service, call.method);
  if (role === 'passive') return;
  const isMutation = role === 'scoped-mutation' || role === 'unscoped-mutation';
  if (call.outcome.status !== 'ok') {
    store.recordSkip({ failed: 1 });
    if (isMutation) {
      const isRulesDenial =
        call.outcome.code !== undefined && DEFINITIVE_RULES_DENIALS.has(call.outcome.code);
      if (!isRulesDenial) invalidateSessionCallTarget(store, call, role, projectHint);
    }
    return;
  }
  if (entry.sessionDataSkip !== undefined) {
    store.recordSkip({ [entry.sessionDataSkip]: 1 });
    invalidateSessionCallTarget(store, call, role, projectHint);
    return;
  }
  const source = sessionSourceOf(call);
  if (!isMutation) {
    if (entry.sessionData?.skipped !== undefined) {
      invalidateSessionCallTarget(store, call, role, projectHint);
    }
    if (entry.sessionData !== undefined) {
      store.apply(entry.sessionData, projectHint, source);
    }
    return;
  }
  if (entry.sessionData !== undefined) {
    store.apply(entry.sessionData, projectHint, source);
  }
  const missingFirestoreWrite =
    call.service === 'firestore' && (entry.sessionData?.firestore?.length ?? 0) === 0;
  const partialUnscopedWrite =
    call.service === 'firestore' &&
    role === 'unscoped-mutation' &&
    entry.sessionData?.skipped !== undefined;
  const missingRtdbWrite =
    call.service === 'rtdb' && (entry.sessionData?.rtdb?.length ?? 0) === 0;
  if (missingFirestoreWrite || partialUnscopedWrite || missingRtdbWrite) {
    invalidateSessionCallTarget(store, call, role, projectHint);
  }
}

/** Invalidates target coverage when an unanswered pending observation is evicted on overflow. */
export function invalidateEvictedPendingCall(
  store: ObservedSessionDataStore,
  call: ObservedCall,
  projectHint: string,
): void {
  if (call.listener !== undefined || !isSessionDataService(call.service)) return;
  const role = classifySessionCall(call.service, call.method);
  if (role === 'passive') return;
  invalidateSessionCallTarget(store, call, role, projectHint);
}
