/** RTDB value/child listeners and Firebase-compatible `off` registration identity. */
import type { InboundMessage } from '../protocol.js';
import { sameRtdbValue } from '../rtdb-value-equality.js';
import {
  _defaultLens,
  closeSubscription,
  nextSubId,
  openSnapshotSubscription,
  stampIssuer,
} from './core.js';
import type { ClientPort, RtdbDataSnapshot, Unsubscribe } from './handles.js';
import {
  isRtdbQuery,
  rtdbChild,
  targetParts,
  type RtdbTarget,
} from './rtdb-references.js';
import {
  hydrateRtdbSnapshot,
  makeRtdbSnapshot,
  valueAt,
  type RtdbWireEntry,
} from './rtdb-snapshots.js';

export type RtdbEventType =
  | 'value'
  | 'child_added'
  | 'child_changed'
  | 'child_removed'
  | 'child_moved';

interface ListenerRegistration {
  readonly port: ClientPort;
  readonly path: string;
  readonly scope?: string;
  readonly eventType: RtdbEventType;
  readonly callback: object;
  close(): void;
}

const registrations: ListenerRegistration[] = [];

/** Drop client-side registration identity when the owning app port closes. */
export function dropRtdbListenersForPort(port: ClientPort): void {
  for (const registration of [...registrations]) {
    if (registration.port === port) registration.close();
  }
}

function targetScope(target: RtdbTarget): string {
  if (!isRtdbQuery(target)) return 'default';
  const spec = target._spec;
  if (spec.orderBy === null && spec.bounds.length === 0 && spec.limit === null) return 'default';
  const boundOrder: Record<(typeof spec.bounds)[number]['kind'], number> = {
    startAt: 0,
    startAfter: 0,
    equalTo: 1,
    endAt: 2,
    endBefore: 2,
  };
  return JSON.stringify({
    orderBy: spec.orderBy,
    bounds: [...spec.bounds].sort((left, right) => boundOrder[left.kind] - boundOrder[right.kind]),
    limit: spec.limit,
  });
}

function removeRegistration(registration: ListenerRegistration): void {
  const index = registrations.indexOf(registration);
  if (index >= 0) registrations.splice(index, 1);
}

function openValueSubscription(
  target: RtdbTarget,
  next: (snap: RtdbDataSnapshot) => void,
  cancelCallbackOrOptions?: ((err: unknown) => void) | { readonly onlyOnce?: boolean },
  options?: { readonly onlyOnce?: boolean },
): Unsubscribe {
  const { ref, query } = targetParts(target);
  const error = typeof cancelCallbackOrOptions === 'function' ? cancelCallbackOrOptions : undefined;
  const listenOptions = typeof cancelCallbackOrOptions === 'function'
    ? options
    : cancelCallbackOrOptions;
  const subId = nextSubId();
  const msg: InboundMessage = _defaultLens
    ? { t: 'sub', subId, target: { service: 'rtdb', path: ref.path, ...(query ? { query } : {}) }, actAs: _defaultLens }
    : { t: 'sub', subId, target: { service: 'rtdb', path: ref.path, ...(query ? { query } : {}) } };
  let fired = false;
  const opened = openSnapshotSubscription(ref.port, subId, {
    port: ref.port,
    next: (wire) => {
      if (listenOptions?.onlyOnce && fired) return;
      fired = true;
      if (listenOptions?.onlyOnce) closeSubscription(ref.port, subId);
      next(hydrateRtdbSnapshot(ref, wire));
    },
    error,
  }, stampIssuer(msg));
  if (!opened && error) {
    queueMicrotask(() => error(new Error('FIREBASE FATAL ERROR: Database has been deleted.')));
  }
  return () => closeSubscription(ref.port, subId);
}

function registerListener(
  target: RtdbTarget,
  eventType: RtdbEventType,
  callback: object,
  unsubscribe: Unsubscribe,
): Unsubscribe {
  const { ref } = targetParts(target);
  let closed = false;
  const registration: ListenerRegistration = {
    port: ref.port,
    path: ref.path,
    scope: targetScope(target),
    eventType,
    callback,
    close() {
      if (closed) return;
      closed = true;
      removeRegistration(registration);
      unsubscribe();
    },
  };
  registrations.push(registration);
  return registration.close;
}

