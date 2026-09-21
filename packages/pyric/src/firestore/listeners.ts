/**
 * `pyric/firestore` — snapshot listeners.
 *
 * `onSnapshot` plus the sandbox listener plumbing: resolving the listenable
 * under current auth, threading the follows-current-user marker, tagging +
 * rehydrating delivered snapshots, and the default uncaught-error handler.
 */
// Modular listeners use the chainable adapter installed by this module.
import '../sandbox/admin-firestore/listeners.js';
import type { DocumentData } from 'pyric/sandbox/admin-firestore';
import { AUTH_SESSION_SCOPE, FOLLOWS_CURRENT_USER } from 'pyric/firestore/internal';
import { FirebaseError } from '../sandbox/internal/firebase-error.js';
import { toFirestoreFirebaseError } from './errors.js';
import { clientStateFor } from './client-state.js';
import { beginFirestoreActivity } from './sdk-activity.js';
import { sdkActivity, type SdkActivityHandle } from '../sandbox/internal/sdk-activity.js';
import type {
  ListenerOwnerHint,
  RecordedListenerOwners,
} from '../sandbox/attribution/listener-owners.js';

import {
  targetOf,
  sandboxDb,
  sandboxLiveRebuild,
  underlyingOf,
  converterOf,
  type Target,
  type SandboxTarget,
  type SandboxLiveTarget,
} from './state.js';
import { wrapSandboxDocSnap, tagSnapshotRefs, recordQuerySnapshot, applyConverterToDeliveredSnap } from './snapshots.js';
import type {
  DocumentReference,
  Query,
  Unsubscribe,
} from './types.js';

// ─── Snapshot listeners ───────────────────────────────────────────────

export interface SnapshotListenOptions extends RecordedListenerOwners {
  includeMetadataChanges?: boolean;
  /**
   * Pyric's own extension, absent from the Firebase Web SDK: who owns this
   * listener. A name, or the DOM element the listener feeds. It is recorded
   * as a `tag` owner on the sandbox's `listener_attach` event so a listener
   * can be traced back to the part of the app that wanted it. It has no
   * effect on delivery, and a production Firestore target ignores it.
   */
  owner?: ListenerOwnerHint;
}

export interface SnapshotObserver<T> {
  next?: (snapshot: T) => void;
  error?: (error: unknown) => void;
  complete?: () => void;
}

export function onSnapshot<T extends DocumentReference | Query>(
  ref: T,
  observerOrNext: SnapshotObserver<unknown> | ((snap: unknown) => void),
  errorOrNothing?: ((error: unknown) => void),
): Unsubscribe;
export function onSnapshot<T extends DocumentReference | Query>(
  ref: T,
  options: SnapshotListenOptions,
  observerOrNext: SnapshotObserver<unknown> | ((snap: unknown) => void),
  errorOrNothing?: ((error: unknown) => void),
): Unsubscribe;
export function onSnapshot(
  ref: DocumentReference | Query,
  arg2: SnapshotListenOptions | SnapshotObserver<unknown> | ((snap: unknown) => void),
  arg3?: SnapshotObserver<unknown> | ((snap: unknown) => void) | ((error: unknown) => void),
  arg4?: (error: unknown) => void,
): Unsubscribe {
  const target = targetOf(ref);
  clientStateFor(target).markStarted();
  const r = resolveSandboxListenable(target, ref);
  const attribution = typeof arg2 === 'object' && arg2 !== null && !isPartialObserver(arg2) ? arg2 as SnapshotListenOptions : undefined;
  const activity = beginFirestoreActivity(target, ref, 'onSnapshot', 'subscription', attribution);
  const wrappedArgs = tagSandboxSnapshotArgs(arg2, arg3, arg4, target, ref as object, activity);
  const finalArgs = markSandboxLiveSnapshotArgs(wrappedArgs, target);
  let unsubscribe: Unsubscribe;
  try {
    unsubscribe = sdkActivity.registering(activity, () => {
      if (finalArgs.length === 3) return r.onSnapshot(finalArgs[0], finalArgs[1], finalArgs[2]);
      if (finalArgs.length === 2) return r.onSnapshot(finalArgs[0], finalArgs[1]);
      return r.onSnapshot(finalArgs[0]);
    });
  } catch (error) { activity.fail(); throw error; }
  if (!target.own) return () => { activity.close(); unsubscribe(); };
  let stopped = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    activity.close();
    unsubscribe();
  };
  const abort = (): void => {
    if (stopped) return;
    activity.fail();
    stop();
    snapshotErrorHandler(finalArgs)?.(
      new FirebaseError('aborted', 'The operation was aborted.'),
    );
  };
  const release = target.own(abort);
  return () => {
    release();
    stop();
  };
}

