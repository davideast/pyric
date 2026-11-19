/** RTDB value/child listeners and Firebase-compatible `off` registration identity. */
import type { InboundMessage, RtdbValueSubMessage } from '../protocol.js';
import {
  indexedOrderValueChanged,
  logDatabaseWarning,
  normalizeNode,
  queryIdentifier,
} from 'pyric/database/internal';
import { sameRtdbValue } from '../rtdb-value-equality.js';
import {
  _defaultLens,
  closeSubscription,
  nextSubId,
  openSnapshotSubscription,
  stampIssuer,
  subscribeLens,
} from './core.js';
import type { ClientPort, ClientRtdbInstance, RtdbDataSnapshot, Unsubscribe } from './handles.js';
import { dropWorkerClientCacheForPort, registerWorkerWarmListener } from './rtdb-client-cache.js';
import { workerEmulatorLensFor } from './rtdb-controls.js';
import { pageListenerOwners } from './listener-owners.js';
import { deliverWithRegions } from './listener-delivery.js';
import { observeInfo, servesInfoLocally } from './rtdb-info.js';
import { beginWorkerDatabaseActivity } from './sdk-activity.js';
import type { SdkActivityHandle } from 'pyric/sandbox/internal';
import {
  isRtdbQuery,
  rtdbChild,
  sameRtdbInstance,
  targetParts,
  type RtdbTarget,
} from './rtdb-references.js';
import {
  hydrateRtdbSnapshot,
  makeRtdbSnapshot,
  type RtdbWireEntry,
  type RtdbWireSnapshot,
} from './rtdb-snapshots.js';

export type RtdbEventType =
  | 'value'
  | 'child_added'
  | 'child_changed'
  | 'child_removed'
  | 'child_moved';

const EVENT_PRIORITY: Readonly<Record<RtdbEventType, number>> = {
  child_removed: 0,
  child_added: 1,
  child_moved: 2,
  child_changed: 3,
  value: 4,
};

interface InitialGroupMember {
  readonly eventType: RtdbEventType;
  readonly order: number;
  active: boolean;
  ready: boolean;
  deliverInitial: (() => void) | null;
}

interface InitialTargetGroup {
  sealed: boolean;
  flushed: boolean;
  readonly members: InitialGroupMember[];
}

const openInitialGroups = new WeakMap<ClientPort, Map<string, InitialTargetGroup>>();

function flushInitialTargetGroupIfReady(group: InitialTargetGroup): void {
  if (group.flushed || !group.sealed) return;
  for (const member of group.members) {
    if (member.active && !member.ready) return;
  }
  group.flushed = true;
  const ordered = [...group.members].sort((left, right) => {
    const diff = EVENT_PRIORITY[left.eventType] - EVENT_PRIORITY[right.eventType];
    if (diff !== 0) return diff;
    return left.order - right.order;
  });
  for (const member of ordered) {
    if (member.active && member.deliverInitial !== null) {
      const fn = member.deliverInitial;
      member.deliverInitial = null;
      fn();
    }
  }
}

function joinInitialTargetGroup(
  port: ClientPort,
  groupKey: string,
  eventType: RtdbEventType,
): {
  onInitialSnapshot(deliver: () => void): void;
  leaveGroup(): void;
} {
  let byKey = openInitialGroups.get(port);
  if (byKey === undefined) {
    byKey = new Map();
    openInitialGroups.set(port, byKey);
  }
  let group = byKey.get(groupKey);
  if (group === undefined || group.sealed) {
    const created: InitialTargetGroup = { sealed: false, flushed: false, members: [] };
    group = created;
    byKey.set(groupKey, created);
    const mapRef = byKey;
    queueMicrotask(() => {
      created.sealed = true;
      if (mapRef.get(groupKey) === created) {
        mapRef.delete(groupKey);
      }
      flushInitialTargetGroupIfReady(created);
    });
  }
  const member: InitialGroupMember = {
    eventType,
    order: group.members.length,
    active: true,
    ready: false,
    deliverInitial: null,
  };
  group.members.push(member);
  const owningGroup = group;
  return {
    onInitialSnapshot(deliver: () => void): void {
      if (owningGroup.flushed) {
        member.ready = true;
        deliver();
        return;
      }
      member.ready = true;
      member.deliverInitial = deliver;
      flushInitialTargetGroupIfReady(owningGroup);
    },
    leaveGroup(): void {
      if (!member.active) return;
      member.active = false;
      member.deliverInitial = null;
      flushInitialTargetGroupIfReady(owningGroup);
    },
  };
}

