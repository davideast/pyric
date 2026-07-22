import type { AuthState } from 'pyric/sandbox';
import { ListenerRegistry, type ListenerRegistration } from './listener-registry.js';
import type { JsonValue } from './sandbox/data-tree.js';
import { authFor, targetOf, type Target } from './routing.js';
import { isQuery } from './query-shape.js';
import type { DataSnapshot, DatabaseReference, ListenOptions, Query, Unsubscribe } from './types.js';
import { child } from './references.js';
import { buildSandboxSnapFromRaw } from './snapshots.js';

// ─── Listeners (Tier 2) ──────────────────────────────────────────────

/**
 * RTDB evaluates a listener with the Auth instance attached to its app. When
 * that app's session changes, replace the backend registration with one made
 * under the new identity. Registrations belonging to other app sessions are
 * untouched even though all equal-config apps share one data backend.
 */
function subscribeWithLiveAuth(
  target: Target,
  subscribe: (auth: AuthState, onCanceled: () => void) => Unsubscribe,
): Unsubscribe {
  let stopped = false;
  let backendUnsubscribe: Unsubscribe = () => {};
  let sessionUnsubscribe: Unsubscribe | undefined;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    sessionUnsubscribe?.();
    backendUnsubscribe();
  };

  backendUnsubscribe = subscribe(authFor(target), stop);
  sessionUnsubscribe = target.kind === 'sandbox-live'
    ? target.onCurrentUserChanged?.(() => {
      if (stopped) return;
      backendUnsubscribe();
      try {
        backendUnsubscribe = subscribe(authFor(target), stop);
      } catch {
        // Without a cancellation callback, an auth transition that loses
        // permission suspends delivery and can reauthorize on a later Auth
        // transition. Explicit backend cancellation still calls `stop` and
        // remains terminal.
        backendUnsubscribe = () => {};
      }
    })
    : undefined;
  const release = target.kind === 'sandbox-live' ? target.own?.(stop) : undefined;
  return () => {
    release?.();
    stop();
  };
}

/**
 * `onValue(ref, cb)` — subscribe to value changes at the ref's path.
 *
 * Fires immediately on subscribe with the current value (or
 * `null` + `exists: false` for an absent path), then on every
 * subsequent write that touches the path or any descendant.
 *
 * Returns an unsubscribe function. The unsubscribe is idempotent;
 * calling it twice is a no-op.
 *
 * `options.onlyOnce` (DB-B12): when `true`, the listener auto-unsubscribes
 * after its first fire (mirrors `api/Reference_impl.ts:975-980`).
 *
 * With a cancellation callback, an initially denied listen returns normally
 * and reports the Firebase `PERMISSION_DENIED` error asynchronously. Without
 * one, the sandbox preserves its legacy synchronous throw.
 */
export function onValue(
  r: DatabaseReference | Query,
  cb: (snap: DataSnapshot) => void,
  cancelCallbackOrOptions?: ((error: Error) => void) | ListenOptions,
  options?: ListenOptions,
): Unsubscribe {
  const cancelCallback = typeof cancelCallbackOrOptions === 'function'
    ? cancelCallbackOrOptions
    : undefined;
  const listenOptions = typeof cancelCallbackOrOptions === 'function'
    ? options
    : cancelCallbackOrOptions;
  // `onlyOnce` (DB-B12): wrap the callback so it unsubscribes itself
  // after the first fire. The unsub is filled in once the real
  // subscription is created below.
  if (listenOptions?.onlyOnce) {
    let unsub: Unsubscribe | null = null;
    let fired = false;
    const onceCb = (snap: DataSnapshot): void => {
      if (fired) return;
      fired = true;
      // `unsub` may not be assigned yet if the initial fire is
      // synchronous (the backend fires during subscribe, before
      // `onValue` returns). The post-subscribe check below covers it.
      if (unsub) unsub();
      cb(snap);
    };
    unsub = onValue(r, onceCb, cancelCallback);
    // Synchronous initial fire: `onceCb` ran before `unsub` was set, so
    // remove the now-stale listener here.
    if (fired) unsub();
    return fired ? () => {} : unsub;
  }
  // Query branch — fire only when the windowed result changes.
  // Locked by oracle observation `rtdb-modular-onvalue-with-query.json`:
  // a write OUTSIDE the window does NOT re-fire the listener; a write
  // INSIDE or one that displaces a member DOES.
  if (isQuery(r as object)) {
    const q = r as Query;
    const target = targetOf(q.ref as unknown as object);
    const deliver = (raw: { val: JsonValue; key: string | null }): void => {
      const snap = buildSandboxSnapFromRaw(target, q.ref, raw.val);
      try {
        cb(snap);
      } catch {
        // Listener throws are swallowed.
      }
    };
    // Admin (rules-bypass) listeners skip the read-rule gate entirely — the
    // listen-plane sibling of `adminGet`/`adminSet` (#401). `admin` is set
    // only on server-minted `getAdminDatabase` handles, never anything a page
    // controls, so a page's `onValue` stays on the rule-gated path below.
    return target.admin
      ? target.backend.adminOnValue(q.ref._path, deliver, q._spec)
      : subscribeWithLiveAuth(
        target,
        (auth, onCanceled) => target.backend.onValue(
          auth,
          q.ref._path,
          deliver,
          q._spec,
          cancelCallback,
          onCanceled,
        ),
      );
  }
  const ref0 = r as DatabaseReference;
  const target = targetOf(ref0 as unknown as object);
  const wrapper = (raw: { val: JsonValue; key: string | null }): void => {
    const snap = buildSandboxSnapFromRaw(target, ref0, raw.val);
    try {
      cb(snap);
    } catch {
      // Listener throws are swallowed — match `firebase/database`'s
      // behavior where one observer's exception doesn't block others.
    }
  };
  const unsub = target.admin
    ? target.backend.adminOnValue(ref0._path, wrapper)
    : subscribeWithLiveAuth(
      target,
      (auth, onCanceled) => target.backend.onValue(
        auth,
        ref0._path,
        wrapper,
        undefined,
        cancelCallback,
        onCanceled,
      ),
    );
  const registration: ListenerRegistration = { unsubscribe: unsub };
  listenerRegistry.add(target, ref0._path, 'value', cb, registration);
  return () => {
    listenerRegistry.removeExact(target, ref0._path, 'value', cb, registration);
    unsub();
  };
}

