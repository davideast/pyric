import { useCallback, useMemo, useState } from 'react';

/**
 * What the selection tracks per row — a structural subset of
 * `StorageListEntry`, so `useStorageList`'s entries pass straight
 * in. The `kind` decides the delete verb later (object →
 * `deleteObject`, folder → recursive).
 */
export interface StorageSelectionEntry {
  kind: 'folder' | 'object';
  fullPath: string;
}

export interface UseStorageSelectionResult {
  /** Selected entries in selection order. */
  selected: StorageSelectionEntry[];
  size: number;
  isSelected: (fullPath: string) => boolean;
  /** Add/remove — the checkbox verb. */
  toggle: (entry: StorageSelectionEntry) => void;
  select: (entry: StorageSelectionEntry) => void;
  deselect: (fullPath: string) => void;
  /** Replace the selection (e.g. a "select all" over
   *  `list.entries`). */
  selectAll: (entries: StorageSelectionEntry[]) => void;
  clear: () => void;
}

/**
 * Multi-select state over storage rows, keyed by `fullPath`.
 * Deliberately dumb: it doesn't watch the list, so clear it on path
 * change (or after a bulk op via the delete hook's outcome) — the
 * consumer owns that policy.
 */
export function useStorageSelection(): UseStorageSelectionResult {
  const [map, setMap] = useState<Map<string, StorageSelectionEntry>>(
    () => new Map(),
  );

  const isSelected = useCallback(
    (fullPath: string) => map.has(fullPath),
    [map],
  );

  const select = useCallback((entry: StorageSelectionEntry) => {
    setMap((prev) => {
      if (prev.has(entry.fullPath)) return prev;
      const next = new Map(prev);
      next.set(entry.fullPath, entry);
      return next;
    });
  }, []);

  const deselect = useCallback((fullPath: string) => {
    setMap((prev) => {
      if (!prev.has(fullPath)) return prev;
      const next = new Map(prev);
      next.delete(fullPath);
      return next;
    });
  }, []);

  const toggle = useCallback((entry: StorageSelectionEntry) => {
    setMap((prev) => {
      const next = new Map(prev);
      if (next.has(entry.fullPath)) next.delete(entry.fullPath);
      else next.set(entry.fullPath, entry);
      return next;
    });
  }, []);

  const selectAll = useCallback((entries: StorageSelectionEntry[]) => {
    setMap(new Map(entries.map((e) => [e.fullPath, e])));
  }, []);

  const clear = useCallback(() => setMap(new Map()), []);

  const selected = useMemo(() => [...map.values()], [map]);

  return {
    selected,
    size: map.size,
    isSelected,
    toggle,
    select,
    deselect,
    selectAll,
    clear,
  };
}
