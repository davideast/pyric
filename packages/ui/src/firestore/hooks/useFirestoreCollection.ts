import { useEffect, useState } from 'react';
import {
  onSnapshot,
  type Query,
  type QuerySnapshot,
} from 'pyric/firestore';
import { coerceError } from './coerceError.js';
import type { SubscriptionState } from './useFirestoreDoc.js';

/**
 * Subscribe to a Firestore query (a `Query` from `pyric/firestore`'s
 * modular surface, including any `CollectionReference`, which extends
 * `Query`). Returns `{ data, error, isLoading }`.
 *
 * Null/undefined query short-circuits to idle. Cleanup is automatic
 * on unmount or query change. `Query` objects don't have a stable
 * structural identity, so the consumer must memoize at the call site
 * — pass the same instance across renders to avoid re-subscribing.
 */
export function useFirestoreCollection(
  query: Query | null | undefined,
): SubscriptionState<QuerySnapshot> {
  const [state, setState] = useState<SubscriptionState<QuerySnapshot>>(() => ({
    data: undefined,
    error: undefined,
    isLoading: query != null,
  }));

  useEffect(() => {
    if (!query) {
      setState({ data: undefined, error: undefined, isLoading: false });
      return;
    }

    setState((prev) => ({ data: prev.data, error: undefined, isLoading: true }));

    const unsubscribe = onSnapshot(
      query,
      (snap) =>
        setState({ data: snap as QuerySnapshot, error: undefined, isLoading: false }),
      (err) =>
        setState({
          data: undefined,
          error: coerceError(err),
          isLoading: false,
        }),
    );

    return unsubscribe;
  }, [query]);

  return state;
}
