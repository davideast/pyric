import { sdkActivity, type SdkActivityHandle } from '../sandbox/internal/sdk-activity.js';
import { scheduleClientWarmListener, withoutWarmListenerRegistration } from './client-cache-state.js';
import { registerOfflineChildListener, registerOfflineValueListener } from './offline-client-state.js';
import { beginDatabaseActivity } from './sdk-activity.js';
import type { AuthState } from 'pyric/sandbox';
import { ListenerRegistry, type ListenerRegistration } from './listener-registry.js';
import type { ChildEventSnapshot, ValueListenerSnapshot } from './sandbox/listener-types.js';
import type { JsonValue } from './sandbox/data-tree.js';
import { runWithExceptionGuard } from './sandbox/exception-guard.js';
import { authFor, isAdminFor, targetOf, type Target } from './routing.js';
import { hasNonFiniteQueryLimit, isDefaultQuerySpec, isQuery, queryIdentifier } from './query-shape.js';
import { loadsAllData, type QueryRow } from './internal/query-projection.js';
import { isInfoPath } from './writable-path.js';
import type { DataSnapshot, DatabaseReference, ListenOptions, Query, Unsubscribe } from './types.js';
import type { ListenerAttribution } from '../sandbox/attribution/listener-owners.js';
import { child } from './references.js';
import { buildSandboxQuerySnap, buildSandboxSnapFromRaw } from './snapshots.js';
import {
  observeConnectionChildMetadata,
  observeConnectionMetadata,
  type ChildEvent,
} from './info-listeners.js';

// ─── Listeners (Tier 2) ──────────────────────────────────────────────

/**
 * RTDB evaluates a listener with the Auth instance attached to its app. When
 * that app's session changes, replace the backend registration with one made
 * under the new identity. Registrations belonging to other app sessions are
 * untouched even though all equal-config apps share one data backend.
 *
 * An identity change does not change data, so the replacement registration's
 * initial deliveries, which the backend makes synchronously, repeat what the
 * listener already received; `replaying()` is true while they run, and the
 * caller drops them. A replacement the new identity may not read is
 * cancelled as before.
 */
function subscribeWithLiveAuth(
  target: Target,
  subscribe: (auth: AuthState, onCanceled: () => void, replaying: () => boolean) => Unsubscribe,
  onTerminal?: () => void,
): Unsubscribe {
  let stopped = false;
  let replacing = false;
  const replaying = (): boolean => replacing;
  let backendUnsubscribe: Unsubscribe = () => {};
  let sessionUnsubscribe: Unsubscribe | undefined;
  let release: Unsubscribe | undefined;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    sessionUnsubscribe?.();
    backendUnsubscribe();
    release?.();
    onTerminal?.();
  };

  backendUnsubscribe = subscribe(authFor(target), stop, replaying);
  if (stopped) return stop;
  sessionUnsubscribe = target.kind === 'sandbox-live'
    ? target.onCurrentUserChanged?.(() => {
      if (stopped) return;
      backendUnsubscribe();
      replacing = true;
      try {
        backendUnsubscribe = subscribe(authFor(target), stop, replaying);
      } catch {
        backendUnsubscribe = () => {};
        stop();
      } finally {
        replacing = false;
      }
    })
    : undefined;
  release = target.kind === 'sandbox-live' ? target.own?.(stop) : undefined;
  return stop;
}

/**
 * The attribution a listen call carries, or `undefined` when it carries none.
 * The backend takes both inputs as one argument.
 */
function attributionOf(options: ListenOptions | undefined): ListenerAttribution | undefined {
  if (options === undefined) return undefined;
  if (options.owner === undefined && options.owners === undefined) return undefined;
  return { owner: options.owner, owners: options.owners };
}

/**
 * The listen options a recursive `onlyOnce` subscribe should keep: the
 * attribution, never `onlyOnce` itself, which the outer call already honored.
 */
function ownerOnlyOptions(options: ListenOptions | undefined): ListenOptions | undefined {
  if (options === undefined) return undefined;
  const base = attributionOf(options);
  if (options.event === undefined) return base;
  if (base === undefined) return { event: options.event };
  return { ...base, event: options.event };
}

function queryScope(r: DatabaseReference | Query): string {
  return queryIdentifier(r._spec);
}