interface ListenerRegistration {
  readonly port: ClientPort;
  readonly instance?: ClientRtdbInstance;
  readonly path: string;
  readonly scope?: string;
  readonly eventType: RtdbEventType;
  readonly callback: object;
  close(): void;
}

const registrations: ListenerRegistration[] = [];

/** Drop client-side registration identity when the owning app port closes. */
export function dropRtdbListenersForPort(port: ClientPort): void {
  dropWorkerClientCacheForPort(port);
  for (const registration of [...registrations]) {
    if (registration.port === port) registration.close();
  }
}

function targetScope(target: RtdbTarget): string {
  if (!isRtdbQuery(target)) return 'default';
  return queryIdentifier(target._spec);
}

/**
 * The listen options a value subscription reads. `owner` is pyric's own listen
 * option: the page names who owns the listener, and the owners derived from it
 * travel with the subscribe message.
 */
type ValueListenOptions = { readonly onlyOnce?: boolean; readonly owner?: unknown };

/** What a value snapshot shows the page: whether it exists, and its data with priorities. */
function deliveredContent(wire: unknown): string {
  const snapshot = wire as Partial<RtdbWireSnapshot> | null;
  return JSON.stringify([
    snapshot?.exists ?? null,
    snapshot?.exportValue ?? null,
    snapshot?.entries?.map((entry) => [
      entry.key,
      entry.priority ?? null,
      entry.exportValue ?? entry.value ?? null,
    ]) ?? null,
  ]);
}

function removeRegistration(registration: ListenerRegistration): void {
  const index = registrations.indexOf(registration);
  if (index >= 0) registrations.splice(index, 1);
}