/**
 * `onChildAdded(ref, cb)` — subscribe to child-added events at the
 * ref's path.
 *
 * Semantics (locked by oracle observations under
 * `packages/conformance/observations/rtdb-modular/rtdb-modular-onchildadded-*.json`):
 *
 *   - On subscribe, replays every existing direct child of `ref`'s path
 *     (one fire per existing key, in `orderByKey`-default order).
 *   - After subscribe, fires exactly once per new direct child write.
 *
 * Also accepts a {@link Query} (a `query(ref, ...)` with `orderBy*` /
 * `limitTo*` constraints): child events are then computed against the
 * ordered, windowed result — a child ENTERING the window fires
 * `child_added`; on subscribe the current window is replayed in window
 * order.
 *
 * Returns an unsubscribe; calling it twice is a no-op.
 */
export function onChildAdded(
  r: DatabaseReference | Query,
  cb: (snap: DataSnapshot, previousChildName: string | null) => void,
  cancelCallbackOrOptions?: ((error: Error) => void) | ListenOptions,
  options?: ListenOptions,
): Unsubscribe {
  return subscribeChild(r, 'child_added', cb, cancelCallbackOrOptions, options);
}

/**
 * `onChildChanged(ref, cb)` — subscribe to child-changed events.
 *
 * Semantics (oracle: `rtdb-modular-onchildchanged-fires-on-update`):
 *
 *   - No initial replay.
 *   - Fires when an existing direct child's value transitions to a
 *     NEW non-null value. Snapshot carries the NEW value.
 *   - Does NOT fire for added or removed children.
 *
 * Also accepts a {@link Query}: fires when a child that is IN the query
 * window changes value (an in-window update).
 */
export function onChildChanged(
  r: DatabaseReference | Query,
  cb: (snap: DataSnapshot, previousChildName: string | null) => void,
  cancelCallbackOrOptions?: ((error: Error) => void) | ListenOptions,
  options?: ListenOptions,
): Unsubscribe {
  return subscribeChild(r, 'child_changed', cb, cancelCallbackOrOptions, options);
}

/**
 * `onChildRemoved(ref, cb)` — subscribe to child-removed events.
 *
 * Semantics (oracle: `rtdb-modular-onchildremoved-fires-on-delete`):
 *
 *   - No initial replay.
 *   - Fires when a direct child is deleted (via `remove(child)` or
 *     `set(child, null)`).
 *   - Snapshot carries the PRIOR (now-removed) value — the listener
 *     sees what was there before deletion.
 *
 * Also accepts a {@link Query}: a child LEAVING the query window (e.g.
 * displaced past a `limitTo*` boundary or filtered out) fires
 * `child_removed` carrying its prior value.
 */
