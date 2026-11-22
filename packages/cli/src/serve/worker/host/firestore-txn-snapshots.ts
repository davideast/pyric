/**
 * Bounded per-Sandbox registry of pinned Firestore snapshots for in-flight
 * remote transaction attempts (`txnId`), providing intra-attempt snapshot
 * isolation across `getDoc` and `getDocs` before `txnCommit`.
 */

import { FirebaseError } from 'pyric/app';
import {
  DEFAULT_FIRESTORE_DATABASE,
  getDatabaseEnv,
  normalizeFirestoreDatabaseId,
} from 'pyric/firestore/internal';
import type { Sandbox } from 'pyric/sandbox';

type PinnedSnapshot = Record<string, Record<string, unknown>>;

interface PinnedTxnEntry {
  readonly databaseId: string;
  readonly snapshot: PinnedSnapshot;
}

const MAX_PINNED_TXN_SNAPSHOTS = 128;

const pinnedBySandbox = new WeakMap<Sandbox, Map<string, PinnedTxnEntry>>();

function snapshotsForSandbox(sandbox: Sandbox): Map<string, PinnedTxnEntry> {
  const existing = pinnedBySandbox.get(sandbox);
  if (existing !== undefined) return existing;
  const map = new Map<string, PinnedTxnEntry>();
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
  databaseId?: string,
): PinnedSnapshot {
  const normalizedDb = normalizeFirestoreDatabaseId(databaseId);
  const map = snapshotsForSandbox(sandbox);
  const existing = map.get(txnId);
  if (existing !== undefined) {
    if (existing.databaseId !== normalizedDb) {
      throw new FirebaseError(
        'invalid-argument',
        'Provided document reference is from a different Firestore instance.',
      );
    }
    return existing.snapshot;
  }
  if (map.size >= MAX_PINNED_TXN_SNAPSHOTS) {
    const oldestKey = map.keys().next().value;
    if (oldestKey !== undefined) map.delete(oldestKey);
  }
  const captured = getDatabaseEnv(sandbox, normalizedDb).snapshot();
  map.set(txnId, { databaseId: normalizedDb, snapshot: captured });
  return captured;
}

export function releasePinnedTxnSnapshot(
  sandbox: Sandbox,
  txnId: string,
  databaseId?: string,
): void {
  const map = pinnedBySandbox.get(sandbox);
  if (map === undefined) return;
  const existing = map.get(txnId);
  if (existing === undefined) return;
  if (databaseId !== undefined) {
    const normalizedDb = normalizeFirestoreDatabaseId(databaseId);
    if (existing.databaseId !== normalizedDb && normalizedDb !== DEFAULT_FIRESTORE_DATABASE) {
      map.delete(txnId);
      throw new FirebaseError(
        'invalid-argument',
        'Provided document reference is from a different Firestore instance.',
      );
    }
  }
  map.delete(txnId);
}