function openValueSubscription(
  target: RtdbTarget,
  next: (snap: RtdbDataSnapshot) => void,
  cancelCallbackOrOptions: ((err: unknown) => void) | ValueListenOptions | undefined,
  options: ValueListenOptions | undefined,
  activity: SdkActivityHandle,
  eventType: RtdbEventType = 'value',
  trackWarm = true,
): Unsubscribe {
  const { ref, query } = targetParts(target);
  const error = typeof cancelCallbackOrOptions === 'function' ? cancelCallbackOrOptions : undefined;
  const listenOptions = typeof cancelCallbackOrOptions === 'function'
    ? options
    : cancelCallbackOrOptions;
  let currentSubId = nextSubId();
  activity.transport(currentSubId);
  let fired = false;
  let unsubscribed = false;
  let releaseWarm: (() => void) | undefined;
  const stopWarm = (): void => {
    if (releaseWarm !== undefined) {
      releaseWarm();
      releaseWarm = undefined;
    }
  };

  // Derived here, on the stack the caller is still on and against the page's
  // own document. The worker's attach can read neither.
  const owners = pageListenerOwners(listenOptions);

  const makeSubMsg = (subId: string, lens: typeof _defaultLens): InboundMessage => {
    const subTarget: RtdbValueSubMessage['target'] = {
      service: 'rtdb',
      instance: ref.instance?.name,
      path: ref.path,
    };
    if (query) subTarget.query = query;
    if (eventType !== 'value') subTarget.event = eventType;
    const msg: RtdbValueSubMessage = { t: 'sub', subId, target: subTarget };
    if (lens) msg.actAs = lens;
    if (owners) msg.owners = owners;
    return msg;
  };

  let unsubLens: () => void = () => {};
  // The host re-registers a listener when the port's session or the page's
  // lens changes, and the new registration sends the current data again. An
  // identity change does not change data, so a snapshot equal to the last
  // one delivered is not a new event.
  let delivered: string | undefined;
  let initialSeen = false;
  const groupKey = `${ref.instance?.name ?? ''}\0${ref.path}\0${targetScope(target)}`;
  const initialGroup = joinInitialTargetGroup(ref.port, groupKey, eventType);

  const subHandler = {
    port: ref.port,
    next: (wire: unknown) => {
      const deliverWire = (): void => {
        if (unsubscribed) return;
        if (listenOptions?.onlyOnce && fired) return;
        const content = deliveredContent(wire);
        if (fired && content === delivered) return;
        const warning = (wire as RtdbWireSnapshot | null)?.warning;
        if (typeof warning === 'string') logDatabaseWarning(warning);
        delivered = content;
        fired = true;
        // Reported on the subscription id the sandbox also records as the
        // listener id, immediately before the application's callback runs.
        if (listenOptions?.onlyOnce) {
          unsubLens();
          closeSubscription(ref.port, currentSubId);
        } else if (trackWarm && releaseWarm === undefined) {
          releaseWarm = registerWorkerWarmListener(ref, ref.path);
        }
        next(hydrateRtdbSnapshot(ref, wire));
      };
      if (!initialSeen) {
        initialSeen = true;
        initialGroup.onInitialSnapshot(deliverWire);
        return;
      }
      deliverWire();
    },
    error: (cause: unknown) => {
      unsubscribed = true;
      stopWarm();
      initialGroup.leaveGroup();
      unsubLens();
      activity.fail();
      error?.(cause);
    },
    close: () => activity.close(),
  };

  let initialLens = _defaultLens;
  if (initialLens === undefined) {
    initialLens = workerEmulatorLensFor(ref);
  }
  const opened = openSnapshotSubscription(
    ref.port,
    currentSubId,
    subHandler,
    stampIssuer(makeSubMsg(currentSubId, initialLens)),
  );
  if (!opened) {
    initialGroup.leaveGroup();
    activity.fail();
  }
  if (!opened && error) {
    queueMicrotask(() => error(new Error('FIREBASE FATAL ERROR: Database has been deleted.')));
  }

  unsubLens = subscribeLens((newLens) => {
    if (unsubscribed || (listenOptions?.onlyOnce && fired)) return;
    closeSubscription(ref.port, currentSubId);
    currentSubId = nextSubId();
    activity.transport(currentSubId);
    let activeLens = newLens;
    if (activeLens === undefined) {
      activeLens = workerEmulatorLensFor(ref);
    }
    openSnapshotSubscription(
      ref.port,
      currentSubId,
      subHandler,
      stampIssuer(makeSubMsg(currentSubId, activeLens)),
    );
  });

  return () => {
    if (unsubscribed) return;
    unsubscribed = true;
    stopWarm();
    initialGroup.leaveGroup();
    activity.close();
    unsubLens();
    closeSubscription(ref.port, currentSubId);
  };
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
    ...(ref.instance === undefined ? {} : { instance: ref.instance }),
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
  cancelCallbackOrOptions?: ((err: unknown) => void) | ValueListenOptions,
  options?: ValueListenOptions,
  registryCallback: object = next,
): Unsubscribe {
  const hasCancelCallback = typeof cancelCallbackOrOptions === 'function';
  const listenOptions = hasCancelCallback
    ? options
    : cancelCallbackOrOptions;
  const activity = beginWorkerDatabaseActivity(target, 'onValue', 'subscription', pageListenerOwners(listenOptions));
  const isOnce = listenOptions?.onlyOnce === true;
  let unsubscribe: Unsubscribe | undefined;
  let deliveredOnce = false;
  const deliver = (snapshot: RtdbDataSnapshot): void => {
    // Set before the callback runs: a callback that changes the value, such
    // as one calling goOffline() on .info/connected, is not called again (D10).
    if (isOnce && deliveredOnce) return;
    if (isOnce) deliveredOnce = true;
    try {
      activity.delivered(snapshot);
      deliverWithRegions(activity.id, () => next(snapshot));
    } catch {
      // Firebase isolates listener exceptions from sibling deliveries.
    } finally {
      // A delivery before the listener is registered stops it as it registers, below.
      if (isOnce) unsubscribe?.();
    }
  };
  const { ref } = targetParts(target);
  const rawUnsubscribe = servesInfoLocally(ref)
    ? observeInfo(target, deliver)
    : openValueSubscription(target, deliver, cancelCallbackOrOptions, options, activity);
  unsubscribe = registerListener(
    target,
    'value',
    registryCallback,
    () => { activity.close(); rawUnsubscribe(); },
  );
  const deliveredBeforeRegistration = isOnce && deliveredOnce;
  if (deliveredBeforeRegistration) unsubscribe();
  return unsubscribe;
}

type ChildEventKind = 'added' | 'changed' | 'removed' | 'moved';

