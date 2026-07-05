import { useCallback, useRef, useState } from 'react';
import type { CollectionReference, DocumentReference } from 'pyric/firestore';

export interface RecursiveDeleteProgress {
  /** Total nodes deleted so far. */
  deletedCount: number;
  /** True for the final emission. */
  done: boolean;
}

/**
 * Implementation injected by the consumer. The library doesn't ship
 * one — sandbox-backed apps usually walk `@pyric/sandbox`'s in-process
 * tree; production apps usually call a Cloud Function. Either way,
 * `start` returns an async iterator emitting progress.
 */
export interface RecursiveDeleteImpl {
  start: (
    target: DocumentReference | CollectionReference,
  ) => AsyncIterableIterator<RecursiveDeleteProgress>;
}

export interface UseRecursiveDeleteResult {
  /** Run the delete. Resolves when the iterator signals `done`. */
  delete: (target: DocumentReference | CollectionReference) => Promise<void>;
  /** Number of nodes deleted in the current/last run. */
  progress: number;
  /** True while an iteration is in flight. */
  isRunning: boolean;
  /** Error thrown by the iterator, if any. Cleared at the start of
   *  the next call. */
  error: Error | undefined;
}

/**
 * Drive a {@link RecursiveDeleteImpl} from a React component. Tracks
 * progress + running state so the consumer can render a progress
 * indicator. Errors are caught and surfaced via the returned state,
 * not thrown.
 *
 * Stale-run protection: if the component remounts (or the user
 * cancels and starts a new run) before a previous iteration
 * finishes, the older run's progress updates are dropped via a
 * generation token.
 */
export function useRecursiveDelete(
  impl: RecursiveDeleteImpl,
): UseRecursiveDeleteResult {
  const [progress, setProgress] = useState(0);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<Error | undefined>(undefined);
  const generationRef = useRef(0);

  const del = useCallback(
    async (target: DocumentReference | CollectionReference) => {
      const myGen = ++generationRef.current;
      setProgress(0);
      setError(undefined);
      setIsRunning(true);
      try {
        for await (const evt of impl.start(target)) {
          if (myGen !== generationRef.current) return;
          setProgress(evt.deletedCount);
          if (evt.done) break;
        }
      } catch (e) {
        if (myGen !== generationRef.current) return;
        setError(e instanceof Error ? e : new Error(String(e)));
      } finally {
        if (myGen === generationRef.current) setIsRunning(false);
      }
    },
    [impl],
  );

  return { delete: del, progress, isRunning, error };
}