/** Recover the normalized listener error handler for app-deletion aborts. */
function snapshotErrorHandler(args: unknown[]): ((error: unknown) => void) | undefined {
  const last = args.at(-1);
  if (typeof last === 'function' && args.length >= 3) {
    return last as (error: unknown) => void;
  }
  if (last && typeof last === 'object') {
    const error = (last as SnapshotObserver<unknown>).error;
    if (typeof error === 'function') return error;
  }
  return undefined;
}

/**
 * Pick the chainable object whose `.onSnapshot` we attach to. For
 * `sandbox`, this is just the underlying held chainable (existing
 * behavior). For `sandbox-live`, this is a fresh chainable rebuilt
 * against the current `sandbox.currentUser` — the listener captures
 * that identity as its initial auth. Unlike before, the live listener
 * then FOLLOWS `currentUser`: a later sign-out / sign-in re-evaluates
 * it under the new identity (wired via `FOLLOWS_CURRENT_USER` →
 * `LocalEnvironment.reevaluateLiveListeners`), so an auth-gated
 * listener loses access on sign-out without the caller having to
 * unsubscribe — matching production's listener re-establishment.
 */
function resolveSandboxListenable(
  target: SandboxTarget | SandboxLiveTarget,
  ref: DocumentReference | Query,
): { onSnapshot: (...args: unknown[]) => Unsubscribe } {
  const underlying = underlyingOf(ref);
  if (target.kind === 'sandbox') {
    return underlying as unknown as { onSnapshot: (...args: unknown[]) => Unsubscribe };
  }
  const rebuild = sandboxLiveRebuild.get(underlying);
  if (!rebuild) {
    throw new TypeError(
      'pyric/firestore: live ref missing rebuild closure for onSnapshot.',
    );
  }
  return rebuild(sandboxDb(target)) as unknown as { onSnapshot: (...args: unknown[]) => Unsubscribe };
}

/**
 * Wrap the `next` callback in an `onSnapshot(…)` call so every ref the
 * snapshot carries is tagged into `refToTarget` before delivery. Returns
 * the rewritten arg tuple ready to forward to the underlying chainable
 * adapter.
 */
/**
 * FS-B14 — `true` when `obj` is a partial `onSnapshot` observer (an object
 * carrying at least one of `next` / `error` / `complete` as a function).
 * Mirrors `isPartialObserver` in `clones/.../api/observer.ts`. Used to keep
 * an `{ error: fn }` / `{ complete: fn }` observer from being misrouted as a
 * `SnapshotListenOptions` object.
 */
function isPartialObserver(obj: unknown): boolean {
  if (typeof obj !== 'object' || obj === null) return false;
  const o = obj as Record<string, unknown>;
  return (
    typeof o.next === 'function' ||
    typeof o.error === 'function' ||
    typeof o.complete === 'function'
  );
}

function tagSandboxSnapshotArgs(
  arg2: SnapshotListenOptions | SnapshotObserver<unknown> | ((snap: unknown) => void),
  arg3:
    | SnapshotObserver<unknown>
    | ((snap: unknown) => void)
    | ((error: unknown) => void)
    | undefined,
  arg4: ((error: unknown) => void) | undefined,
  target: Target,
  source: object,
  activity: SdkActivityHandle,
): unknown[] {
  // Detect whether arg2 is the SnapshotListenOptions form. FS-B14 — an
  // observer is any object carrying at least one of `next` / `error` /
  // `complete` as a function (mirrors `isPartialObserver` in
  // `clones/.../api/observer.ts`). The old `!('next' in arg2)` test
  // misrouted an `{ error: fn }` observer as options, dropping it and
  // surfacing "missing next handler". A SnapshotListenOptions object has
  // none of those function-valued keys.
  const isOptions =
    typeof arg2 === 'object' && arg2 !== null && !isPartialObserver(arg2);
  if (isOptions) {
    // (options, next | observer, error?)
    const next = arg3;
    if (typeof next === 'function') {
      return [arg2, wrapNext(next as (snap: unknown) => void, target, source, activity), wrapError(arg4 ?? defaultSnapshotErrorHandler, activity)];
    }
    if (next && typeof next === 'object') {
      return [arg2, wrapObserver(next as SnapshotObserver<unknown>, target, source, activity)];
    }
    return [arg2];
  }
  // (next | observer, error?)
  if (typeof arg2 === 'function') {
    return [
      wrapNext(arg2 as (snap: unknown) => void, target, source, activity),
      wrapError((arg3 as ((error: unknown) => void) | undefined) ?? defaultSnapshotErrorHandler, activity),
    ];
  }
  if (arg2 && typeof arg2 === 'object') {
    return [wrapObserver(arg2 as SnapshotObserver<unknown>, target, source, activity)];
  }
  return [arg2];
}

