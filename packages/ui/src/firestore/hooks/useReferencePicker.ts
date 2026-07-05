import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  doc as docFn,
  getDocs,
  limit as limitFn,
  query as queryFn,
  type CollectionReference,
  type DocumentReference,
  type Firestore,
  type QueryDocumentSnapshot,
} from 'pyric/firestore';

export type BrowseLocation =
  | { kind: 'root' }
  | { kind: 'document'; ref: DocumentReference }
  | { kind: 'collection'; ref: CollectionReference };

export interface UseReferencePickerOptions {
  firestore: Firestore;
  /**
   * Lister for subcollections under a parent (or root when
   * `parent == null`). The library does not ship a default — see
   * `useCollectionList` for the same rationale (the modular Web SDK
   * can't enumerate collections client-side).
   */
  listCollections: (
    firestore: Firestore,
    parent: DocumentReference | null,
  ) => Promise<CollectionReference[]>;
  /** Default page size for the document list when browsing inside
   *  a collection. Default 20. */
  pageSize?: number;
  /** Initial value to pre-populate the text input + parse. */
  initialPath?: string;
}

export interface UseReferencePickerResult {
  /** Current text input value. */
  pathInput: string;
  /** Validated `DocumentReference` parsed from `pathInput`, or
   *  `null` when the path is empty / invalid. */
  reference: DocumentReference | null;
  /** Parse error, or `null` when valid. */
  error: string | null;
  /** Current browse position in the tree. */
  browseLocation: BrowseLocation;
  /** Whether `drillBack` has anywhere to go. */
  canDrillBack: boolean;
  /** Collections available at the current browse level. Populated
   *  when `browseLocation` is `root` or `document`. */
  collections: CollectionReference[];
  /** First page of documents in the current collection — populated
   *  when `browseLocation.kind === 'collection'`. */
  documents: QueryDocumentSnapshot[];
  /** True while a fetch is in flight. */
  isLoading: boolean;

  /** Set the text-input value. Parses on every change. */
  setPathInput: (path: string) => void;
  /** Commit a chosen reference. Updates `pathInput` (and therefore
   *  the parsed `reference`). */
  pick: (ref: DocumentReference) => void;
  /** Drill into a collection — fetches its first page of documents. */
  drillIntoCollection: (ref: CollectionReference) => void;
  /** Drill into a document — fetches its subcollections. */
  drillIntoDocument: (ref: DocumentReference) => void;
  /** Step back one level. No-op when at root. */
  drillBack: () => void;
  /** Clear the path input + reset browse to root. */
  clear: () => void;
}

interface BrowseState {
  current: BrowseLocation;
  history: BrowseLocation[];
}

function parseReferencePath(
  firestore: Firestore,
  path: string,
): { ref: DocumentReference | null; error: string | null } {
  const trimmed = path.trim();
  if (!trimmed) return { ref: null, error: null };
  const segments = trimmed.split('/').filter(Boolean);
  if (segments.length === 0) return { ref: null, error: 'Empty path' };
  if (segments.length % 2 !== 0)
    return { ref: null, error: 'Must point to a document (even segment count)' };
  try {
    const ref = docFn(firestore, trimmed) as DocumentReference;
    return { ref, error: null };
  } catch (e) {
    return {
      ref: null,
      error: e instanceof Error ? e.message : 'Invalid path',
    };
  }
}

const ROOT: BrowseLocation = { kind: 'root' };

/**
 * Picker state machine. Browses a Firestore tree level-by-level
 * (root → collection → document → collection → ...), maintains a
 * separately-validated text-input path, and commits a chosen
 * reference via `pick`.
 *
 * Headless — consumers compose the resulting state into their own
 * UI, or use the bundled `<ReferencePicker>` component.
 */
export function useReferencePicker({
  firestore,
  listCollections,
  pageSize = 20,
  initialPath = '',
}: UseReferencePickerOptions): UseReferencePickerResult {
  const [pathInput, setPathInputState] = useState(initialPath);
  const [browse, setBrowse] = useState<BrowseState>({
    current: ROOT,
    history: [],
  });
  const [collections, setCollections] = useState<CollectionReference[]>([]);
  const [documents, setDocuments] = useState<QueryDocumentSnapshot[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const parsed = useMemo(
    () => parseReferencePath(firestore, pathInput),
    [firestore, pathInput],
  );

  // Keep the injected `listCollections` in a ref so the fetch
  // effect's deps don't include it. Consumers commonly pass an
  // inline arrow function whose identity churns on every render;
  // depending on it would loop the effect forever.
  const listCollectionsRef = useRef(listCollections);
  listCollectionsRef.current = listCollections;

  // Re-fetch contents whenever the browse location changes.
  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    const loc = browse.current;
    if (loc.kind === 'root' || loc.kind === 'document') {
      const parent = loc.kind === 'document' ? loc.ref : null;
      setDocuments([]);
      listCollectionsRef.current(firestore, parent)
        .then((cs) => {
          if (cancelled) return;
          setCollections(cs);
          setIsLoading(false);
        })
        .catch(() => {
          if (cancelled) return;
          setCollections([]);
          setIsLoading(false);
        });
    } else {
      setCollections([]);
      const pagedQuery = queryFn(loc.ref, limitFn(pageSize));
      getDocs(pagedQuery)
        .then((snap) => {
          if (cancelled) return;
          setDocuments([...snap.docs]);
          setIsLoading(false);
        })
        .catch(() => {
          if (cancelled) return;
          setDocuments([]);
          setIsLoading(false);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [browse.current, firestore, pageSize]);

  const setPathInput = useCallback((path: string) => {
    setPathInputState(path);
  }, []);

  const pick = useCallback((ref: DocumentReference) => {
    setPathInputState(ref.path);
  }, []);

  const drillIntoCollection = useCallback((ref: CollectionReference) => {
    setBrowse((prev) => ({
      current: { kind: 'collection', ref },
      history: [...prev.history, prev.current],
    }));
  }, []);

  const drillIntoDocument = useCallback((ref: DocumentReference) => {
    setBrowse((prev) => ({
      current: { kind: 'document', ref },
      history: [...prev.history, prev.current],
    }));
  }, []);

  const drillBack = useCallback(() => {
    setBrowse((prev) => {
      if (prev.history.length === 0) return prev;
      const next = prev.history.slice(0, -1);
      const popped = prev.history[prev.history.length - 1];
      return { current: popped, history: next };
    });
  }, []);

  const clear = useCallback(() => {
    setPathInputState('');
    setBrowse({ current: ROOT, history: [] });
  }, []);

  return {
    pathInput,
    reference: parsed.ref,
    error: parsed.error,
    browseLocation: browse.current,
    canDrillBack: browse.history.length > 0,
    collections,
    documents,
    isLoading,
    setPathInput,
    pick,
    drillIntoCollection,
    drillIntoDocument,
    drillBack,
    clear,
  };
}
