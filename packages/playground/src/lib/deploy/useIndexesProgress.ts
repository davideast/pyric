/**
 * Poll the Firestore Admin API for the build status of pending
 * long-running index-create operations. Restores state from
 * localStorage on mount (so a refresh during a build doesn't lose
 * the poll), then ticks every `POLL_INTERVAL_MS` for every entry
 * still in `'CREATING'`. Pauses when the tab is hidden; resumes on
 * visibility.
 *
 * Reads pending ops from `./pendingIndexOps` — the same key the
 * per-track and orchestrating deploy hooks write to. When an entry
 * transitions to `'READY'` / `'NEEDS_REPAIR'` / `'failed'` /
 * `'NOT_FOUND'`, the persisted set is updated in place (entries
 * stay visible until the user explicitly clears completed ones).
 *
 * The user-facing surface is `entries` + `counts` for the headline.
 * `refresh()` forces an immediate poll without waiting for the
 * interval. `clearCompleted()` removes terminal entries from both
 * the persisted set and the in-memory view.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { firestore, type ProjectScope } from '@pyric/cli/deploy';

import { useAccessToken } from './useAccessToken';
import {
  readPendingOps,
  replacePendingOps,
  subscribePendingOpsChanges,
  type IndexOperationStatus,
  type IndexOperationState,
} from './pendingIndexOps';
import { useTargetProject } from './useTargetProject';

const POLL_INTERVAL_MS = 5_000;

const TERMINAL_STATES: ReadonlySet<IndexOperationState> = new Set([
  'READY',
  'NEEDS_REPAIR',
  'failed',
  'NOT_FOUND',
]);

function isTerminal(state: IndexOperationState): boolean {
  return TERMINAL_STATES.has(state);
}

export interface IndexProgressCounts {
  creating: number;
  ready: number;
  failed: number;
  total: number;
}

export interface UseIndexesProgressResult {
  entries: IndexOperationStatus[];
  counts: IndexProgressCounts;
  /** True while a poll cycle is in flight. */
  polling: boolean;
  /** Force an immediate poll. Idempotent if one is already in flight. */
  refresh: () => Promise<void>;
  /**
   * Remove entries in terminal states (READY / NEEDS_REPAIR / failed /
   * NOT_FOUND) from both the persisted set and the in-memory view.
   */
  clearCompleted: () => void;
}

