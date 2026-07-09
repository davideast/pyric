import { useCallback, useEffect, useMemo, useReducer } from 'react';
import type { RtdbApi } from '../rtdbApi.js';
import { normalizeRtdbPath } from '../values.js';
import {
  initialRtdbTree,
  isRtdbPathExpanded,
  rtdbTreeReducer,
  rtdbTreeValueAt,
  rtdbVisibleChildren,
  type RtdbTreeState,
  type RtdbVisibleChildren,
} from '../reducers/tree.js';

/** Console-style child paging (Firebase console shows 50, then "show more"). */
export const RTDB_DEFAULT_PAGE_SIZE = 50;

export interface UseRtdbTreeOptions {
  /** Children rendered per level before "show more". Default 50. */
  pageSize?: number;
}

/**
 * Everything a tree view needs: the reducer state plus path-addressed
 * selectors and the expansion/paging commands. All paths are ABSOLUTE
 * database paths.
 */
export interface RtdbTreeController {
  state: RtdbTreeState;
  pageSize: number;
  valueAt(path: string): unknown;
  isExpanded(path: string): boolean;
  childrenAt(path: string): RtdbVisibleChildren;
  toggle(path: string): void;
  showMore(path: string): void;
}

/**
 * Live tree state for the RTDB viewer: subscribes to the value at the view
 * root `path` (realtime — every write re-delivers the subtree) and runs the
 * expansion/paging reducer over it. See `reducers/tree.ts` for the
 * one-subscription-per-view-root loading strategy and why expansion is a
 * pure render toggle rather than a fetch.
 */
export function useRtdbTree(
  api: RtdbApi,
  path: string,
  options: UseRtdbTreeOptions = {},
): RtdbTreeController {
  const pageSize = options.pageSize ?? RTDB_DEFAULT_PAGE_SIZE;
  const normalized = normalizeRtdbPath(path);
  const [state, dispatch] = useReducer(rtdbTreeReducer, normalized, initialRtdbTree);

  // Keep the reducer's view root in lockstep with the prop BEFORE the
  // subscription effect below re-runs, so a snapshot for the new root never
  // lands on the old root's state.
  if (state.path !== normalized) {
    dispatch({ type: 'navigate', path: normalized });
  }

  useEffect(() => {
    let cancelled = false;
    const unsubscribe = api.subscribeValue(
      normalized,
      (value) => {
        if (!cancelled) dispatch({ type: 'value', path: normalized, value });
      },
      (err) => {
        if (!cancelled) {
          dispatch({
            type: 'error',
            path: normalized,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      },
    );
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [api, normalized]);

  const valueAt = useCallback(
    (p: string) => rtdbTreeValueAt(state, p),
    [state],
  );
  const isExpanded = useCallback(
    (p: string) => isRtdbPathExpanded(state, p),
    [state],
  );
  const childrenAt = useCallback(
    (p: string) => rtdbVisibleChildren(state, p, pageSize),
    [state, pageSize],
  );
  const toggle = useCallback((p: string) => dispatch({ type: 'toggle', path: p }), []);
  const showMore = useCallback(
    (p: string) => dispatch({ type: 'show-more', path: p, pageSize }),
    [pageSize],
  );

  return useMemo(
    () => ({ state, pageSize, valueAt, isExpanded, childrenAt, toggle, showMore }),
    [state, pageSize, valueAt, isExpanded, childrenAt, toggle, showMore],
  );
}
