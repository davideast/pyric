import type { SdkActivityHandle } from '../sandbox/internal/sdk-activity.js';
import type { ListenerRegistry, ListenerRegistration } from './listener-registry.js';
import { jsonValuesEqual, type JsonValue } from './sandbox/data-tree.js';
import { targetOf } from './routing.js';
import { isDefaultQuerySpec, queryIdentifier } from './query-shape.js';
import { executeQuery, extractOrderValue, type QueryRow, type QuerySpec } from './internal/query-projection.js';
import type { DataSnapshot, DatabaseReference, Query, Unsubscribe } from './types.js';
import { child } from './references.js';
import { buildSandboxQuerySnap, buildSandboxSnapFromRaw } from './snapshots.js';

export type ChildEvent = 'child_added' | 'child_changed' | 'child_removed' | 'child_moved';

/**
 * Observe `/.info` or `/.info/connected` for `onValue`, applying any query
 * constraints on `/.info` before synthesizing the snapshot.
 */
export function observeConnectionMetadata(
  listenerRegistry: ListenerRegistry,
  query: Query,
  callback: (snapshot: DataSnapshot) => void,
  registryCallback: (snapshot: DataSnapshot) => void,
  activity: SdkActivityHandle,
): Unsubscribe {
  const reference = query.ref;
  const target = targetOf(reference);
  const isMetadataRoot = reference._path === '/.info';
  const scope = queryIdentifier(query._spec);
  const hasConstraints = !isDefaultQuerySpec(query._spec);
  let stopped = false;
  let stopObserving: Unsubscribe = () => {};
  let release: Unsubscribe | undefined;
  let previousRows: QueryRow[] | undefined;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    stopObserving();
    release?.();
    listenerRegistry.removeExact(target, reference._path, 'value', registryCallback, registration, scope);
    activity.close();
  };
  const registration: ListenerRegistration = { unsubscribe: stop };
  listenerRegistry.add(target, reference._path, 'value', registryCallback, registration, scope);
  const hasAppLifetime = target.kind === 'sandbox-live';
  if (hasAppLifetime) release = target.own?.(stop);
  stopObserving = target.connection.observeConnection((connected) => {
    if (stopped) return;
    const value = isMetadataRoot ? { connected, serverTimeOffset: 0 } : connected;
    const filtersChildren = isMetadataRoot && hasConstraints;
    let snapshot: DataSnapshot;
    if (filtersChildren) {
      const rows = executeQuery(value, query._spec);
      const isUnchangedSelection = jsonValuesEqual(previousRows, rows);
      if (isUnchangedSelection) return;
      previousRows = rows;
      snapshot = buildSandboxQuerySnap(target, reference, rows);
    } else {
      snapshot = buildSandboxSnapFromRaw(target, reference, value);
    }
    try {
      callback(snapshot);
    } catch {
      // Match ordinary RTDB listener isolation.
    }
  });
  if (stopped) stopObserving();
  return stop;
}

/**
 * Observe `/.info/*` for the four `onChild*` listener variants, diffing the
 * projected child window across connection transitions.
 */
export function observeConnectionChildMetadata(
  listenerRegistry: ListenerRegistry,
  baseRef: DatabaseReference,
  spec: QuerySpec | undefined,
  event: ChildEvent,
  cb: (snap: DataSnapshot, previousChildName: string | null) => void,
  registryCallback: typeof cb,
  activity: SdkActivityHandle,
  scope: string | undefined,
): Unsubscribe {
  const target = targetOf(baseRef as unknown as object);
  const isMetadataRoot = baseRef._path === '/.info';
  let stopped = false;
  let stopObserving: Unsubscribe = () => {};
  let release: Unsubscribe | undefined;
  let initialized = false;
  let previous: QueryRow[] = [];
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    stopObserving();
    release?.();
    listenerRegistry.removeExact(target, baseRef._path, event, registryCallback, registration, scope);
    activity.close();
  };
  const registration: ListenerRegistration = { unsubscribe: stop };
  listenerRegistry.add(target, baseRef._path, event, registryCallback, registration, scope);
  if (target.kind === 'sandbox-live') release = target.own?.(stop);
  const activeSpec: QuerySpec = spec ?? { orderBy: null, bounds: [], limit: null };
  const emit = (row: QueryRow, previousChildName: string | null): void => {
    const childRef = child(baseRef, row.key);
    const snap = buildSandboxSnapFromRaw(target, childRef, row.value);
    try {
      cb(snap, event === 'child_removed' ? null : previousChildName);
    } catch {
      // Match ordinary RTDB listener isolation.
    }
  };
  stopObserving = target.connection.observeConnection((connected) => {
    if (stopped) return;
    const rawValue: JsonValue = isMetadataRoot ? { connected, serverTimeOffset: 0 } : null;
    const current = rawValue !== null ? executeQuery(rawValue, activeSpec) : [];
    if (!initialized) {
      initialized = true;
      if (event === 'child_added') {
        for (let i = 0; i < current.length; i++) {
          emit(current[i]!, current[i - 1]?.key ?? null);
        }
      }
      previous = current;
      return;
    }
    const previousByKey = new Map(previous.map((row) => [row.key, row]));
    const currentByKey = new Map(current.map((row) => [row.key, row]));
    if (event === 'child_removed') {
      for (const prior of previous) {
        if (!currentByKey.has(prior.key)) emit(prior, null);
      }
    } else {
      for (let i = 0; i < current.length; i++) {
        const row = current[i]!;
        const prior = previousByKey.get(row.key);
        const previousChildName = current[i - 1]?.key ?? null;
        if (event === 'child_added' && !prior) emit(row, previousChildName);
        if (event === 'child_changed' && prior && !jsonValuesEqual(prior.value, row.value)) {
          emit(row, previousChildName);
        }
        if (event === 'child_moved' && prior && activeSpec.orderBy && activeSpec.orderBy.kind !== 'key') {
          const before = extractOrderValue(activeSpec.orderBy, prior.key, prior.value, prior.priority);
          const after = extractOrderValue(activeSpec.orderBy, row.key, row.value, row.priority);
          if (!jsonValuesEqual(before, after)) emit(row, previousChildName);
        }
      }
    }
    previous = current;
  });
  if (stopped) stopObserving();
  return stop;
}
