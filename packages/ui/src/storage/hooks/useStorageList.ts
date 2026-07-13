import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  FirebaseStorage,
  StorageReference,
} from 'pyric/storage';
import { useStorageApi } from '../storageApi.js';

export type StorageListStatus = 'idle' | 'loading' | 'success' | 'error';

/**
 * One row of the merged folder/object model, the prefix→folder
 * synthesis ported (as an idea, not code) from the emulator UI's
 * `useStorageFiles`: `listAll`'s `prefixes` become `kind: 'folder'`
 * rows, its `items` become `kind: 'object'` rows, folders first.
 */
export interface StorageListEntry {
  kind: 'folder' | 'object';
  /** Last path segment, display name. */
  name: string;
  /** Bucket-rooted path (no trailing slash, even for folders). */
  fullPath: string;
  ref: StorageReference;
}

export interface UseStorageListResult {
  /** `'idle'` only when `storage` is null/undefined. */
  status: StorageListStatus;
  /** Direct child objects under `path`. Sorted by `fullPath`. */
  items: StorageReference[];
  /** Synthetic folder prefixes under `path`. Sorted by `fullPath`. */
  prefixes: StorageReference[];
  /** Folders-first merged row model. Derived from `prefixes` + `items`. */
  entries: StorageListEntry[];
  /**
   * `StorageError` (with a typed `storage/<code>` on `.code`) from the
   * sandbox. A denied list is `error.code === 'storage/unauthorized'`
   * (ST-B2).
   */
  error: Error | undefined;
  /** Re-run `listAll` for the current path. */
  refresh: () => void;
  /**
   * Optimistic seam (consumed by M3 upload / M6 bulk ops, exposed
   * now so those hooks layer on without reshaping this one). Inserts
   * `fullPath` into the local list immediately, applying the same
   * prefix→folder synthesis `listAll` would: a direct child becomes
   * an item, a deeper descendant surfaces as its first-segment
   * folder. A trailing slash declares a folder (the GCS placeholder
   * convention `useObjectUpload.createFolder` writes): a direct
   * trailing-slash child inserts a prefix, not an item. No-op for
   * paths outside the listed path, duplicates, or when `status` is
   * `'idle'`. What each call ACTUALLY inserted is recorded (keyed by
   * the given `fullPath`) so `removeItem` can reverse it precisely.
   * Rollback = `removeItem` or `refresh`.
   */
  insertItem: (fullPath: string) => void;
  /**
   * Optimistic counterpart. When `fullPath` was previously given to
   * `insertItem`, this reverses EXACTLY what that call inserted: a
   * deep upload that synthesized a first-segment folder row removes
   * that folder row, and an insert that was a no-op (the row already
   * existed — e.g. a real, listed folder) removes NOTHING, so a
   * failed upload can never delete server-truth rows. For paths never
   * seen by `insertItem` it removes the matching item/folder row
   * directly (the optimistic-delete use). Rollback = `refresh`.
   */
  removeItem: (fullPath: string) => void;
}

interface ListState {
  status: StorageListStatus;
  items: StorageReference[];
  prefixes: StorageReference[];
  error: Error | undefined;
}

/** Strip leading/trailing slashes so `'a/b/'`, `'/a/b'`, `'a/b'` agree. */
function normalizePath(path: string): string {
  return path.replace(/^\/+|\/+$/g, '');
}

function byFullPath(a: StorageReference, b: StorageReference): number {
  return a.fullPath < b.fullPath ? -1 : a.fullPath > b.fullPath ? 1 : 0;
}

function insertSorted(
  list: StorageReference[],
  next: StorageReference,
): StorageReference[] {
  if (list.some((r) => r.fullPath === next.fullPath)) return list;
  return [...list, next].sort(byFullPath);
}

/**
 * List the objects + synthetic folders directly under `path` :
 * `listAll` over the package's sandbox Storage handle. Read-via-get,
 * not realtime: the list updates on `refresh`, path change, or the
 * optimistic seam. Pass `''` (or the result of `usePathState`) for
 * the bucket root.
 *
 * `listAll` has no pagination; a very large prefix arrives as one flat
 * result (virtualize the rendering, which `<ObjectBrowser>` does).
 */