function registerTracked(
  target: Target,
  path: string,
  event: 'value' | ChildEvent,
  registryCallback: object,
  activity: SdkActivityHandle,
  scope: string | undefined,
  attach: (unregister: () => void) => Unsubscribe,
): Unsubscribe {
  let registration: ListenerRegistration | undefined;
  let unregistered = false;
  const stopWarm = scheduleClientWarmListener(target, path);
  const unregister = (): void => {
    stopWarm();
    unregistered = true;
    activity.close();
    if (registration !== undefined) {
      listenerRegistry.removeExact(target, path, event, registryCallback, registration, scope);
    }
  };
  const rawUnsub = attach(unregister);
  const unsubscribe = (): void => { stopWarm(); rawUnsub(); };
  if (!unregistered) {
    registration = { unsubscribe };
    listenerRegistry.add(target, path, event, registryCallback, registration, scope);
  }
  return unsubscribe;
}

/**
 * `onValue(ref, cb)` -- subscribe to value changes at the ref's path.
 * Fires immediately with the current value (or `null` when absent), then on
 * descendant writes; returns an idempotent unsubscribe. `options.onlyOnce`
 * auto-unsubscribes after its first fire. With a cancellation callback, an
 * initially denied listen reports `PERMISSION_DENIED` asynchronously.
 */
export function onValue(
  r: DatabaseReference | Query,
  cb: (snap: DataSnapshot) => void,
  cancelCallbackOrOptions?: ((error: Error) => void) | ListenOptions,
  options?: ListenOptions,
): Unsubscribe {
  const listenOptions = typeof cancelCallbackOrOptions === 'function' ? options : cancelCallbackOrOptions;
  const activity = beginDatabaseActivity(r, 'onValue', 'subscription', attributionOf(listenOptions));
  // onlyOnce may detach before invoking a captured initial callback.
  const lifecycle = listenOptions?.onlyOnce ? { ...activity, close: () => queueMicrotask(() => activity.close()) } : activity;
  const next = (snap: DataSnapshot): void => { activity.delivered(snap); cb(snap); };
  try {
    return sdkActivity.registering(activity, () => onValueInternal(r, next, cancelCallbackOrOptions, options, cb, lifecycle));
  } catch (error) { activity.fail(); throw error; }
}

function subscribeTrackedValue(
  target: Target,
  path: string,
  spec: Query['_spec'] | undefined,
  scope: string | undefined,
  deliver: (raw: ValueListenerSnapshot) => void,
  cancelCallback: ((error: Error) => void) | undefined,
  listenOptions: ListenOptions | undefined,
  registryCallback: (snap: DataSnapshot) => void,
  activity: SdkActivityHandle,
): Unsubscribe {
  if (hasNonFiniteQueryLimit(spec)) {
    return withoutWarmListenerRegistration(() => registerTracked(target, path, 'value', registryCallback, activity, scope, (unregister) => {
      return () => {
        unregister();
      };
    }));
  }
  return registerTracked(target, path, 'value', registryCallback, activity, scope, (unregister) => {
    if (target.admin === true) {
      const subscribed = target.backend.adminOnValue(path, deliver, spec, listenOptions?.event);
      return () => { unregister(); subscribed(); };
    }
    const offlineSub = registerOfflineValueListener(
      target,
      path,
      spec,
      listenOptions?.onlyOnce === true,
      deliver,
    );
    let cancelHandler: ((error: Error) => void) | undefined;
    if (cancelCallback !== undefined) {
      cancelHandler = (error) => { activity.fail(); cancelCallback(error); };
    }
    return subscribeWithLiveAuth(
      target,
      (auth, onCanceled, replaying) => {
        const forward = (raw: ValueListenerSnapshot): void => {
          if (!replaying()) offlineSub.forwardBackend(raw);
        };
        if (isAdminFor(target)) {
          return target.backend.adminOnValue(path, forward, spec, listenOptions?.event);
        }
        return target.backend.onValue(
          auth, path, forward, spec, cancelHandler,
          () => { activity.fail(); onCanceled(); },
          attributionOf(listenOptions), listenOptions?.event,
        );
      },
      () => { offlineSub.close(); unregister(); },
    );
  });
}

