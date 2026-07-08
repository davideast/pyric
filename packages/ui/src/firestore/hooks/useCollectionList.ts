import { useCallback, useEffect, useRef, useState } from 'react';
import {
  collection as collFn,
  doc as docFn,
  setDoc,
  type CollectionReference,
  type DocumentReference,
  type Firestore,
} from 'pyric/firestore';

export interface UseCollectionListOptions {
  firestore: Firestore;
  /** Parent document, or `null`/`undefined` for root collections. */
  parent?: DocumentReference | null;
  /**
   * Injected collection-listing function. The library doesn't ship
   * a default — the modular Web SDK doesn't expose `listCollections`
   * on the client. Sandbox-backed apps usually wire
   * `pyric/sandbox`'s in-process listing; production apps either
   * pass a known list (e.g. from a schema) or call a server proxy.
   */
  listCollections: (
    firestore: Firestore,
    parent: DocumentReference | null | undefined,
  ) => Promise<CollectionReference[]>;
}

export interface UseCollectionListResult {
  collections: CollectionReference[];
  isLoading: boolean;
  error: Error | undefined;
  /** Re-run the listing function. */
  refresh: () => void;
  /**
   * Create a new collection by writing its first document. Firestore
   * collections don't exist independently of their documents —
   * `setDoc` on the first child path materializes the collection.
   */
  createCollection: (
    collectionId: string,
    firstDoc: { id: string; data: Record<string, unknown> },
  ) => Promise<DocumentReference>;
}

/**
 * Operational read + create for collections under a parent (or root).
 * Listing is injected because the modular Web SDK doesn't expose a
 * native `listCollections` on the client — see options docs.
 */
export function useCollectionList({
  firestore,
  parent,
  listCollections,
}: UseCollectionListOptions): UseCollectionListResult {
  const [collections, setCollections] = useState<CollectionReference[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | undefined>(undefined);
  const [tick, setTick] = useState(0);

  // Stable-ref the injected lister so re-renders with a fresh
  // closure identity don't loop the effect — see useReferencePicker
  // for the same pattern + rationale.
  const listCollectionsRef = useRef(listCollections);
  listCollectionsRef.current = listCollections;

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(undefined);
    listCollectionsRef.current(firestore, parent)
      .then((list) => {
        if (cancelled) return;
        setCollections(list);
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
  }, [firestore, parent, tick]);

  const refresh = useCallback(() => setTick((n) => n + 1), []);

  const createCollection = useCallback<UseCollectionListResult['createCollection']>(
    async (collectionId, firstDoc) => {
      const parentColl = parent
        ? collFn(parent, collectionId)
        : collFn(firestore, collectionId);
      const ref = docFn(parentColl, firstDoc.id);
      await setDoc(ref, firstDoc.data);
      setTick((n) => n + 1);
      return ref;
    },
    [firestore, parent],
  );

  return { collections, isLoading, error, refresh, createCollection };
}
