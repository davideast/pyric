import { useCallback, useMemo, useState } from 'react';

/** Strip leading/trailing slashes and collapse repeats — mirrors
 *  `pyric/storage`'s reference normalization so `usePathState` and
 *  `useStorageList` always agree on what a path is. */
export function normalizeStoragePath(path: string): string {
  return path.split('/').filter(Boolean).join('/');
}

export interface UsePathStateOptions {
  /**
   * Controlled value. When provided, the hook derives everything
   * from it and navigation calls only fire `onPathChange` — the
   * owner owns the state (e.g. a router binding `?path=`).
   */
  path?: string;
  /** Fired with the normalized next path on every navigation. Called
   *  in both modes. */
  onPathChange?: (path: string) => void;
  /** Uncontrolled initial value. Default `''` (bucket root). */
  defaultPath?: string;
}

export interface UsePathStateResult {
  /** Current normalized path. `''` is the bucket root. */
  path: string;
  /** Path split into segments. `[]` at root. */
  segments: string[];
  /** Jump to an absolute path (normalized). */
  setPath: (path: string) => void;
  /** Descend into a child folder — accepts a bare name (`'sub'`) or
   *  an absolute path (`'docs/sub'`, e.g. a prefix's `fullPath`). */
  enter: (nameOrPath: string) => void;
  /** Ascend one level. No-op at root. */
  up: () => void;
  /**
   * Jump to the ancestor ending at `segments[index]` — the breadcrumb
   * click. `navigateToIndex(-1)` (or any negative) is the root.
   */
  navigateToIndex: (index: number) => void;
}

/**
 * Path navigation state for the storage browser. Controlled when
 * `path` is provided (the owner re-renders with the next value),
 * uncontrolled otherwise — standard React value/defaultValue
 * semantics. All emitted paths are normalized (`normalizeStoragePath`).
 */
export function usePathState(
  options: UsePathStateOptions = {},
): UsePathStateResult {
  const { path: controlled, onPathChange, defaultPath = '' } = options;
  const isControlled = controlled !== undefined;
  const [internal, setInternal] = useState(() => normalizeStoragePath(defaultPath));
  const path = isControlled ? normalizeStoragePath(controlled) : internal;

  const setPath = useCallback(
    (next: string) => {
      const normalized = normalizeStoragePath(next);
      if (!isControlled) setInternal(normalized);
      onPathChange?.(normalized);
    },
    [isControlled, onPathChange],
  );

  const segments = useMemo(
    () => (path === '' ? [] : path.split('/')),
    [path],
  );

  const enter = useCallback(
    (nameOrPath: string) => {
      const target = normalizeStoragePath(nameOrPath);
      // An absolute descendant path (a prefix ref's fullPath) is used
      // as-is; a bare name appends to the current path.
      setPath(target.includes('/') || path === '' ? target : `${path}/${target}`);
    },
    [path, setPath],
  );

  const up = useCallback(() => {
    if (segments.length === 0) return;
    setPath(segments.slice(0, -1).join('/'));
  }, [segments, setPath]);

  const navigateToIndex = useCallback(
    (index: number) => {
      setPath(index < 0 ? '' : segments.slice(0, index + 1).join('/'));
    },
    [segments, setPath],
  );

  return { path, segments, setPath, enter, up, navigateToIndex };
}