function onValueInternal(
  r: DatabaseReference | Query,
  cb: (snap: DataSnapshot) => void,
  cancelCallbackOrOptions: ((error: Error) => void) | ListenOptions | undefined,
  options: ListenOptions | undefined,
  registryCallback: (snap: DataSnapshot) => void,
  activity: SdkActivityHandle,
): Unsubscribe {
  const hasCancelCallback = typeof cancelCallbackOrOptions === 'function';
  const cancelCallback = hasCancelCallback ? cancelCallbackOrOptions : undefined;
  const listenOptions = hasCancelCallback ? options : cancelCallbackOrOptions;
  // `onlyOnce` (DB-B12): wrap the callback so it unsubscribes itself
  // after the first fire. The unsub is filled in once the real
  // subscription is created below.
  const isOnce = listenOptions?.onlyOnce === true;
  if (isOnce) {
    let unsub: Unsubscribe | null = null;
    let fired = false;
    const onceCb = (snap: DataSnapshot): void => {
      if (fired) return;
      fired = true;
      // `unsub` may not be assigned yet if the initial fire is
      // synchronous (the backend fires during subscribe, before
      // `onValue` returns). The post-subscribe check below covers it.
      const currentUnsubscribe = unsub;
      const hasUnsubscribe = currentUnsubscribe !== null;
      if (hasUnsubscribe) currentUnsubscribe();
      cb(snap);
    };
    unsub = withoutWarmListenerRegistration(() =>
      onValueInternal(r, onceCb, cancelCallback, ownerOnlyOptions(listenOptions), registryCallback, activity),
    );
    // Synchronous initial fire: `onceCb` ran before `unsub` was set, so
    // remove the now-stale listener here.
    if (fired) {
      unsub();
      return () => {};
    }
    return unsub;
  }
  const reference = r.ref;
  const isConnectionValue = reference._path === '/.info/connected';
  const isMetadataRoot = reference._path === '/.info';
  const observesConnection = isMetadataRoot || isConnectionValue;
  if (observesConnection) return observeConnectionMetadata(listenerRegistry, r, cb, registryCallback, activity);
  // Query branch — fire only when the windowed result changes.
  // Locked by oracle observation `rtdb-modular-onvalue-with-query.json`:
  // a write OUTSIDE the window does NOT re-fire the listener; a write
  // INSIDE or one that displaces a member DOES.
  const isQueryTarget = isQuery(r) && !isDefaultQuerySpec(r._spec);
  if (isQueryTarget) {
    const q = r;
    const target = targetOf(q.ref);
    const scope = queryScope(q);
    const deliver = (raw: { val: JsonValue; key: string | null; rows?: QueryRow[] }): void => {
      const rows = raw.rows ?? [];
      const snap = buildSandboxQuerySnap(target, q.ref, rows, loadsAllData(q._spec), raw.val);
      cb(snap);
    };
    // Admin (rules-bypass) listeners skip the read-rule gate entirely — the
    // listen-plane sibling of `adminGet`/`adminSet` (#401). `admin` is set
    // only on server-minted `getAdminDatabase` handles, never anything a page
    // controls, so a page's `onValue` stays on the rule-gated path below.
    return subscribeTrackedValue(target, q.ref._path, q._spec, scope, deliver, cancelCallback, listenOptions, registryCallback, activity);
  }
  const ref0 = reference;
  const target = targetOf(ref0);
  const wrapper = (raw: { val: JsonValue; key: string | null }): void => {
    const snap = buildSandboxSnapFromRaw(target, ref0, raw.val);
    cb(snap);
  };
  return subscribeTrackedValue(target, ref0._path, undefined, undefined, wrapper, cancelCallback, listenOptions, registryCallback, activity);
}

/** Subscribe to child-added events at the ref or query path. */
export function onChildAdded(
  r: DatabaseReference | Query,
  cb: (snap: DataSnapshot, previousChildName: string | null) => void,
  cancelCallbackOrOptions?: ((error: Error) => void) | ListenOptions,
  options?: ListenOptions,
): Unsubscribe {
  return subscribeChild(r, 'child_added', cb, cancelCallbackOrOptions, options);
}

/** Subscribe to child-changed events at the ref or query path. */
export function onChildChanged(
  r: DatabaseReference | Query,
  cb: (snap: DataSnapshot, previousChildName: string | null) => void,
  cancelCallbackOrOptions?: ((error: Error) => void) | ListenOptions,
  options?: ListenOptions,
): Unsubscribe {
  return subscribeChild(r, 'child_changed', cb, cancelCallbackOrOptions, options);
}

/** Subscribe to child-removed events at the ref or query path. */
export function onChildRemoved(
  r: DatabaseReference | Query,
  cb: (snap: DataSnapshot, previousChildName: string | null) => void,
  cancelCallbackOrOptions?: ((error: Error) => void) | ListenOptions,
  options?: ListenOptions,
): Unsubscribe {
  return subscribeChild(r, 'child_removed', cb, cancelCallbackOrOptions, options);
}