export function useIndexesProgress(): UseIndexesProgressResult {
  const { target, ready: targetReady } = useTargetProject();
  const { signedIn, resolveToken } = useAccessToken();

  const [entries, setEntries] = useState<IndexOperationStatus[]>(() => readPendingOps());
  const [polling, setPolling] = useState<boolean>(false);

  // Latest entries + a poll-in-flight guard the interval closure reads
  // through refs (so it always sees fresh values without re-running
  // the effect every tick).
  const entriesRef = useRef<IndexOperationStatus[]>(entries);
  entriesRef.current = entries;
  const pollInFlight = useRef<boolean>(false);

  // Sync state when another surface updates localStorage (e.g. a fresh
  // deploy writes new pending ops via `writePendingOps`).
  useEffect(() => {
    const unsub = subscribePendingOpsChanges(() => {
      setEntries((prev) => mergeFreshFromStorage(prev, readPendingOps()));
    });
    return unsub;
  }, []);

  // Build the project scope inline — entries already carry their
  // operation names; we just need to know where to point getStatus.
  const scope: ProjectScope | null = useMemo(() => {
    if (!targetReady || !target || !signedIn) return null;
    return {
      projectId: target.projectId,
      resolveToken,
    };
  }, [target, targetReady, signedIn, resolveToken]);

  const runPoll = useCallback(async () => {
    if (pollInFlight.current) return;
    if (!scope) return;

    const creating = entriesRef.current.filter((e) => e.state === 'CREATING');
    if (creating.length === 0) return;

    pollInFlight.current = true;
    setPolling(true);

    try {
      const results = await Promise.all(
        creating.map((entry) =>
          firestore.indexes
            .getStatus(scope, entry.operationName)
            .then((outcome) => ({ entry, outcome }))
            .catch((e: unknown) => ({
              entry,
              outcome: {
                ok: false,
                code: 'unknown',
                message: e instanceof Error ? e.message : String(e),
              } as const,
            })),
        ),
      );

      const now = new Date().toISOString();
      const updates = new Map<string, IndexOperationStatus>();
      for (const { entry, outcome } of results) {
        updates.set(entry.operationName, applyOutcome(entry, outcome, now));
      }

      const next = entriesRef.current.map((e) => updates.get(e.operationName) ?? e);
      setEntries(next);
      // Persist so a refresh shows the latest known state.
      replacePendingOps(next);
    } finally {
      pollInFlight.current = false;
      setPolling(false);
    }
  }, [scope]);

  // The interval. Only runs when the tab is visible AND there are
  // pending entries AND the scope is ready.
  useEffect(() => {
    if (typeof window === 'undefined') return;

    let intervalId: ReturnType<typeof setInterval> | null = null;

    function startInterval() {
      if (intervalId !== null) return;
      intervalId = setInterval(() => {
        void runPoll();
      }, POLL_INTERVAL_MS);
    }
    function stopInterval() {
      if (intervalId === null) return;
      clearInterval(intervalId);
      intervalId = null;
    }

    function evaluate() {
      const hasPending = entriesRef.current.some((e) => e.state === 'CREATING');
      const visible = document.visibilityState === 'visible';
      if (hasPending && visible && scope) {
        startInterval();
      } else {
        stopInterval();
      }
    }

    evaluate();
    const onVisibility = () => evaluate();
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      stopInterval();
    };
    // We deliberately re-run this effect on `entries.length` changes
    // (new pending entries arrived; start the interval if it was
    // stopped) and when `scope` flips (sign-in toggled).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, entries.length, runPoll]);

  // First-paint poll when the scope becomes ready and there are
  // pending entries — gives the user fresh state immediately rather
  // than waiting up to POLL_INTERVAL_MS.
  useEffect(() => {
    if (!scope) return;
    if (entriesRef.current.some((e) => e.state === 'CREATING')) {
      void runPoll();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);

  const refresh = useCallback(async () => {
    await runPoll();
  }, [runPoll]);

  const clearCompleted = useCallback(() => {
    const remaining = entriesRef.current.filter((e) => !isTerminal(e.state));
    setEntries(remaining);
    replacePendingOps(remaining);
  }, []);

  const counts: IndexProgressCounts = useMemo(() => {
    let creating = 0;
    let ready = 0;
    let failed = 0;
    for (const e of entries) {
      if (e.state === 'CREATING') creating += 1;
      else if (e.state === 'READY') ready += 1;
      else failed += 1;
    }
    return { creating, ready, failed, total: entries.length };
  }, [entries]);

  return { entries, counts, polling, refresh, clearCompleted };
}

// ─── Helpers ─────────────────────────────────────────────────────────

type GetStatusOutcome = Awaited<ReturnType<typeof firestore.indexes.getStatus>>;

function applyOutcome(
  entry: IndexOperationStatus,
  outcome: GetStatusOutcome,
  now: string,
): IndexOperationStatus {
  if (outcome.ok) {
    return {
      ...entry,
      state: outcome.state,
      lastPolledAt: now,
      ...(outcome.state === 'READY' ? { error: undefined } : {}),
    };
  }
  return {
    ...entry,
    state: 'failed',
    lastPolledAt: now,
    error: `${outcome.code}: ${outcome.message}`,
  };
}

/**
 * Merge a fresh localStorage snapshot into the current in-memory set:
 * - Entries present in storage but not in memory → add (fresh).
 * - Entries present in memory but not in storage → drop (external
 *   removal).
 * - Entries present in both → keep the in-memory version (it may have
 *   a more recent polled state).
 */
function mergeFreshFromStorage(
  current: IndexOperationStatus[],
  storage: IndexOperationStatus[],
): IndexOperationStatus[] {
  const currentByName = new Map(current.map((e) => [e.operationName, e] as const));
  const storageNames = new Set(storage.map((e) => e.operationName));

  // Drop externally-removed entries.
  const kept = current.filter((e) => storageNames.has(e.operationName));
  // Add new entries from storage.
  for (const s of storage) {
    if (!currentByName.has(s.operationName)) kept.push(s);
  }
  return kept;
}