/**
 * Stamp the internal `FOLLOWS_CURRENT_USER` marker onto the options
 * object of a forwarded `onSnapshot` arg tuple, so the chainable adapter
 * can set `addSnapshotListener`'s `followsCurrentUser` flag. Only applies
 * to `sandbox-live` targets; frozen-ctx listeners keep their pinned identity.
 *
 * `args` is the post-`tagSandboxSnapshotArgs` tuple, which is one of:
 *   - `[options, next|observer, error?]` — options-first form
 *   - `[next|observer, error?]`          — callback-first form
 *   - `[observer]`                       — observer-only form
 *
 * For the options-first form we clone the options and add the symbol.
 * For the other forms we PREPEND a fresh options object carrying only
 * the symbol — safe because the chainable adapter's normalizer
 * discriminates `(options, …)` from `(callback, …)` by inspecting the
 * first arg, and a marker-only object has no `next`/`error`/`complete`
 * handler so it reads as options.
 */
function markSandboxLiveSnapshotArgs(args: unknown[], target: Target): unknown[] {
  if (target.kind !== 'sandbox-live') return args;
  const first = args[0];
  const firstIsOptions =
    typeof first === 'object' && first !== null && !isPartialObserver(first);
  if (firstIsOptions) {
    const opts = {
      ...(first as Record<PropertyKey, unknown>),
      [FOLLOWS_CURRENT_USER]: true,
      ...(target.authScope ? { [AUTH_SESSION_SCOPE]: target.authScope } : {}),
    };
    return [opts, ...args.slice(1)];
  }
  return [{
    [FOLLOWS_CURRENT_USER]: true,
    ...(target.authScope ? { [AUTH_SESSION_SCOPE]: target.authScope } : {}),
  }, ...args];
}

function finalizeSandboxSnapshot(snap: unknown, target: Target, source: object): unknown {
  if (!snap || typeof snap !== 'object') return snap;
  const s = snap as {
    data?: () => DocumentData | undefined;
    docs?: Array<object>;
  };
  const conv = converterOf(source) ?? null;
  const hasConverter = conv !== null;
  if (typeof s.data === 'function') {
    wrapSandboxDocSnap(snap as object, target);
    if (hasConverter) applyConverterToDeliveredSnap(snap as object, conv, target, 'document');
  }
  if (Array.isArray(s.docs)) {
    for (const d of s.docs) {
      wrapSandboxDocSnap(d as object, target);
      if (hasConverter) applyConverterToDeliveredSnap(d as object, conv, target, 'query-child');
    }
    recordQuerySnapshot(snap as object, snap as object, target, source, 'listener');
  }
  return snap;
}

/**
 * Default error handler for a sandbox `onSnapshot` listener whose caller
 * supplied none. Mirrors the Firebase Web SDK, which logs an uncaught listener
 * error to the console rather than swallowing it — WITHOUT this, a denied
 * listener (a rules change, or a sign-out that revokes read access) fails
 * INVISIBLY: the last snapshot stays on screen and the app gets no signal that
 * its read was rejected. (Prod listeners go through the real SDK, which applies
 * its own default; this only fires on the sandbox path.)
 */
function defaultSnapshotErrorHandler(error: unknown): void {
  // eslint-disable-next-line no-console
  console.error('pyric/firestore: Uncaught Error in snapshot listener:', error);
}

function wrapNext(
  next: (snap: unknown) => void,
  target: Target,
  source: object,
  activity: SdkActivityHandle,
): (snap: unknown) => void {
  return (snap) => {
    const value = finalizeSandboxSnapshot(tagSnapshotRefs(snap, target), target, source);
    activity.delivered(value);
    next(value);
    clientStateFor(target).notifySnapshotDelivered();
  };
}

function wrapObserver(
  obs: SnapshotObserver<unknown>,
  target: Target,
  source: object,
  activity: SdkActivityHandle,
): SnapshotObserver<unknown> {
  return {
    ...obs,
    next: obs.next
      ? (snap) => {
          const value = finalizeSandboxSnapshot(tagSnapshotRefs(snap, target), target, source);
          activity.delivered(value);
          obs.next!(value);
          clientStateFor(target).notifySnapshotDelivered();
        }
      : undefined,
    // Surface an unobserved listener error instead of swallowing it.
    error: wrapError(obs.error ?? defaultSnapshotErrorHandler, activity),
  };
}

function wrapError(callback: (error: unknown) => void, activity: SdkActivityHandle): (error: unknown) => void {
  return error => { activity.fail(); callback(toFirestoreFirebaseError(error)); };
}