/** Subscribe to child-moved events at the ref or query path. */
export function onChildMoved(
  r: DatabaseReference | Query,
  cb: (snap: DataSnapshot, previousChildName: string | null) => void,
  cancelCallbackOrOptions?: ((error: Error) => void) | ListenOptions,
  options?: ListenOptions,
): Unsubscribe {
  return subscribeChild(r, 'child_moved', cb, cancelCallbackOrOptions, options);
}

function subscribeChild(
  r: DatabaseReference | Query,
  event: ChildEvent,
  cb: (snap: DataSnapshot, previousChildName: string | null) => void,
  cancelCallbackOrOptions?: ((error: Error) => void) | ListenOptions,
  options?: ListenOptions,
): Unsubscribe {
  const registryCallback = cb;
  const requestedOptions = typeof cancelCallbackOrOptions === 'function' ? options : cancelCallbackOrOptions;
  const method = { child_added: 'onChildAdded', child_changed: 'onChildChanged', child_removed: 'onChildRemoved', child_moved: 'onChildMoved' }[event];
  const activity = beginDatabaseActivity(r, method, 'subscription', attributionOf(requestedOptions));
  const lifecycle = requestedOptions?.onlyOnce ? { ...activity, close: () => queueMicrotask(() => activity.close()) } : activity;
  cb = (snap, previous) => { activity.delivered(snap); registryCallback(snap, previous); };
  const attach = (next: typeof cb, cancel: ((error: Error) => void) | undefined): Unsubscribe => {
    let wrappedCancel: ((error: Error) => void) | undefined;
    if (cancel !== undefined) {
      wrappedCancel = (error) => { activity.fail(); cancel(error); };
    }
    const runAttach = () => sdkActivity.registering(activity, () => onChildEvent(r, event, next, wrappedCancel, registryCallback, lifecycle));
    try {
      if (requestedOptions?.onlyOnce === true) {
        return withoutWarmListenerRegistration(runAttach);
      }
      return runAttach();
    } catch (error) { activity.fail(); throw error; }
  };
  const cancelCallback = typeof cancelCallbackOrOptions === 'function'
    ? cancelCallbackOrOptions
    : undefined;
  const listenOptions = typeof cancelCallbackOrOptions === 'function'
    ? options
    : cancelCallbackOrOptions;
  if (!listenOptions?.onlyOnce) return attach(cb, cancelCallback);

  if (event === 'child_added') {
    let attaching = true;
    const initial: Array<[DataSnapshot, string | null]> = [];
    let stopped = false;
    let unsubscribe: Unsubscribe = () => {};
    const wrapped = (snap: DataSnapshot, previousChildName: string | null): void => {
      if (stopped) return;
      if (attaching) {
        initial.push([snap, previousChildName]);
        return;
      }
      stopped = true;
      unsubscribe();
      cb(snap, previousChildName);
    };
    unsubscribe = attach(wrapped, cancelCallback);
    attaching = false;
    if (initial.length > 0) {
      stopped = true;
      unsubscribe();
      // Firebase queues an existing child_added batch before its only-once
      // detach takes effect and delivers that batch in reverse key order.
      for (const [snap, previousChildName] of initial.reverse()) {
        runWithExceptionGuard(() => cb(snap, previousChildName));
      }
    }
    return unsubscribe;
  }

  let unsubscribe: Unsubscribe | null = null;
  let fired = false;
  const once = (snap: DataSnapshot, previousChildName: string | null): void => {
    if (fired) return;
    fired = true;
    unsubscribe?.();
    cb(snap, event === 'child_removed' ? null : previousChildName);
  };
  unsubscribe = attach(once, cancelCallback);
  // Initial child_added delivery is synchronous, before `unsubscribe` is
  // assigned. Remove the registration after attachment in that case.
  if (fired) unsubscribe();
  return unsubscribe;
}

const listenerRegistry = new ListenerRegistry();

function cancelSubscriptions(
  target: Target,
  path: string,
  event?: 'value' | ChildEvent,
  scope?: string,
): void {
  for (const registration of listenerRegistry.takeMatching(target, path, event, scope)) {
    registration.unsubscribe();
  }
}

/**
 * Internal shared implementation for the four `onChild*` variants.
 *
 * Accepts a plain {@link DatabaseReference} OR a {@link Query}
 * (a `query(ref, ...)` with `orderBy*` / `limitTo*`). For a query, the
 * child-event diff is computed against the ordered, windowed result rather
 * than the raw child
 * key-set — a child entering/leaving the window fires `child_added` /
 * `child_removed`, an in-window value change fires `child_changed`. (Note
 * `child_moved` fires when the query's active ordered value changes.)
 */
