/**
 * RTDB viewer tree state (pure reducer). The interaction form is the Firebase
 * console / firebase-tools-ui data viewer: one view root (set by the path
 * bar), expandable/collapsible descendants, and per-level paging for wide
 * child lists.
 *
 * DATA-LOADING STRATEGY (documented decision): the worker protocol exposes
 * `rtdb.get` / value subscriptions per PATH but no shallow or depth-limited
 * reads — a read at a path always ships that path's WHOLE subtree over the
 * MessagePort. A per-expand fetch would therefore re-ship data the view-root
 * read already delivered. So the viewer holds ONE live value subscription at
 * the view root (realtime by construction) and makes RENDERING lazy instead:
 * nodes below the root start collapsed and mount nothing until expanded, and
 * an expanded level renders at most `pageSize` children until "show more"
 * (console-style paging at 50, chosen over virtualization for its simplicity —
 * it bounds the mounted DOM the same way). Cost is bounded by navigating the
 * view root deeper, which is the path bar's job.
 */

import {
  hasRtdbChildren,
  normalizeRtdbPath,
  normalizeRtdbSnapshotValue,
  relativeRtdbPath,
  rtdbChildEntries,
  rtdbValueAt,
} from '../values.js';

export interface RtdbTreeState {
  /** The view root — the absolute database path the path bar points at. */
  path: string;
  /** `loading` until the first snapshot after a navigate; then `live`. */
  status: 'loading' | 'live' | 'error';
  /** The subtree value AT `path` (plain JSON; `null` = nothing there). */
  value: unknown;
  error: string | null;
  /** Expanded descendant paths (absolute). The view root itself is always
   *  expanded and is never in this set. */
  expanded: Record<string, true>;
  /** Per-path shown-children override (absolute path → count). Absent means
   *  one page. */
  pages: Record<string, number>;
}

export type RtdbTreeAction =
  /** Path bar navigation: reset to a new view root. */
  | { type: 'navigate'; path: string }
  /** A value snapshot arrived. `path` is the subscription's view root — a
   *  snapshot from a superseded subscription (its path no longer the state's)
   *  is ignored. */
  | { type: 'value'; path: string; value: unknown }
  /** The view-root subscription failed (same `path` guard as `value`). */
  | { type: 'error'; path: string; message: string }
  | { type: 'toggle'; path: string }
  | { type: 'expand'; path: string }
  | { type: 'collapse'; path: string }
  /** Reveal one more page of children at `path`. */
  | { type: 'show-more'; path: string; pageSize: number };

export function initialRtdbTree(path: string): RtdbTreeState {
  return {
    path: normalizeRtdbPath(path),
    status: 'loading',
    value: null,
    error: null,
    expanded: {},
    pages: {},
  };
}

/** The subtree value at an ABSOLUTE database path, resolved against the
 *  loaded view-root value. `null` outside the view root. */
export function rtdbTreeValueAt(state: RtdbTreeState, path: string): unknown {
  const rel = relativeRtdbPath(state.path, path);
  return rel === null ? null : rtdbValueAt(state.value, rel);
}

/** Is this absolute path expanded? The view root always is. */
export function isRtdbPathExpanded(state: RtdbTreeState, path: string): boolean {
  const normalized = normalizeRtdbPath(path);
  return normalized === state.path || state.expanded[normalized] === true;
}

export interface RtdbVisibleChildren {
  /** The children to render, in key order, capped at the shown count. */
  entries: Array<[string, unknown]>;
  /** Total direct children at this path. */
  total: number;
  /** How many more "show more" would reveal (0 = all shown). */
  hiddenCount: number;
}

/** The page-capped child list at an absolute path (console pages at 50). */
export function rtdbVisibleChildren(
  state: RtdbTreeState,
  path: string,
  pageSize: number,
): RtdbVisibleChildren {
  const entries = rtdbChildEntries(rtdbTreeValueAt(state, path));
  const shown = Math.min(
    entries.length,
    state.pages[normalizeRtdbPath(path)] ?? pageSize,
  );
  return {
    entries: entries.slice(0, shown),
    total: entries.length,
    hiddenCount: entries.length - shown,
  };
}

/** Keep only entries whose path still resolves to a node WITH children under
 *  the new value — a removed or scalar-ified node can't stay expanded/paged. */
function pruneByValue<V>(
  record: Record<string, V>,
  state: Pick<RtdbTreeState, 'path' | 'value'>,
): Record<string, V> {
  const next: Record<string, V> = {};
  let changed = false;
  for (const [path, v] of Object.entries(record)) {
    const rel = relativeRtdbPath(state.path, path);
    if (rel !== null && hasRtdbChildren(rtdbValueAt(state.value, rel))) {
      next[path] = v;
    } else {
      changed = true;
    }
  }
  return changed ? next : record;
}

export function rtdbTreeReducer(
  state: RtdbTreeState,
  action: RtdbTreeAction,
): RtdbTreeState {
  switch (action.type) {
    case 'navigate': {
      const path = normalizeRtdbPath(action.path);
      // Re-navigating to the current root keeps the loaded value + expansion.
      if (path === state.path) return state;
      return initialRtdbTree(path);
    }
    case 'value': {
      if (normalizeRtdbPath(action.path) !== state.path) return state;
      const next: RtdbTreeState = {
        ...state,
        status: 'live',
        // RTDB semantics at the ingestion seam: an empty object IS null (an
        // empty database reads back as `{}`), so the tree never holds a
        // childless object that would render as a scalar leaf.
        value: normalizeRtdbSnapshotValue(action.value),
        error: null,
      };
      // UPDATE-MERGE: a live snapshot keeps expansion/paging for surviving
      // paths and prunes state for nodes that vanished or became scalars.
      next.expanded = pruneByValue(state.expanded, next);
      next.pages = pruneByValue(state.pages, next);
      return next;
    }
    case 'error':
      if (normalizeRtdbPath(action.path) !== state.path) return state;
      return { ...state, status: 'error', error: action.message };
    case 'expand': {
      const path = normalizeRtdbPath(action.path);
      if (path === state.path || state.expanded[path]) return state;
      // LAZY RENDER: expanding only flips the flag — children mount from the
      // already-loaded subtree (see the data-loading strategy note above).
      return { ...state, expanded: { ...state.expanded, [path]: true } };
    }
    case 'collapse': {
      const path = normalizeRtdbPath(action.path);
      if (!state.expanded[path]) return state;
      const expanded = { ...state.expanded };
      delete expanded[path];
      return { ...state, expanded };
    }
    case 'toggle': {
      const path = normalizeRtdbPath(action.path);
      return rtdbTreeReducer(state, {
        type: state.expanded[path] ? 'collapse' : 'expand',
        path,
      });
    }
    case 'show-more': {
      const path = normalizeRtdbPath(action.path);
      const shown = state.pages[path] ?? action.pageSize;
      return {
        ...state,
        pages: { ...state.pages, [path]: shown + action.pageSize },
      };
    }
  }
}