export function useStorageList(
  storage: FirebaseStorage | null | undefined,
  path: string,
): UseStorageListResult {
  // Injected: in-process `pyric/storage` by default, or the SharedWorker client
  // bundle in Studio served mode (via StorageApiProvider).
  const { listAll, ref: refFn } = useStorageApi();
  const normalized = normalizePath(path);
  const [state, setState] = useState<ListState>(() => ({
    status: storage == null ? 'idle' : 'loading',
    items: [],
    prefixes: [],
    error: undefined,
  }));
  const [tick, setTick] = useState(0);

  // What each `insertItem(fullPath)` call ACTUALLY inserted, keyed by the
  // normalized argument: the inserted row's fullPath, or null when the call
  // was a no-op (row already present). `removeItem` consults this to reverse
  // precisely; a fresh listing (server truth) clears the ledger.
  const optimisticInserts = useRef(new Map<string, string | null>());

  useEffect(() => {
    optimisticInserts.current.clear();
    if (storage == null) {
      setState({ status: 'idle', items: [], prefixes: [], error: undefined });
      return;
    }
    let cancelled = false;
    setState({ status: 'loading', items: [], prefixes: [], error: undefined });
    listAll(refFn(storage, normalized))
      .then((result) => {
        if (cancelled) return;
        setState({
          status: 'success',
          // Defensive copy + sort pins the invariant the optimistic seam
          // relies on even if the backing implementation changes.
          items: [...result.items].sort(byFullPath),
          prefixes: [...result.prefixes].sort(byFullPath),
          error: undefined,
        });
      })
      .catch((e) => {
        if (cancelled) return;
        setState({
          status: 'error',
          items: [],
          prefixes: [],
          error: e instanceof Error ? e : new Error(String(e)),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [storage, normalized, tick]);

  const refresh = useCallback(() => setTick((n) => n + 1), []);

  const insertItem = useCallback(
    (fullPath: string) => {
      if (storage == null) return;
      // Trailing slash = folder declaration (a `<path>/` placeholder
      // object surfaces as a prefix, never an item, same synthesis
      // `listAll` applies).
      const isFolder = fullPath.endsWith('/');
      const target = normalizePath(fullPath);
      const scanPrefix = normalized === '' ? '' : `${normalized}/`;
      if (!target.startsWith(scanPrefix) || target === normalized) return;
      const relative = target.slice(scanPrefix.length);
      const slashIdx = relative.indexOf('/');
      setState((prev) => {
        if (prev.status === 'idle') return prev;
        // Record what this call really adds (null = no-op) so removeItem can
        // reverse it precisely. Idempotent under StrictMode's double-invoke:
        // the same prev yields the same record.
        if (slashIdx === -1) {
          if (isFolder) {
            // Direct child folder.
            optimisticInserts.current.set(
              target,
              prev.prefixes.some((r) => r.fullPath === target) ? null : target,
            );
            return {
              ...prev,
              prefixes: insertSorted(prev.prefixes, refFn(storage, target)),
            };
          }
          // Direct child object.
          optimisticInserts.current.set(
            target,
            prev.items.some((r) => r.fullPath === target) ? null : target,
          );
          return { ...prev, items: insertSorted(prev.items, refFn(storage, target)) };
        }
        // Deeper descendant, surface its first segment as a folder,
        // exactly like listAll's synthesis.
        const folderPath = `${scanPrefix}${relative.slice(0, slashIdx)}`;
        optimisticInserts.current.set(
          target,
          prev.prefixes.some((r) => r.fullPath === folderPath) ? null : folderPath,
        );
        return {
          ...prev,
          prefixes: insertSorted(prev.prefixes, refFn(storage, folderPath)),
        };
      });
    },
    [storage, normalized],
  );

  const removeItem = useCallback((fullPath: string) => {
    const target = normalizePath(fullPath);
    const record = optimisticInserts.current.get(target);
    optimisticInserts.current.delete(target);
    // This path was optimistically inserted and the insert added nothing
    // (the row pre-existed) — there is nothing of ours to remove, and
    // removing by path would delete a server-truth row.
    if (record === null) return;
    // Reverse the exact row the insert created (a deep upload's synthesized
    // first-segment folder differs from the upload's own fullPath); fall
    // back to the path itself for plain optimistic deletes.
    const rowPath = record ?? target;
    setState((prev) => ({
      ...prev,
      items: prev.items.filter((r) => r.fullPath !== rowPath),
      prefixes: prev.prefixes.filter((r) => r.fullPath !== rowPath),
    }));
  }, []);

  const entries = useMemo<StorageListEntry[]>(
    () => [
      ...state.prefixes.map((p) => ({
        kind: 'folder' as const,
        name: p.name,
        fullPath: p.fullPath,
        ref: p,
      })),
      ...state.items.map((i) => ({
        kind: 'object' as const,
        name: i.name,
        fullPath: i.fullPath,
        ref: i,
      })),
    ],
    [state.prefixes, state.items],
  );

  return {
    status: state.status,
    items: state.items,
    prefixes: state.prefixes,
    entries,
    error: state.error,
    refresh,
    insertItem,
    removeItem,
  };
}
