/**
 * Bridges a single `pyric/firestore` `onSnapshot` subscription with
 * `FirestoreClientState` so warmed cache entries emit `fromCache: true` before
 * `fromCache: false` (#1355) and `disableNetwork` / `enableNetwork` suspends
 * and resumes backend rule evaluation cleanly (FW-17).
 */
import type { FirestoreClientState } from '../client-state.js';
import type { DocumentData } from './local-state.js';
import { anyPathInQueryScope, docDataEqual } from './listener-delivery.js';
import type { QueryExecutionSpec, QueryScope } from './query-execution.js';
import { splitInitialMetadataSnapshots } from './cached-initial-snapshot.js';

interface RefLike {
  readonly type?: string;
  readonly path?: string;
}

function resolveQueryPlan(
  ref: RefLike,
  underlying: unknown,
): { readonly scope: QueryScope | undefined; readonly execution: QueryExecutionSpec | undefined } {
  let scope: QueryScope | undefined;
  let execution: QueryExecutionSpec | undefined;
  if (underlying !== null && typeof underlying === 'object') {
    const scopeFn = (underlying as { snapshotScope?: unknown }).snapshotScope;
    if (typeof scopeFn === 'function') {
      scope = (scopeFn as () => QueryScope).call(underlying);
    }
    const constraintsFn = (underlying as { snapshotConstraints?: unknown }).snapshotConstraints;
    if (typeof constraintsFn === 'function') {
      const plan = (constraintsFn as () => { execution?: QueryExecutionSpec } | undefined).call(underlying);
      execution = plan?.execution;
    }
  }
  if (scope === undefined && typeof ref.path === 'string' && ref.path.length > 0) {
    scope = { kind: 'collection', path: ref.path };
  }
  return { scope, execution };
}

export function attachClientManagedListener(params: {
  readonly clientState: FirestoreClientState;
  readonly ref: RefLike;
  readonly underlying: unknown;
  readonly includeMetadataChanges: boolean;
  readonly attachBackend: (
    onSnap: (snap: unknown) => void,
    onError: (error: unknown) => void,
  ) => () => void;
  readonly deliverSnap: (snap: unknown) => void;
  readonly deliverError: (error: unknown) => void;
}): () => void {
  const { clientState, ref, underlying, includeMetadataChanges, attachBackend, deliverSnap, deliverError } = params;
  const isDoc = ref.type === 'document' && typeof ref.path === 'string';
  const docPath = ref.path ?? '';
  let queryPlan: { readonly scope: QueryScope | undefined; readonly execution: QueryExecutionSpec | undefined } = {
    scope: undefined,
    execution: undefined,
  };
  if (!isDoc) {
    queryPlan = resolveQueryPlan(ref, underlying);
  }

  let hasWarmCacheAtSubscribe = false;
  if (clientState.isNetworkEnabled()) {
    if (isDoc) {
      hasWarmCacheAtSubscribe = clientState.overlay.isDocWarm(docPath);
    } else if (queryPlan.scope !== undefined) {
      hasWarmCacheAtSubscribe = clientState.overlay.isScopeWarm(queryPlan.scope);
    }
  }
  const wasWarmAtSubscribe = includeMetadataChanges && hasWarmCacheAtSubscribe;

  let stopped = false;
  let backendErrored = false;
  let deliveredCount = 0;
  let backendUnsub: (() => void) | undefined;
  let hadOfflineDelivery = false;
  let offlineDocData: DocumentData | null = null;
  let offlinePrevDocs: { path: string; data: DocumentData }[] | undefined;

  const deliverOffline = (changedPaths?: ReadonlySet<string>): void => {
    if (stopped || backendErrored || clientState.isNetworkEnabled()) return;
    if (isDoc) {
      if (changedPaths !== undefined && !changedPaths.has(docPath)) return;
      const projected = clientState.overlay.projectDoc(docPath);
      if (hadOfflineDelivery && !includeMetadataChanges && docDataEqual(offlineDocData, projected.data)) {
        return;
      }
      deliveredCount += 1;
      hadOfflineDelivery = true;
      offlineDocData = projected.data;
      deliverSnap(clientState.overlay.buildOfflineDocSnapshot(docPath));
      return;
    }
    const scope = queryPlan.scope;
    if (scope === undefined) return;
    if (changedPaths !== undefined && !anyPathInQueryScope(changedPaths, scope)) return;
    const built = clientState.overlay.buildOfflineQuerySnapshot(
      scope,
      queryPlan.execution,
      !includeMetadataChanges,
      offlinePrevDocs,
    );
    if (hadOfflineDelivery && !includeMetadataChanges && built.snapshot.docChanges().length === 0) {
      return;
    }
    deliveredCount += 1;
    hadOfflineDelivery = true;
    offlinePrevDocs = built.docs;
    deliverSnap(built.snapshot);
  };

  let unregister = (): void => {};

  const onBackendSnap = (rawSnap: unknown): void => {
    if (stopped || !clientState.isNetworkEnabled()) return;
    backendErrored = false;
    if (deliveredCount === 0 && wasWarmAtSubscribe) {
      const split = splitInitialMetadataSnapshots(rawSnap);
      if (split !== null) {
        deliveredCount += 1;
        deliverSnap(split.cachedSnapshot);
        queueMicrotask(() => {
          if (stopped || backendErrored || !clientState.isNetworkEnabled()) return;
          deliveredCount += 1;
          deliverSnap(split.serverSnapshot);
        });
        return;
      }
    }
    if (hadOfflineDelivery) {
      hadOfflineDelivery = false;
      offlinePrevDocs = undefined;
      if (!includeMetadataChanges && isDoc) {
        const snapDoc = rawSnap as { data?: () => DocumentData | undefined };
        const incoming = snapDoc.data?.() ?? null;
        if (docDataEqual(offlineDocData, incoming)) return;
      }
    }
    deliveredCount += 1;
    deliverSnap(rawSnap);
  };

  const onBackendError = (error: unknown): void => {
    if (stopped || !clientState.isNetworkEnabled()) return;
    if (deliveredCount === 0 && hasWarmCacheAtSubscribe) {
      if (isDoc) {
        const projected = clientState.overlay.projectDoc(docPath);
        if (projected.data !== null) {
          deliveredCount += 1;
          deliverSnap(clientState.overlay.buildOfflineDocSnapshot(docPath));
        }
      } else if (queryPlan.scope !== undefined) {
        const built = clientState.overlay.buildOfflineQuerySnapshot(
          queryPlan.scope,
          queryPlan.execution,
          !includeMetadataChanges,
          undefined,
        );
        if (built.docs.length > 0) {
          deliveredCount += 1;
          deliverSnap(built.snapshot);
        }
      }
      if (stopped) return;
    }
    backendErrored = true;
    deliverError(error);
  };

  unregister = clientState.registerListener({
    hasDelivered: () => deliveredCount > 0 || backendErrored,
    suspendBackend: () => {
      const unsub = backendUnsub;
      backendUnsub = undefined;
      unsub?.();
    },
    resumeBackend: () => {
      if (stopped || backendErrored || backendUnsub !== undefined) return;
      backendUnsub = attachBackend(onBackendSnap, onBackendError);
    },
    deliverOffline,
  });

  if (clientState.isNetworkEnabled()) {
    backendUnsub = attachBackend(onBackendSnap, onBackendError);
  } else {
    queueMicrotask(() => deliverOffline());
  }

  return () => {
    if (stopped) return;
    stopped = true;
    unregister();
    const unsub = backendUnsub;
    backendUnsub = undefined;
    unsub?.();
  };
}
