/** RTDB value/child listeners over the worker port. */
import type { InboundMessage } from "../protocol.js";
import {
  _defaultLens,
  closeSubscription,
  nextSubId,
  openSnapshotSubscription,
  stampIssuer,
} from "./core.js";
import type { RtdbDataSnapshot, RtdbRefHandle, Unsubscribe } from "./handles.js";
import { rtdbChild, targetParts, type RtdbTarget } from "./rtdb-references.js";
import {
  hydrateRtdbSnapshot,
  makeRtdbSnapshot,
  valueAt,
  type RtdbWireEntry,
} from "./rtdb-snapshots.js";

export function rtdbOnValue(
  target: RtdbTarget,
  next: (snap: RtdbDataSnapshot) => void,
  cancelCallbackOrOptions?: ((err: unknown) => void) | { readonly onlyOnce?: boolean },
  options?: { readonly onlyOnce?: boolean },
): Unsubscribe {
  const { ref: r, query } = targetParts(target);
  const error = typeof cancelCallbackOrOptions === 'function' ? cancelCallbackOrOptions : undefined;
  const listenOptions = typeof cancelCallbackOrOptions === 'function'
    ? options
    : cancelCallbackOrOptions;
  const subId = nextSubId();
  const msg: InboundMessage = _defaultLens
    ? { t: 'sub', subId, target: { service: 'rtdb', path: r.path, ...(query ? { query } : {}) }, actAs: _defaultLens }
    : { t: 'sub', subId, target: { service: 'rtdb', path: r.path, ...(query ? { query } : {}) } };
  let fired = false;
  const opened = openSnapshotSubscription(r.port, subId, {
    port: r.port,
    next: (wire) => {
      if (listenOptions?.onlyOnce && fired) return;
      fired = true;
      if (listenOptions?.onlyOnce) closeSubscription(r.port, subId);
      next(hydrateRtdbSnapshot(r, wire));
    },
    error,
  }, stampIssuer(msg));
  if (!opened && error) queueMicrotask(() => error(new Error('FIREBASE FATAL ERROR: Database has been deleted.')));
  return () => {
    closeSubscription(r.port, subId);
  };
}

type ChildEventKind = 'added' | 'changed' | 'removed' | 'moved';

function directChildren(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) {
    return Object.fromEntries(
      value.flatMap((child, index) => child == null ? [] : [[String(index), child]]),
    );
  }
  if (value === null || typeof value !== 'object') return {};
  return value as Record<string, unknown>;
}

function sameRtdbValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) &&
      left.length === right.length && left.every((value, index) => sameRtdbValue(value, right[index]));
  }
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) =>
    key === rightKeys[index] && sameRtdbValue(leftRecord[key], rightRecord[key]));
}

