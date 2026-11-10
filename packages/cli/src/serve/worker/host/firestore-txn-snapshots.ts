/**
 * Bounded per-Sandbox registry of pinned Firestore snapshots for in-flight
 * remote transaction attempts (`txnId`), providing intra-attempt snapshot
 * isolation across `getDoc` and `getDocs` before `txnCommit`.
 */

import type { Sandbox } from 'pyric/sandbox';
import { getInternalEnv } from 'pyric/sandbox/internal';

type PinnedSnapshot = Record<string, Record<string, unknown>>;

const MAX_PINNED_TXN_SNAPSHOTS = 128;

const pinnedBySandbox = new WeakMap<Sandbox, Map<string, PinnedSnapshot>>();

function snapshotsForSandbox(sandbox: Sandbox): Map<string, PinnedSnapshot> {
  const existing = pinnedBySandbox.get(sandbox);
  if (existing !== undefined) return existing;
  const map = new Map<string, PinnedSnapshot>();
  pinnedBySandbox.set(sandbox, map);
  sandbox.onEvent((event) => {
    if (event.kind === 'session_boundary') {
      map.clear();
    }
  });
  return map;
}

export function getOrCreatePinnedTxnSnapshot(
  sandbox: Sandbox,
  txnId: string,
): PinnedSnapshot {
  const map = snapshotsForSandbox(sandbox);
  const existing = map.get(txnId);
  if (existing !== undefined) return existing;
  if (map.size >= MAX_PINNED_TXN_SNAPSHOTS) {
    const oldestKey = map.keys().next().value;
    if (oldestKey !== undefined) map.delete(oldestKey);
  }
  const captured = getInternalEnv(sandbox).snapshot();
  map.set(txnId, captured);
  return captured;
}

export function releasePinnedTxnSnapshot(sandbox: Sandbox, txnId: string): void {
  pinnedBySandbox.get(sandbox)?.delete(txnId);
}
