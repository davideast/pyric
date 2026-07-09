import { useCallback, useEffect, useState } from 'react';
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
}

export interface UseDocumentListResult {
  documents: QueryDocumentSnapshot[];
  isLoading: boolean;
  error: Error | undefined;
  /** True if there might be another page. The hook tracks this via
   *  the last fetch's length === pageSize. */
  hasMore: boolean;
  /** Fetch the next page and append. */
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
  /** Reset pagination and re-fetch from the first page. Useful after
   *  the consumer mutates data outside this hook. */
  refresh: () => void;
}

/**
 * Cursor-based paginated document list. Uses `startAfter` against
 * the last fetched snapshot — the consumer never sees cursor
 * mechanics. `documents` accumulates across pages.
 *
 * Note: this is read-via-get, not realtime. The list updates on
 * `loadMore` / `createDocument` / `deleteDocument` / `refresh`.
 * Realtime subscriptions for a collection live in
 * `useFirestoreCollection`; combining the two (paginated + realtime)
 * is non-trivial and deferred — see design rationale section M6.
 */
export function useDocumentList({
  collection,
  query,
  pageSize = 50,
}: UseDocumentListOptions): UseDocumentListResult {
  const [documents, setDocuments] = useState<QueryDocumentSnapshot[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | undefined>(undefined);
  const [hasMore, setHasMore] = useState(false);
  const [tick, setTick] = useState(0);

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
    query: queryFn,
    setDoc,
    startAfter: startAfterFn,
  } = useFirestoreApi();

  useEffect(() => {
    let cancelled = false;
    setDocuments([]);
    setHasMore(false);
    setIsLoading(true);
    setError(undefined);
    const baseQuery = query ?? collection;
    const pagedQuery = queryFn(baseQuery, limitFn(pageSize));
    getDocs(pagedQuery)
      .then((snap) => {
        if (cancelled) return;
        setDocuments([...snap.docs]);
        setHasMore(snap.docs.length === pageSize);
        setIsLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e : new Error(String(e)));
        setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [collection, query, pageSize, tick]);

  const loadMore = useCallback(() => {
    if (!hasMore || isLoading) return;
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
  }, [collection, query, pageSize, documents, hasMore, isLoading]);

  const createDocument = useCallback<UseDocumentListResult['createDocument']>(
    async (id, data, opts) => {
      if (id == null) {
        const ref = await addDoc(collection, data);
        setTick((n) => n + 1);
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
      setTick((n) => n + 1);
      return ref;
    },
    [collection],
  );

  const deleteDocument = useCallback<UseDocumentListResult['deleteDocument']>(
    async (ref) => {
      await deleteDoc(ref);
      setTick((n) => n + 1);
    },
    [],
  );

  const refresh = useCallback(() => setTick((n) => n + 1), []);

  return {
    documents,
    isLoading,
    error,
    hasMore,
    loadMore,
    createDocument,
    deleteDocument,
    refresh,
  };
}