function onChildEvent(
  r: DatabaseReference | Query,
  event: ChildEvent,
  cb: (snap: DataSnapshot, previousChildName: string | null) => void,
  cancelCallback: ((error: Error) => void) | undefined,
  registryCallback: typeof cb,
  activity: SdkActivityHandle,
): Unsubscribe {
  // Unwrap a Query into its base ref + spec; a plain ref has no spec.
  const isQ = isQuery(r as object) && !isDefaultQuerySpec((r as Query)._spec);
  const baseRef = isQuery(r as object) ? (r as Query).ref : (r as DatabaseReference);
  const spec = isQ ? (r as Query)._spec : undefined;
  const target = targetOf(baseRef as unknown as object);
  const scope = isQ ? queryScope(r) : undefined;
  if (isInfoPath(baseRef._path)) {
    return observeConnectionChildMetadata(
      listenerRegistry,
      baseRef,
      spec,
      event,
      cb,
      registryCallback,
      activity,
      scope,
    );
  }
  if (hasNonFiniteQueryLimit(spec)) {
    return withoutWarmListenerRegistration(() => registerTracked(target, baseRef._path, event, registryCallback, activity, scope, (unregister) => {
      return () => {
        unregister();
      };
    }));
  }
  const wrapper = (raw: ChildEventSnapshot): void => {
    // Synthesize a snapshot rooted at the child path so `snap.key`
    // and `snap.val()` match the upstream `onChildAdded` snapshot
    // shape (key = the child's key, val = the child's value). A removed
    // child carries the priorities the tree no longer holds.
    const childRef = child(baseRef, raw.key);
    const snap = buildSandboxSnapFromRaw(target, childRef, raw.val, raw.priorities);
    cb(snap, event === 'child_removed' ? null : raw.previousChildName);
  };
  return registerTracked(target, baseRef._path, event, registryCallback, activity, scope, (unregister) => {
    if (target.admin === true) {
      const subscribed = target.backend.adminOnChild(event, baseRef._path, wrapper, spec);
      return () => { unregister(); subscribed(); };
    }
    const offlineChild = registerOfflineChildListener(target, event, baseRef._path, spec, false, wrapper);
    return subscribeWithLiveAuth(
      target,
      (auth, onCanceled, replaying) => {
        const forward = (raw: ChildEventSnapshot): void => {
          if (!replaying()) offlineChild.forwardBackend(raw);
        };
        if (isAdminFor(target)) {
          return target.backend.adminOnChild(event, baseRef._path, forward, spec);
        }
        return target.backend.onChild(
          auth, event, baseRef._path, forward, spec, cancelCallback,
          () => { activity.fail(); onCanceled(); },
        );
      },
      () => { offlineChild.close(); unregister(); },
    );
  });
}

/**
 * `off(ref, eventType?, callback?)` — unsubscribe variant.
 *
 * Semantics (locked by oracle observation
 * `packages/conformance/observations/rtdb-modular/rtdb-modular-off-stops-child-fires.json`):
 *
 *   - `off(ref)` (no eventType) removes ALL listeners at that ref —
 *     value + every child event variety.
 *   - `off(ref, 'value')` removes only `value` listeners.
 *   - `off(ref, 'child_added')` (or any child event type) removes only
 *     that variety.
 *   - `off(ref, eventType, cb)` removes only the matching callback.
 *
 * The returned-unsubscribe pattern from `onValue` / `onChild*` is
 * functionally equivalent to `off(ref, eventType, cb)` for a specific
 * registration — both are supported.
 */
export function off(
  r: DatabaseReference | Query,
  eventType?: 'value' | ChildEvent,
  callback?: (snap: DataSnapshot) => void,
): void {
  const baseRef = isQuery(r as object) ? (r as Query).ref : r as DatabaseReference;
  let scope: string | undefined;
  if (isQuery(r as object) && !isDefaultQuerySpec(r._spec)) {
    const candidateScope = queryScope(r);
    if (candidateScope !== 'default') {
      scope = candidateScope;
    }
  }
  const target = targetOf(baseRef as unknown as object);
  if (callback !== undefined && eventType !== undefined) {
    listenerRegistry.takeFirst(target, baseRef._path, eventType, callback, scope)?.unsubscribe();
    return;
  }
  cancelSubscriptions(target, baseRef._path, eventType, scope);
}