function rtdbKeyCompare(left: string, right: string): number {
  const integerKey = (key: string): number | null => {
    if (!/^(0|[1-9]\d*)$/.test(key)) return null;
    const value = Number(key);
    return Number.isSafeInteger(value) && value <= 2_147_483_647 ? value : null;
  };
  const leftInteger = integerKey(left);
  const rightInteger = integerKey(right);
  if (leftInteger !== null && rightInteger !== null) return leftInteger - rightInteger;
  if (leftInteger !== null) return -1;
  if (rightInteger !== null) return 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

function rtdbOnChildEvent(
  target: RtdbTarget,
  kind: ChildEventKind,
  next: (snap: RtdbDataSnapshot, previousChildName: string | null) => void,
  error?: (err: unknown) => void,
): Unsubscribe {
  const { ref: r, query } = targetParts(target);
  let initialized = false;
  let previous: RtdbWireEntry[] = [];

  return rtdbOnValue(target, (parent) => {
    const current: RtdbWireEntry[] = [];
    parent.forEach((childSnap) => {
      if (childSnap.key !== null) {
        current.push({ key: childSnap.key, value: childSnap.val(), priority: childSnap.priority });
      }
    });
    // Plain snapshots produced by older hosts do not carry ordered entries.
    if (current.length === 0) {
      for (const key of Object.keys(directChildren(parent.val())).sort(rtdbKeyCompare)) {
        current.push({ key, value: directChildren(parent.val())[key] });
      }
    }
    if (!initialized) {
      initialized = true;
      if (kind === 'added') {
        for (let index = 0; index < current.length; index++) {
          const entry = current[index]!;
          next(
            makeRtdbSnapshot(rtdbChild(r, entry.key), entry.value, undefined, entry.priority ?? null),
            current[index - 1]?.key ?? null,
          );
        }
      }
      previous = current;
      return;
    }

    const previousByKey = new Map(previous.map((entry, index) => [entry.key, { entry, index }]));
    const currentByKey = new Map(current.map((entry, index) => [entry.key, { entry, index }]));
    const emit = (entry: RtdbWireEntry, previousChildName: string | null): void => {
      next(
        makeRtdbSnapshot(rtdbChild(r, entry.key), entry.value, undefined, entry.priority ?? null),
        previousChildName,
      );
    };

    if (kind === 'removed') {
      for (const prior of previous) {
        if (!currentByKey.has(prior.key)) {
          const priorIndex = previousByKey.get(prior.key)!.index;
          emit(prior, previous[priorIndex - 1]?.key ?? null);
        }
      }
    } else {
      for (let index = 0; index < current.length; index++) {
        const entry = current[index]!;
        const prior = previousByKey.get(entry.key);
        const previousChildName = current[index - 1]?.key ?? null;
        if (kind === 'added' && !prior) emit(entry, previousChildName);
        if (kind === 'changed' && prior && !sameRtdbValue(prior.entry.value, entry.value)) {
          emit(entry, previousChildName);
        }
        if (kind === 'moved' && prior) {
          const orderBy = query?.orderBy ?? { kind: 'priority' as const };
          const indexed = (candidate: RtdbWireEntry): unknown => {
            if (orderBy.kind === 'key') return candidate.key;
            if (orderBy.kind === 'priority') return candidate.priority ?? null;
            if (orderBy.kind === 'value') return candidate.value;
            return valueAt(candidate.value, orderBy.path);
          };
          // Production emits child_moved when the child's indexed value
          // changes, even when its predecessor remains the same.
          if (!sameRtdbValue(indexed(prior.entry), indexed(entry))) {
            emit(entry, previousChildName);
          }
        }
      }
    }
    previous = current;
  }, error);
}

/** Derives direct-child additions from the existing parent value stream. */
export function rtdbOnChildAdded(
  r: RtdbTarget,
  next: (snap: RtdbDataSnapshot, previousChildName: string | null) => void,
  cancelCallbackOrOptions?: ((err: unknown) => void) | { readonly onlyOnce?: boolean },
  options?: { readonly onlyOnce?: boolean },
): Unsubscribe {
  return subscribeRtdbChild(r, 'added', next, cancelCallbackOrOptions, options);
}

/** Derives existing direct-child value changes from the parent value stream. */
export function rtdbOnChildChanged(
  r: RtdbTarget,
  next: (snap: RtdbDataSnapshot, previousChildName: string | null) => void,
  cancelCallbackOrOptions?: ((err: unknown) => void) | { readonly onlyOnce?: boolean },
  options?: { readonly onlyOnce?: boolean },
): Unsubscribe {
  return subscribeRtdbChild(r, 'changed', next, cancelCallbackOrOptions, options);
}

export function rtdbOnChildRemoved(
  r: RtdbTarget,
  next: (snap: RtdbDataSnapshot, previousChildName: string | null) => void,
  cancelCallbackOrOptions?: ((err: unknown) => void) | { readonly onlyOnce?: boolean },
  options?: { readonly onlyOnce?: boolean },
): Unsubscribe {
  return subscribeRtdbChild(r, 'removed', next, cancelCallbackOrOptions, options);
}

export function rtdbOnChildMoved(
  r: RtdbTarget,
  next: (snap: RtdbDataSnapshot, previousChildName: string | null) => void,
  cancelCallbackOrOptions?: ((err: unknown) => void) | { readonly onlyOnce?: boolean },
  options?: { readonly onlyOnce?: boolean },
): Unsubscribe {
  return subscribeRtdbChild(r, 'moved', next, cancelCallbackOrOptions, options);
}

function subscribeRtdbChild(
  target: RtdbTarget,
  kind: ChildEventKind,
  next: (snap: RtdbDataSnapshot, previousChildName: string | null) => void,
  cancelCallbackOrOptions?: ((err: unknown) => void) | { readonly onlyOnce?: boolean },
  options?: { readonly onlyOnce?: boolean },
): Unsubscribe {
  const error = typeof cancelCallbackOrOptions === 'function' ? cancelCallbackOrOptions : undefined;
  const listenOptions = typeof cancelCallbackOrOptions === 'function'
    ? options
    : cancelCallbackOrOptions;
  if (!listenOptions?.onlyOnce) return rtdbOnChildEvent(target, kind, next, error);
  let stopped = false;
  let unsubscribe: Unsubscribe = () => {};
  unsubscribe = rtdbOnChildEvent(target, kind, (snapshot, previousChildName) => {
    if (stopped) return;
    stopped = true;
    unsubscribe();
    next(snapshot, kind === 'removed' ? null : previousChildName);
  }, error);
  return unsubscribe;
}
export function rtdbOff(_r: RtdbRefHandle, _eventType?: unknown, _callback?: unknown): void {
  // Firebase's `off` is callback-specific. The worker bridge exposes unsubscribe
  // functions from `onValue`; this no-op preserves common app code that calls it
  // defensively during cleanup.
}