export function onChildRemoved(
  r: DatabaseReference | Query,
  cb: (snap: DataSnapshot, previousChildName: string | null) => void,
  cancelCallbackOrOptions?: ((error: Error) => void) | ListenOptions,
  options?: ListenOptions,
): Unsubscribe {
  return subscribeChild(r, 'child_removed', cb, cancelCallbackOrOptions, options);
}

/**
 * `onChildMoved(ref, cb)` — subscribe to child-moved events.
 *
 * Semantics (oracle: `rtdb-modular-onchildmoved-with-orderby`):
 *
 *   - Only fires under an ordered query (`query(ref, orderByChild(...))`).
 *   - Under a plain ref, this listener is effectively a no-op — the
 *     upstream SDK accepts the subscription but never fires it
 *     (matches RTDB docs).
 *
 * Accepts a {@link Query} and fires when the active ordered value changes,
 * including the Firebase `previousChildName` second callback argument.
 */
export function onChildMoved(
  r: DatabaseReference | Query,
  cb: (snap: DataSnapshot, previousChildName: string | null) => void,
  cancelCallbackOrOptions?: ((error: Error) => void) | ListenOptions,
  options?: ListenOptions,
): Unsubscribe {
  return subscribeChild(r, 'child_moved', cb, cancelCallbackOrOptions, options);
}

type ChildEvent = 'child_added' | 'child_changed' | 'child_removed' | 'child_moved';

function subscribeChild(
  r: DatabaseReference | Query,
  event: ChildEvent,
  cb: (snap: DataSnapshot, previousChildName: string | null) => void,
  cancelCallbackOrOptions?: ((error: Error) => void) | ListenOptions,
  options?: ListenOptions,
): Unsubscribe {
  const cancelCallback = typeof cancelCallbackOrOptions === 'function'
    ? cancelCallbackOrOptions
    : undefined;
  const listenOptions = typeof cancelCallbackOrOptions === 'function'
    ? options
    : cancelCallbackOrOptions;
  if (!listenOptions?.onlyOnce) return onChildEvent(r, event, cb, cancelCallback);

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
    unsubscribe = onChildEvent(r, event, wrapped, cancelCallback);
    attaching = false;
    if (initial.length > 0) {
      stopped = true;
      unsubscribe();
      // Firebase queues an existing child_added batch before its only-once
      // detach takes effect and delivers that batch in reverse key order.
      for (const [snap, previousChildName] of initial.reverse()) {
        try {
          cb(snap, previousChildName);
        } catch {
          // Listener exceptions are isolated; one child in the captured
          // initial batch must not abort the remaining deliveries.
        }
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
  unsubscribe = onChildEvent(r, event, once, cancelCallback);
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
): void {
  for (const registration of listenerRegistry.takeMatching(target, path, event)) {
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
  cancelCallback?: (error: Error) => void,
): Unsubscribe {
  // Unwrap a Query into its base ref + spec; a plain ref has no spec.
  const isQ = isQuery(r as object);
  const baseRef = isQ ? (r as Query).ref : (r as DatabaseReference);
  const spec = isQ ? (r as Query)._spec : undefined;
  const target = targetOf(baseRef as unknown as object);
  const wrapper = (raw: {
    key: string;
    val: JsonValue;
    previousChildName: string | null;
  }): void => {
    // Synthesize a snapshot rooted at the child path so `snap.key`
    // and `snap.val()` match the upstream `onChildAdded` snapshot
    // shape (key = the child's key, val = the child's value).
    const childRef = child(baseRef, raw.key);
    const snap = buildSandboxSnapFromRaw(target, childRef, raw.val);
    try {
      cb(snap, raw.previousChildName);
    } catch {
      // Listener throws are swallowed — match `firebase/database`'s
      // behavior where one observer's exception doesn't block others.
    }
  };
  const unsub = subscribeWithLiveAuth(
    target,
    (auth, onCanceled) => target.backend.onChild(
      auth,
      event,
      baseRef._path,
      wrapper,
      spec,
      cancelCallback,
      onCanceled,
    ),
  );
  const registration: ListenerRegistration = { unsubscribe: unsub };
  listenerRegistry.add(target, baseRef._path, event, cb, registration);
  return () => {
    listenerRegistry.removeExact(target, baseRef._path, event, cb, registration);
    unsub();
  };
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
  r: DatabaseReference,
  eventType?: 'value' | ChildEvent,
  callback?: (snap: DataSnapshot) => void,
): void {
  const target = targetOf(r as unknown as object);
  if (callback !== undefined && eventType !== undefined) {
    listenerRegistry.takeFirst(target, r._path, eventType, callback)?.unsubscribe();
    return;
  }
  cancelSubscriptions(target, r._path, eventType);
}
