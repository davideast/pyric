import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  CollectionReference,
  DocumentReference,
  Query,
  QueryDocumentSnapshot,
} from 'pyric/firestore';
import { useFirestoreApi } from '../firestoreApi.js';

export interface UseDocumentListOptions {
  collection: CollectionReference;
  /** Optional filter / sort. If omitted, the raw collection is used. */
  query?: Query;
  /** Page size for cursor-based pagination. Default 50. */
  pageSize?: number;
  /**
   * `paged` preserves the historical get-based cursor behavior. `live` keeps
   * the currently requested window under an `onSnapshot` subscription and
   * grows that window when `loadMore` is requested. Default `paged`.
   */
  mode?: 'paged' | 'live';
}

export interface UseDocumentListResult {
  documents: QueryDocumentSnapshot[];
  isLoading: boolean;
  error: Error | undefined;
  /** Identifies the active live subscription. Consumers that diff result
   * snapshots can include this in their scope so a re-subscription (including
   * load-more) establishes a silent baseline instead of looking like writes. */
  subscriptionGeneration: number;
  /** True if there might be another page. The hook tracks this via
   *  the last fetch's length === pageSize. */
  hasMore: boolean;
  /** Fetch the next page; live mode grows and re-establishes its window. */
  loadMore: () => void;
  /** Create a document. If `id` is null, Firestore generates one
   *  via `addDoc`. With `onExisting: 'fail'` (CREATE semantics, the
   *  admin `create()` analog) an id that already exists rejects with
   *  `code: 'already-exists'` instead of silently overwriting —
   *  checked against the BACKEND (a `getDoc` probe), not any loaded
   *  page, so it is honest beyond pagination. Default: 'overwrite'
   *  (plain `setDoc`, the historical behavior). */
  createDocument: (
    id: string | null,
    data: Record<string, unknown>,
    opts?: { onExisting?: 'overwrite' | 'fail' },
  ) => Promise<DocumentReference>;
  deleteDocument: (ref: DocumentReference) => Promise<void>;
  /** Re-establish the active read/subscription. Useful after the consumer
   *  mutates data outside this hook. */
  refresh: () => void;
}

/**
 * Paginated document list with two acquisition strategies. The default
 * `paged` mode uses `startAfter` and accumulates one-shot reads. `live` keeps
 * the requested prefix under one `onSnapshot` listener; loading more grows
 * that prefix and establishes a new subscription baseline.
 */
