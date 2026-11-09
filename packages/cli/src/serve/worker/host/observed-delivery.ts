/**
 * Builds validated `ObservedDeliverySummary` metadata from an observed listener
 * delivery's `ObservedSessionDelta` without persisting field values.
 *
 * Always validates raw `sessionData` through `readObservedSessionDelta` first
 * so path length limits, segment rules, and JSON bounds are enforced even when
 * `handleObserve` is called directly.
 */
import type { ObservedCall, ObservedDeliverySummary } from 'pyric/sandbox';
import { MAX_OBSERVED_DELIVERY_PATHS, trimObservedPath } from 'pyric/sandbox/internal';
import {
  MAX_PATH_LENGTH,
  readObservedSessionDelta,
  RTDB_FORBIDDEN_SEGMENT,
} from '../../observed-session/delta-validation.js';
import { FORBIDDEN_KEYS } from '../../observed-session/json-values.js';
import type { ObservedSessionDelta } from '../../observed-session/wire.js';

const RTDB_CHILD_LISTENER_METHODS = new Set([
  'onChildAdded',
  'onChildChanged',
  'onChildRemoved',
  'onChildMoved',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toSafeRtdbChildPath(parentPath: string, key: string): string {
  if (
    key.length === 0 ||
    key.includes('/') ||
    FORBIDDEN_KEYS.has(key) ||
    RTDB_FORBIDDEN_SEGMENT.test(key)
  ) {
    return '';
  }
  const joined = trimObservedPath(parentPath === '' ? key : `${parentPath}/${key}`);
  if (joined.length > MAX_PATH_LENGTH) return '';
  return joined;
}

function validatedDelta(raw: unknown): ObservedSessionDelta | undefined {
  if (raw === undefined) return undefined;
  try {
    return readObservedSessionDelta(raw);
  } catch {
    return undefined;
  }
}

function summarizeFirestoreDelivery(
  call: ObservedCall,
  ops: NonNullable<ObservedSessionDelta['firestore']>,
): ObservedDeliverySummary {
  const paths: string[] = [];
  const removedPaths: string[] = [];
  let addedOrModified = 0;
  for (const op of ops) {
    const clean = trimObservedPath(op.path);
    if (clean === '') continue;
    if (op.kind === 'set' || op.kind === 'update') {
      addedOrModified += 1;
      if (paths.length < MAX_OBSERVED_DELIVERY_PATHS) paths.push(clean);
    } else if (op.kind === 'delete' || op.kind === 'invalidate') {
      if (removedPaths.length < MAX_OBSERVED_DELIVERY_PATHS) removedPaths.push(clean);
    }
  }
  let uncappedSize = addedOrModified;
  if (addedOrModified > 0 && call.billedDocuments !== undefined) {
    uncappedSize = Math.max(addedOrModified, call.billedDocuments);
  }
  const summary: ObservedDeliverySummary = {
    mode: 'delta',
    size: uncappedSize,
    paths,
  };
  if (removedPaths.length > 0) {
    return { ...summary, removedPaths };
  }
  return summary;
}

function summarizeRtdbDelivery(
  call: ObservedCall,
  ops: NonNullable<ObservedSessionDelta['rtdb']>,
): ObservedDeliverySummary | undefined {
  const op = ops.find((entry) => entry.kind === 'set' || entry.kind === 'update') ?? ops[0];
  if (op === undefined) return undefined;
  const cleanPath = trimObservedPath(op.path);

  const hasNoSnapshotValue = op.kind === 'remove' || op.kind === 'invalidate';
  if (RTDB_CHILD_LISTENER_METHODS.has(call.method)) {
    if (cleanPath === '') return { mode: 'delta', size: 0, paths: [] };
    const isChildRemoval = call.method === 'onChildRemoved' || hasNoSnapshotValue;
    if (isChildRemoval) {
      return { mode: 'delta', size: 0, paths: [], removedPaths: [cleanPath] };
    }
    return { mode: 'delta', size: 1, paths: [cleanPath] };
  }

  if (hasNoSnapshotValue) return { mode: 'snapshot', size: 0, paths: [] };
  if (op.value === null || op.value === undefined) {
    return { mode: 'snapshot', size: 0, paths: [] };
  }
  if (isRecord(op.value)) {
    const keys = Object.keys(op.value);
    const paths: string[] = [];
    for (const key of keys) {
      if (paths.length >= MAX_OBSERVED_DELIVERY_PATHS) break;
      const childPath = toSafeRtdbChildPath(cleanPath, key);
      if (childPath !== '') paths.push(childPath);
    }
    return {
      mode: 'snapshot',
      size: keys.length,
      paths,
    };
  }
  return { mode: 'snapshot', size: 1, paths: cleanPath === '' ? [] : [cleanPath] };
}

/**
 * Derive a path-only `ObservedDeliverySummary` for a live listener delivery,
 * or `undefined` when `rawSessionData` is absent, skipped, or invalid.
 */
export function observedDeliverySummaryOf(
  call: ObservedCall,
  rawSessionData: unknown,
): ObservedDeliverySummary | undefined {
  if (call.outcome.status !== 'ok' || call.sdk === 'admin') return undefined;
  const delta = validatedDelta(rawSessionData);
  if (delta === undefined) return undefined;
  if (call.service === 'firestore' && Array.isArray(delta.firestore)) {
    return summarizeFirestoreDelivery(call, delta.firestore);
  }
  if (call.service === 'rtdb' && Array.isArray(delta.rtdb) && delta.rtdb.length > 0) {
    return summarizeRtdbDelivery(call, delta.rtdb);
  }
  return undefined;
}
