import { useEffect, useState } from 'react';
import type { DocumentReference, DocumentSnapshot } from 'pyric/firestore';
import { coerceError } from './coerceError.js';
import { useFirestoreApi } from '../firestoreApi.js';

export interface SubscriptionState<T> {
  data: T | undefined;
  error: Error | undefined;
  isLoading: boolean;
}

/**
 * Subscribe to a single Firestore document. Returns `{ data, error,
 * isLoading }`. Null/undefined ref short-circuits to an idle state
 * (`data: undefined, error: undefined, isLoading: false`) — useful
 * for conditional rendering before a ref is known.
 *
 * Cleanup is automatic on unmount or ref change. Memoize the ref at
 * the call site; this hook's effect re-runs on identity change.
 */
export function useFirestoreDoc(
  ref: DocumentReference | null | undefined,
): SubscriptionState<DocumentSnapshot> {
  const { onSnapshot } = useFirestoreApi();
  const [state, setState] = useState<SubscriptionState<DocumentSnapshot>>(() => ({
    data: undefined,
    error: undefined,
    isLoading: ref != null,
  }));

  useEffect(() => {
    if (!ref) {
      setState({ data: undefined, error: undefined, isLoading: false });
      return;
    }

    setState((prev) => ({ data: prev.data, error: undefined, isLoading: true }));

    const unsubscribe = onSnapshot(
      ref,
      (snap) =>
        setState({ data: snap as DocumentSnapshot, error: undefined, isLoading: false }),
      (err) =>
        setState({
          data: undefined,
          error: coerceError(err),
          isLoading: false,
        }),
    );

    return unsubscribe;
  }, [onSnapshot, ref]);

  return state;
}