export function useDocumentList({
  collection,
  query,
  pageSize = 50,
  mode = 'paged',
}: UseDocumentListOptions): UseDocumentListResult {
  const [documents, setDocuments] = useState<QueryDocumentSnapshot[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | undefined>(undefined);
  const [hasMore, setHasMore] = useState(false);
  const [tick, setTick] = useState(0);
  const [requestedCount, setRequestedCount] = useState(pageSize);
  const nextSubscriptionGeneration = useRef(0);
  const [subscriptionGeneration, setSubscriptionGeneration] = useState(0);

  // The modular fns, injected: in-process `pyric/firestore` by default, or the
  // SharedWorker client bundle when a consumer (Pyric Studio served mode) wraps
  // the tree in a `FirestoreApiProvider`. Stable across renders per provider.
  const {
    addDoc,
    deleteDoc,
    doc: docFn,
    getDoc,
    getDocs,
    limit: limitFn,
    onSnapshot,
    query: queryFn,
    setDoc,
    startAfter: startAfterFn,
  } = useFirestoreApi();

  useEffect(() => {
    setRequestedCount(pageSize);
  }, [collection, mode, pageSize, query]);

  useEffect(() => {
    let cancelled = false;
    if (mode === 'paged') setDocuments([]);
    setHasMore(false);
    setIsLoading(true);
    setError(undefined);
    const baseQuery = query ?? collection;
    const fetchCount = mode === 'live' ? requestedCount : pageSize;
    const pagedQuery = queryFn(baseQuery, limitFn(fetchCount));
    const accept = (snap: { readonly docs: readonly QueryDocumentSnapshot[] }) => {
      if (cancelled) return;
      setDocuments([...snap.docs]);
      setHasMore(snap.docs.length === fetchCount);
      setIsLoading(false);
    };
    const reject = (e: unknown) => {
      if (cancelled) return;
      setError(e instanceof Error ? e : new Error(String(e)));
      setIsLoading(false);
    };

    if (mode === 'live') {
      const generation = ++nextSubscriptionGeneration.current;
      const unsubscribe = onSnapshot(
        pagedQuery,
        (snap: unknown) => {
          setSubscriptionGeneration(generation);
          accept(snap as { readonly docs: readonly QueryDocumentSnapshot[] });
        },
        reject,
      );
      return () => {
        cancelled = true;
        unsubscribe();
      };
    }

    getDocs(pagedQuery)
      .then((snap) => {
        accept(snap);
      })
      .catch(reject);
    return () => {
      cancelled = true;
    };
  }, [
    collection,
    getDocs,
    limitFn,
    mode,
    onSnapshot,
    pageSize,
    query,
    queryFn,
    requestedCount,
    tick,
  ]);

  const loadMore = useCallback(() => {
    if (!hasMore || isLoading) return;
    if (mode === 'live') {
      setIsLoading(true);
      setRequestedCount((count) => count + pageSize);
      return;
    }
    const last = documents[documents.length - 1];
    if (!last) return;
    setIsLoading(true);
    const baseQuery = query ?? collection;
    const pagedQuery = queryFn(baseQuery, startAfterFn(last), limitFn(pageSize));
    getDocs(pagedQuery)
      .then((snap) => {
        setDocuments((prev) => [...prev, ...snap.docs]);
        setHasMore(snap.docs.length === pageSize);
        setIsLoading(false);
      })
      .catch((e) => {
        setError(e instanceof Error ? e : new Error(String(e)));
        setIsLoading(false);
      });
  }, [
    collection,
    documents,
    getDocs,
    hasMore,
    isLoading,
    limitFn,
    mode,
    pageSize,
    query,
    queryFn,
    startAfterFn,
  ]);

  const createDocument = useCallback<UseDocumentListResult['createDocument']>(
    async (id, data, opts) => {
      if (id == null) {
        const ref = await addDoc(collection, data);
        if (mode === 'paged') setTick((n) => n + 1);
        return ref;
      }
      const ref = docFn(collection, id);
      if (opts?.onExisting === 'fail') {
        // CREATE semantics without a batch/create primitive on FirestoreApi:
        // probe the backend, then write. The probe is authoritative for the
        // whole collection (not just a loaded page); the tiny read-then-write
        // window is acceptable for the dev-sandbox surfaces this backs.
        const existing = await getDoc(ref);
        // `exists` is a method on the modular SDK snapshot but a boolean on
        // some compat-shaped snapshots this bundle may be adapted over.
        const exists =
          typeof existing.exists === 'function' ? existing.exists() : Boolean(existing.exists);
        if (exists) {
          const err = new Error(`Document "${id}" already exists.`) as Error & { code: string };
          err.code = 'already-exists';
          throw err;
        }
      }
      await setDoc(ref, data);
      if (mode === 'paged') setTick((n) => n + 1);
      return ref;
    },
    [addDoc, collection, docFn, getDoc, mode, setDoc],
  );

  const deleteDocument = useCallback<UseDocumentListResult['deleteDocument']>(
    async (ref) => {
      await deleteDoc(ref);
      if (mode === 'paged') setTick((n) => n + 1);
    },
    [deleteDoc, mode],
  );

  const refresh = useCallback(() => setTick((n) => n + 1), []);

  return {
    documents,
    isLoading,
    error,
    subscriptionGeneration,
    hasMore,
    loadMore,
    createDocument,
    deleteDocument,
    refresh,
  };
}
