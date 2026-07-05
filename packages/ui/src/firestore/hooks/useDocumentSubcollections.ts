import { useEffect, useRef, useState } from 'react';
import type {
  CollectionReference,
  DocumentReference,
  Firestore,
} from 'pyric/firestore';

/**
 * Lister for a document's own subcollections. Same injected-lister
 * shape as `useCollectionList` / `ReferencePicker` use — the modular
 * Web SDK doesn't expose a native `listCollections` on the client, so
 * the caller wires it (sandbox in-process listing, a server proxy, or
 * a known schema list).
 */
export type ListSubcollections = (
  firestore: Firestore,
  parent: DocumentReference,
) => Promise<CollectionReference[]>;

export interface UseDocumentSubcollectionsOptions {
  firestore: Firestore;
  /** The document whose subcollections to list. When `null`/`undefined`
   *  the hook stays idle (empty, not loading) — used when the preview
   *  has no ref to drill from. */
  documentRef: DocumentReference | null | undefined;
  listSubcollections: ListSubcollections;
}

export interface UseDocumentSubcollectionsResult {
  subcollections: CollectionReference[];
  isLoading: boolean;
  error: Error | undefined;
}

/**
 * Read a single document's subcollection list. A thin specialization of
 * the `useCollectionList` pattern, scoped to one parent document and
 * read-only (no create — that lives in `useCollectionList`).
 */
export function useDocumentSubcollections({
  firestore,
  documentRef,
  listSubcollections,
}: UseDocumentSubcollectionsOptions): UseDocumentSubcollectionsResult {
  const [subcollections, setSubcollections] = useState<CollectionReference[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | undefined>(undefined);

  // Stable-ref the injected lister so a fresh closure identity each
  // render doesn't loop the effect — same pattern as useCollectionList.
  const listRef = useRef(listSubcollections);
  listRef.current = listSubcollections;

  // Key the effect on the ref's path (stable across snapshot identity
  // churn) rather than the ref object, which the SDK may re-create.
  const path = documentRef?.path;

  useEffect(() => {
    if (!documentRef) {
      setSubcollections([]);
      setIsLoading(false);
      setError(undefined);
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    setError(undefined);
    listRef.current(firestore, documentRef)
      .then((list) => {
        if (cancelled) return;
        setSubcollections(list);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firestore, path]);

  return { subcollections, isLoading, error };
}
