import { useCallback, useRef, useState } from 'react';
import {
  deleteObject,
  listAll,
  ref as refFn,
  type FirebaseStorage,
  type StorageReference,
} from 'pyric/storage';
import { folderPlaceholderRef } from '../folderPlaceholder.js';
import type { StorageSelectionEntry } from './useStorageSelection.js';
import type { UseStorageListResult } from './useStorageList.js';

export interface StorageDeleteProgress {
  /** Objects deleted so far in this folder walk. */
  deletedCount: number;
  /** True for the final emission. */
  done: boolean;
}

/**
 * Recursive folder delete implementation — the same injection seam
 * as the Firestore half's `RecursiveDeleteImpl`. Unlike Firestore
 * (where tree-walking needs sandbox introspection or a Cloud
 * Function), the public storage surface CAN walk a prefix, so the
 * package ships {@link createListAllDeleteImpl} as the default;
 * inject your own for server-driven deletes.
 */
export interface StorageRecursiveDeleteImpl {
  start: (
    target: StorageReference,
  ) => AsyncIterableIterator<StorageDeleteProgress>;
}

/**
 * The default, `listAll`-driven impl: walks the prefix tree,
 * `deleteObject`s every item (yielding progress per object), then
 * sweeps each visited folder's `<path>/` placeholder so emptied
 * create-folder folders disappear too (`listAll` hides placeholders,
 * so the walk alone would leave ghost folders). Placeholder sweeps
 * are best-effort — `deletedCount` counts listed objects only.
 */
export function createListAllDeleteImpl(): StorageRecursiveDeleteImpl {
  return {
    async *start(target: StorageReference) {
      let deletedCount = 0;
      const stack: StorageReference[] = [target];
      const visited: StorageReference[] = [];
      while (stack.length > 0) {
        const folder = stack.pop()!;
        visited.push(folder);
        const result = await listAll(folder);
        stack.push(...result.prefixes);
        for (const item of result.items) {
          await deleteObject(item);
          deletedCount++;
          yield { deletedCount, done: false };
        }
      }
      for (const folder of visited) {
        try {
          await deleteObject(folderPlaceholderRef(folder.storage, folder.fullPath));
        } catch {
          // Best-effort: prod targets reject structural refs and a
          // strict backend may throw not-found — neither should fail
          // the delete that already succeeded.
        }
      }
      yield { deletedCount, done: true };
    },
  };
}

/** One entry's failure in a bulk run. `error` is the typed
 *  `StorageError` (`.code` e.g. `storage/unauthorized`). */
export interface StorageDeleteFailure {
  fullPath: string;
  error: Error;
}

export interface StorageDeleteOutcome {
  /** fullPaths of entries fully deleted. */
  deleted: string[];
  failed: StorageDeleteFailure[];
}

export interface UseStorageDeleteOptions {
  /** Folder-walk implementation. Default {@link createListAllDeleteImpl}. */
  impl?: StorageRecursiveDeleteImpl;
  /**
   * Optimistic seam from `useStorageList`: entries vanish from the
   * local list immediately and roll back (object → item, folder →
   * trailing-slash prefix insert) on failure.
   */
  list?: Pick<UseStorageListResult, 'insertItem' | 'removeItem'>;
}

export interface UseStorageDeleteResult {
  /**
   * Delete a mixed object/folder selection (objects via
   * `deleteObject`, folders via the recursive impl), sequentially in
   * selection order. Resolves with the outcome and never rejects —
   * per-entry failures land in `outcome.failed` (and `error` keeps
   * the first one for simple renders).
   */
  deleteEntries: (
    entries: StorageSelectionEntry[],
  ) => Promise<StorageDeleteOutcome>;
  /** Objects deleted in the current/last run (folder walks included). */
  progress: number;
  isRunning: boolean;
  /** First failure of the current/last run. Cleared on the next call. */
  error: Error | undefined;
}

/**
 * Drive bulk + recursive deletes from a React component — the
 * storage counterpart of `useRecursiveDelete` (same progress /
 * isRunning / error shape, same stale-run generation token), bulk
 * because storage selections are flat multi-row affairs.
 */
export function useStorageDelete(
  storage: FirebaseStorage | null | undefined,
  options: UseStorageDeleteOptions = {},
): UseStorageDeleteResult {
  const [progress, setProgress] = useState(0);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<Error | undefined>(undefined);
  const generationRef = useRef(0);
  // Latest-value ref so `deleteEntries` stays stable across option
  // identity changes (house pattern).
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const deleteEntries = useCallback(
    async (entries: StorageSelectionEntry[]): Promise<StorageDeleteOutcome> => {
      const myGen = ++generationRef.current;
      setProgress(0);
      setError(undefined);
      const outcome: StorageDeleteOutcome = { deleted: [], failed: [] };
      if (storage == null || entries.length === 0) return outcome;
      setIsRunning(true);
      const impl = optionsRef.current.impl ?? createListAllDeleteImpl();
      let count = 0;
      try {
        for (const entry of entries) {
          // Optimistic removal — the row vanishes immediately.
          optionsRef.current.list?.removeItem(entry.fullPath);
          try {
            if (entry.kind === 'object') {
              await deleteObject(refFn(storage, entry.fullPath));
              count++;
            } else {
              for await (const evt of impl.start(refFn(storage, entry.fullPath))) {
                if (myGen !== generationRef.current) return outcome;
                // The impl reports counts local to its walk; add the
                // objects already deleted by earlier entries.
                setProgress(count + evt.deletedCount);
                if (evt.done) {
                  count += evt.deletedCount;
                  break;
                }
              }
            }
            outcome.deleted.push(entry.fullPath);
            if (myGen === generationRef.current) setProgress(count);
          } catch (e) {
            const err = e instanceof Error ? e : new Error(String(e));
            outcome.failed.push({ fullPath: entry.fullPath, error: err });
            // Roll the optimistic removal back: objects re-insert as
            // items, folders as trailing-slash prefixes.
            optionsRef.current.list?.insertItem(
              entry.kind === 'folder' ? `${entry.fullPath}/` : entry.fullPath,
            );
            if (myGen === generationRef.current && outcome.failed.length === 1) {
              setError(err);
            }
          }
        }
        return outcome;
      } finally {
        if (myGen === generationRef.current) setIsRunning(false);
      }
    },
    [storage],
  );

  return { deleteEntries, progress, isRunning, error };
}