export function rtdbOnValue(
  target: RtdbTarget,
  next: (snap: RtdbDataSnapshot) => void,
  cancelCallbackOrOptions?: ((err: unknown) => void) | { readonly onlyOnce?: boolean },
  options?: { readonly onlyOnce?: boolean },
  registryCallback: object = next,
): Unsubscribe {
  const listenOptions = typeof cancelCallbackOrOptions === 'function'
    ? options
    : cancelCallbackOrOptions;
  let unsubscribe: Unsubscribe = () => {};
  const rawUnsubscribe = openValueSubscription(target, (snapshot) => {
    try {
      next(snapshot);
    } finally {
      if (listenOptions?.onlyOnce) queueMicrotask(() => unsubscribe());
    }
  }, cancelCallbackOrOptions, options);
  unsubscribe = registerListener(
    target,
    'value',
    registryCallback,
    rawUnsubscribe,
  );
  return unsubscribe;
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

function onChildEvent(
  target: RtdbTarget,
  kind: ChildEventKind,
  next: (snap: RtdbDataSnapshot, previousChildName: string | null) => void,
  error?: (err: unknown) => void,
  reverseInitial = false,
): Unsubscribe {
  const { ref, query } = targetParts(target);
  let initialized = false;
  let previous: RtdbWireEntry[] = [];
  return openValueSubscription(target, (parent) => {
    const current: RtdbWireEntry[] = [];
    parent.forEach((childSnap) => {
      if (childSnap.key !== null) {
        current.push({
          key: childSnap.key,
          value: childSnap.val(),
          priority: childSnap.priority,
          exportValue: childSnap.exportVal(),
        });
      }
    });
    if (current.length === 0) {
      for (const key of Object.keys(directChildren(parent.val())).sort(rtdbKeyCompare)) {
        current.push({ key, value: directChildren(parent.val())[key] });
      }
    }
    const emit = (entry: RtdbWireEntry, previousChildName: string | null): void => {
      try {
        next(makeRtdbSnapshot(
          rtdbChild(ref, entry.key),
          entry.value,
          undefined,
          entry.priority ?? null,
          undefined,
          entry.exportValue ?? entry.value,
        ), previousChildName);
      } catch {
        // Firebase isolates listener exceptions from sibling deliveries.
      }
    };
    if (!initialized) {
      initialized = true;
      if (kind === 'added') {
        const indexes = current.map((_, index) => index);
        if (reverseInitial) indexes.reverse();
        for (const index of indexes) {
          emit(current[index]!, current[index - 1]?.key ?? null);
        }
      }
      previous = current;
      return;
    }
    const previousByKey = new Map(previous.map((entry, index) => [entry.key, { entry, index }]));
    const currentByKey = new Map(current.map((entry, index) => [entry.key, { entry, index }]));
    if (kind === 'removed') {
      for (const prior of previous) {
        if (!currentByKey.has(prior.key)) {
          emit(prior, previous[previousByKey.get(prior.key)!.index - 1]?.key ?? null);
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
          if (!sameRtdbValue(indexed(prior.entry), indexed(entry))) {
            emit(entry, previousChildName);
          }
        }
      }
    }
    previous = current;
  }, error);
}

function subscribeChild(
  target: RtdbTarget,
  kind: ChildEventKind,
  next: (snap: RtdbDataSnapshot, previousChildName: string | null) => void,
  cancelCallbackOrOptions?: ((err: unknown) => void) | { readonly onlyOnce?: boolean },
  options?: { readonly onlyOnce?: boolean },
  registryCallback: object = next,
): Unsubscribe {
  const error = typeof cancelCallbackOrOptions === 'function' ? cancelCallbackOrOptions : undefined;
  const listenOptions = typeof cancelCallbackOrOptions === 'function'
    ? options
    : cancelCallbackOrOptions;
  const eventType = `child_${kind}` as RtdbEventType;
  if (!listenOptions?.onlyOnce) {
    return registerListener(target, eventType, registryCallback, onChildEvent(target, kind, next, error));
  }
  let stopped = false;
  let stopScheduled = false;
  let unsubscribe: Unsubscribe = () => {};
  const rawUnsubscribe = onChildEvent(target, kind, (snapshot, previousChildName) => {
    if (stopped) return;
    try {
      next(snapshot, kind === 'removed' ? null : previousChildName);
    } finally {
      if (kind === 'added') {
        if (!stopScheduled) {
          stopScheduled = true;
          queueMicrotask(() => { stopped = true; unsubscribe(); });
        }
      } else {
        stopped = true;
        unsubscribe();
      }
    }
  }, error, kind === 'added');
  unsubscribe = registerListener(target, eventType, registryCallback, rawUnsubscribe);
  return unsubscribe;
}

type ChildCallback = (snap: RtdbDataSnapshot, previousChildName: string | null) => void;
type CancelOrOptions = ((err: unknown) => void) | { readonly onlyOnce?: boolean };
type ListenOptions = { readonly onlyOnce?: boolean };

export function rtdbOnChildAdded(target: RtdbTarget, next: ChildCallback, cancel?: CancelOrOptions, options?: ListenOptions, identity: object = next): Unsubscribe {
  return subscribeChild(target, 'added', next, cancel, options, identity);
}

export function rtdbOnChildChanged(target: RtdbTarget, next: ChildCallback, cancel?: CancelOrOptions, options?: ListenOptions, identity: object = next): Unsubscribe {
  return subscribeChild(target, 'changed', next, cancel, options, identity);
}

export function rtdbOnChildRemoved(target: RtdbTarget, next: ChildCallback, cancel?: CancelOrOptions, options?: ListenOptions, identity: object = next): Unsubscribe {
  return subscribeChild(target, 'removed', next, cancel, options, identity);
}

export function rtdbOnChildMoved(target: RtdbTarget, next: ChildCallback, cancel?: CancelOrOptions, options?: ListenOptions, identity: object = next): Unsubscribe {
  return subscribeChild(target, 'moved', next, cancel, options, identity);
}

export function rtdbOff(target: RtdbTarget, eventType?: RtdbEventType, callback?: object): void {
  const { ref } = targetParts(target);
  const scope = targetScope(target);
  const allViews = !isRtdbQuery(target);
  const matches = (registration: ListenerRegistration): boolean =>
    registration.port === ref.port
      && registration.path === ref.path
      && (allViews || registration.scope === scope)
      && (eventType === undefined || registration.eventType === eventType)
      && (callback === undefined || registration.callback === callback);
  if (callback !== undefined && eventType !== undefined) {
    registrations.find(matches)?.close();
    return;
  }
  for (const registration of [...registrations]) {
    if (matches(registration)) registration.close();
  }
}
