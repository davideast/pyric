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
import { attachClientManagedListener } from './sandbox/client-listener-bridge.js';
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
import { createSnapshotMetadata } from './snapshot-metadata.js';
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
  const clientState = clientStateFor(target);
  clientState.markStarted();
  const r = resolveSandboxListenable(target, ref);
  let attribution: SnapshotListenOptions | undefined;
  if (typeof arg2 === 'object' && arg2 !== null && !isPartialObserver(arg2)) {
    attribution = arg2 as SnapshotListenOptions;
  }
  const activity = beginFirestoreActivity(target, ref, 'onSnapshot', 'subscription', attribution);
  let stopped = false;
  let errored = false;
  const hooks: ListenerHooks = {
    onNext: () => {
      errored = false;
    },
    onError: () => {
      errored = true;
    },
  };
  const parsed = extractConsumerHandlers(arg2, arg3, arg4, target, ref as object, activity, hooks);
  if (!parsed.hasAnyHandler) {
    activity.fail();
    throw new TypeError(
      'onSnapshot: missing handler. Provide a callback, or an observer with a `next` and/or `error` method.',
    );
  }

  let unsubscribe: Unsubscribe;
  try {
    unsubscribe = attachClientManagedListener({
      clientState,
      ref: ref as { type?: string; path?: string },
      underlying: underlyingOf(ref),
      includeMetadataChanges: attribution?.includeMetadataChanges === true,
      attachBackend: (onSnap, onError) => {
        let baseArgs: unknown[] = [onSnap, onError];
        if (attribution !== undefined) {
          baseArgs = [attribution, onSnap, onError];
        }
        const finalArgs = markSandboxLiveSnapshotArgs(baseArgs, target);
        return sdkActivity.registering(activity, () => {
          if (finalArgs.length === 3) return r.onSnapshot(finalArgs[0], finalArgs[1], finalArgs[2]);
          return r.onSnapshot(finalArgs[0], finalArgs[1]);
        });
      },
      deliverSnap: parsed.deliverNext,
      deliverError: parsed.deliverError,
    });
  } catch (error) { activity.fail(); throw error; }
  if (!target.own) return () => { activity.close(); unsubscribe(); };
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    activity.close();
    unsubscribe();
  };
  const abort = (): void => {
    if (stopped) return;
    if (errored) {
      stop();
      return;
    }
    activity.fail();
    stop();
    parsed.abortErrorHandler?.(
      new FirebaseError('aborted', 'The operation was aborted.'),
    );
  };
  const release = target.own(abort);
  return () => {
    release();
    stop();
  };
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

interface ListenerHooks {
  onNext: () => void;
  onError: () => void;
}

function extractConsumerHandlers(
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
  hooks: ListenerHooks,
): {
  readonly hasAnyHandler: boolean;
  readonly deliverNext: (snap: unknown) => void;
  readonly deliverError: (error: unknown) => void;
  readonly abortErrorHandler: ((error: unknown) => void) | undefined;
} {
  const isOptions = typeof arg2 === 'object' && arg2 !== null && !isPartialObserver(arg2);
  let handlerSlot: unknown = arg2;
  let trailingErrorSlot: ((error: unknown) => void) | undefined;
  if (isOptions) {
    handlerSlot = arg3;
    trailingErrorSlot = arg4;
  } else if (typeof arg3 === 'function') {
    trailingErrorSlot = arg3 as (error: unknown) => void;
  }

  if (typeof handlerSlot === 'function') {
    const nextFn = handlerSlot as (snap: unknown) => void;
    let errFn: (error: unknown) => void = defaultSnapshotErrorHandler;
    if (typeof trailingErrorSlot === 'function') {
      errFn = trailingErrorSlot;
    }
    const wrappedErr = wrapError(errFn, activity, hooks.onError);
    return {
      hasAnyHandler: true,
      deliverNext: wrapNext(nextFn, target, source, activity, hooks.onNext),
      deliverError: wrappedErr,
      abortErrorHandler: wrappedErr,
    };
  }

  if (handlerSlot !== null && typeof handlerSlot === 'object' && isPartialObserver(handlerSlot)) {
    const obs = handlerSlot as SnapshotObserver<unknown>;
    let nextDelivery: (snap: unknown) => void = (snap) => {
      hooks.onNext();
      const value = finalizeSandboxSnapshot(tagSnapshotRefs(snap, target), target, source);
      activity.delivered(value);
      clientStateFor(target).notifySnapshotDelivered();
    };
    if (typeof obs.next === 'function') {
      nextDelivery = wrapNext(obs.next.bind(obs), target, source, activity, hooks.onNext);
    }
    const wrappedObsError = wrapError(resolveObserverErrorCallback(obs), activity, hooks.onError);
    return {
      hasAnyHandler: true,
      deliverNext: nextDelivery,
      deliverError: wrappedObsError,
      abortErrorHandler: wrappedObsError,
    };
  }

  return {
    hasAnyHandler: false,
    deliverNext: () => {},
    deliverError: () => {},
    abortErrorHandler: undefined,
  };
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
    docChanges?: () => Array<{ type?: string; doc?: object }>;
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
    if (typeof s.docChanges === 'function') {
      for (const change of s.docChanges()) {
        if (change.type === 'removed' && change.doc) {
          wrapSandboxDocSnap(change.doc, target);
          if (hasConverter) applyConverterToDeliveredSnap(change.doc, conv, target, 'query-child');
        }
      }
    }
    const rawMeta = (snap as { metadata?: { fromCache?: boolean; hasPendingWrites?: boolean } }).metadata;
    Object.defineProperty(snap, 'metadata', {
      value: createSnapshotMetadata(Boolean(rawMeta?.fromCache), Boolean(rawMeta?.hasPendingWrites)),
      configurable: true,
    });
    Object.defineProperty(snap, 'query', {
      value: source,
      configurable: true,
      enumerable: true,
    });
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
  onNext: () => void,
): (snap: unknown) => void {
  return (snap) => {
    onNext();
    const value = finalizeSandboxSnapshot(tagSnapshotRefs(snap, target), target, source);
    activity.delivered(value);
    next(value);
    clientStateFor(target).notifySnapshotDelivered();
  };
}

function resolveObserverErrorCallback(obs: SnapshotObserver<unknown>): (error: unknown) => void {
  if (typeof obs.error === 'function') return obs.error.bind(obs);
  return defaultSnapshotErrorHandler;
}

function wrapError(
  callback: (error: unknown) => void,
  activity: SdkActivityHandle,
  onError?: () => void,
): (error: unknown) => void {
  return error => {
    onError?.();
    activity.fail();
    callback(toFirestoreFirebaseError(error));
  };
}