function onChildEvent(
  target: RtdbTarget,
  kind: ChildEventKind,
  next: (snap: RtdbDataSnapshot, previousChildName: string | null, initialBatch: boolean) => void,
  error: ((err: unknown) => void) | undefined,
  activity: SdkActivityHandle,
  reverseInitial = false,
  trackWarm = true,
): Unsubscribe {
  const { ref, query } = targetParts(target);
  let initialized = false;
  let previous: RtdbWireEntry[] = [];
  const eventType = `child_${kind}` as RtdbEventType;
  const observeParent = (deliver: (parent: RtdbDataSnapshot) => void): Unsubscribe => {
    if (servesInfoLocally(ref)) {
      return observeInfo(target, deliver);
    }
    return openValueSubscription(target, deliver, error, undefined, activity, eventType, trackWarm);
  };
  return observeParent((parent) => {
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
    const emit = (entry: RtdbWireEntry, previousChildName: string | null, initialBatch = false): void => {
      try {
        next(makeRtdbSnapshot(
          rtdbChild(ref, entry.key),
          entry.value,
          undefined,
          entry.priority ?? null,
          undefined,
          entry.exportValue ?? entry.value,
        ), previousChildName, initialBatch);
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
          emit(current[index]!, current[index - 1]?.key ?? null, true);
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
          emit(prior, null);
        }
      }
    } else {
      for (let index = 0; index < current.length; index++) {
        const entry = current[index]!;
        const prior = previousByKey.get(entry.key);
        const previousChildName = current[index - 1]?.key ?? null;
        if (kind === 'added' && !prior) emit(entry, previousChildName);
        if (
          kind === 'changed' &&
          prior &&
          (!sameRtdbValue(prior.entry.value, entry.value) ||
            (prior.entry.priority ?? null) !== (entry.priority ?? null))
        ) {
          emit(entry, previousChildName);
        }
        if (kind === 'moved' && prior) {
          const moved = indexedOrderValueChanged(
            query?.orderBy ?? null,
            entry.key,
            normalizeNode(prior.entry.value),
            prior.entry.priority ?? null,
            normalizeNode(entry.value),
            entry.priority ?? null,
          );
          if (moved) {
            emit(entry, previousChildName);
          }
        }
      }
    }
    previous = current;
  });
}

function subscribeChild(
  target: RtdbTarget,
  kind: ChildEventKind,
  next: (snap: RtdbDataSnapshot, previousChildName: string | null) => void,
  cancelCallbackOrOptions?: ((err: unknown) => void) | ValueListenOptions,
  options?: ValueListenOptions,
  registryCallback: object = next,
): Unsubscribe {
  const error = typeof cancelCallbackOrOptions === 'function' ? cancelCallbackOrOptions : undefined;
  const listenOptions = typeof cancelCallbackOrOptions === 'function'
    ? options
    : cancelCallbackOrOptions;
  const activity = beginWorkerDatabaseActivity(target, `onChild${kind[0]!.toUpperCase()}${kind.slice(1)}`, 'subscription', pageListenerOwners(listenOptions));
  const callback = next;
  next = (snapshot, previous) => {
    activity.delivered(snapshot);
    deliverWithRegions(activity.id, () => callback(snapshot, previous));
  };
  const eventType = `child_${kind}` as RtdbEventType;
  if (!listenOptions?.onlyOnce) {
    return registerListener(target, eventType, registryCallback, onChildEvent(target, kind, next, error, activity));
  }
  let stopped = false;
  let stopScheduled = false;
  let unsubscribe: Unsubscribe = () => {};
  const rawUnsubscribe = onChildEvent(target, kind, (snapshot, previousChildName, initialBatch) => {
    if (stopped) return;
    try {
      next(snapshot, kind === 'removed' ? null : previousChildName);
    } finally {
      if (kind === 'added' && initialBatch) {
        if (!stopScheduled) {
          stopScheduled = true;
          queueMicrotask(() => { stopped = true; unsubscribe(); });
        }
      } else {
        stopped = true;
        unsubscribe();
      }
    }
  }, error, activity, kind === 'added', false);
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
  const allViews = !isRtdbQuery(target) || scope === 'default';
  const matches = (registration: ListenerRegistration): boolean =>
    registration.port === ref.port
      && sameRtdbInstance(registration, ref)
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
