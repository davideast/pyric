/**
 * Session-scoped observed data sidecar for `@pyric/live`.
 *
 * Stored in a `WeakMap` keyed by `LiveCallRecord` rather than as an enumerable
 * property on `LiveCallRecord` so `LiveCallRecord` retains its exact structural
 * shape and `JSON.stringify(records)` never leaks batch/listener payloads.
 * Only `pageObserver` reads this sidecar when forwarding successful client-SDK
 * calls to the live host's in-memory session store.
 *
 * Also the one place a delta is assembled: `sessionDeltaOf` and
 * `skipCountsOf` leave out empty op lists and zero counts, as a host reads
 * them.
 */
import type {
  ObservedFirestoreSessionOp,
  ObservedRtdbSessionOp,
  ObservedSessionDelta,
  ObservedSessionSkipCounts,
  ObservedStorageListItem,
  ObservedStorageObjectInput,
  ObservedStorageSessionOp,
} from '@pyric/cli/vite/internal/supplied-rows';
import type { LiveCallOutcome, LiveCallRecord } from './observe.js';

export type {
  ObservedFirestoreSessionOp,
  ObservedRtdbSessionOp,
  ObservedSessionDelta,
  ObservedSessionSkipCounts,
  ObservedStorageListItem,
  ObservedStorageObjectInput,
  ObservedStorageSessionOp,
};

/** Why an observed value was left out of a delta. */
export type SessionSkipReason = 'oversized' | 'unsupported' | 'truncated';

/** The parts a delta is assembled from; any may be absent or empty. */
export interface SessionDeltaParts {
  readonly firestore?: readonly ObservedFirestoreSessionOp[];
  readonly rtdb?: readonly ObservedRtdbSessionOp[];
  readonly storage?: readonly ObservedStorageSessionOp[];
  readonly skipped?: ObservedSessionSkipCounts;
}

const RECORD_SESSION_DATA = new WeakMap<LiveCallRecord, ObservedSessionDelta>();

/** Skip counts with each zero count left out, or undefined when all are zero. */
export function skipCountsOf(oversized: number, unsupported: number, truncated: number): ObservedSessionSkipCounts | undefined {
  if (oversized === 0 && unsupported === 0 && truncated === 0) return undefined;
  const counts: { oversized?: number; unsupported?: number; truncated?: number } = {};
  if (oversized > 0) counts.oversized = oversized;
  if (unsupported > 0) counts.unsupported = unsupported;
  if (truncated > 0) counts.truncated = truncated;
  return counts;
}

/** A delta with each empty op list and absent skip count left out, or undefined when nothing is left. */
export function sessionDeltaOf(parts: SessionDeltaParts): ObservedSessionDelta | undefined {
  const delta: {
    firestore?: readonly ObservedFirestoreSessionOp[];
    rtdb?: readonly ObservedRtdbSessionOp[];
    storage?: readonly ObservedStorageSessionOp[];
    skipped?: ObservedSessionSkipCounts;
  } = {};
  if (parts.firestore !== undefined && parts.firestore.length > 0) delta.firestore = parts.firestore;
  if (parts.rtdb !== undefined && parts.rtdb.length > 0) delta.rtdb = parts.rtdb;
  if (parts.storage !== undefined && parts.storage.length > 0) delta.storage = parts.storage;
  if (parts.skipped !== undefined) delta.skipped = parts.skipped;
  if (Object.keys(delta).length === 0) return undefined;
  return delta;
}

/** A delta that only counts one value left out. */
export function skipDeltaOf(reason: SessionSkipReason): ObservedSessionDelta {
  return { skipped: { [reason]: 1 } };
}

function hasAnySkips(skipped: ObservedSessionSkipCounts | undefined): boolean {
  if (skipped === undefined) return false;
  return (skipped.oversized ?? 0) > 0 || (skipped.unsupported ?? 0) > 0 || (skipped.truncated ?? 0) > 0;
}

function mergeSkipCounts(
  first: ObservedSessionSkipCounts | undefined,
  second: ObservedSessionSkipCounts | undefined,
): ObservedSessionSkipCounts | undefined {
  const oversized = (first?.oversized ?? 0) + (second?.oversized ?? 0);
  const unsupported = (first?.unsupported ?? 0) + (second?.unsupported ?? 0);
  const truncated = (first?.truncated ?? 0) + (second?.truncated ?? 0);
  return skipCountsOf(oversized, unsupported, truncated);
}

function hasAnyOps(delta: ObservedSessionDelta | undefined): delta is ObservedSessionDelta {
  if (delta === undefined) return false;
  return (
    (delta.firestore?.length ?? 0) > 0 ||
    (delta.rtdb?.length ?? 0) > 0 ||
    (delta.storage?.length ?? 0) > 0 ||
    hasAnySkips(delta.skipped)
  );
}

export function attachSessionData(
  record: LiveCallRecord,
  delta: ObservedSessionDelta | undefined,
): void {
  if (!hasAnyOps(delta)) return;
  RECORD_SESSION_DATA.set(record, delta);
}

export function sessionDataOf(record: LiveCallRecord): ObservedSessionDelta | undefined {
  return RECORD_SESSION_DATA.get(record);
}

/** Attaches resolved or listener-delivered session data onto `record` without failing the observer. */
export function attachOutcomeSessionData<
  S extends {
    readonly sessionData?: ObservedSessionDelta;
    readonly deliveryOf?: (site: S, value: unknown) => ObservedSessionDelta | undefined;
  },
>(record: LiveCallRecord, site: S, outcome: LiveCallOutcome, value?: unknown): void {
  if (outcome === 'resolved') {
    attachSessionData(record, site.sessionData);
    return;
  }
  if (outcome === 'delivered' && site.deliveryOf !== undefined) {
    try {
      attachSessionData(record, site.deliveryOf(site, value));
    } catch {
      // A delivery hook failure never drops the record.
    }
  }
}

function concatLists<T>(first: readonly T[] | undefined, second: readonly T[] | undefined): T[] {
  const out: T[] = [];
  if (first !== undefined) out.push(...first);
  if (second !== undefined) out.push(...second);
  return out;
}

export function mergeSessionData(
  first: ObservedSessionDelta | undefined,
  second: ObservedSessionDelta | undefined,
): ObservedSessionDelta | undefined {
  if (!hasAnyOps(first)) {
    if (hasAnyOps(second)) return second;
    return undefined;
  }
  if (!hasAnyOps(second)) return first;
  return sessionDeltaOf({
    firestore: concatLists(first.firestore, second.firestore),
    rtdb: concatLists(first.rtdb, second.rtdb),
    storage: concatLists(first.storage, second.storage),
    skipped: mergeSkipCounts(first.skipped, second.skipped),
  });
}
