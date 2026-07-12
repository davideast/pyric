/**
 * `pyric/firestore` — snapshot listeners.
 *
 * `onSnapshot` plus the sandbox listener plumbing: resolving the listenable
 * under current auth, threading the follows-current-user marker, tagging +
 * rehydrating delivered snapshots, and the default uncaught-error handler.
 */
import * as fb from 'firebase/firestore';
import { FOLLOWS_CURRENT_USER } from 'pyric/sandbox/admin-firestore';
import type { DocumentData } from 'pyric/sandbox/admin-firestore';

import {
  targetOf,
  isSandboxKind,
  sandboxDb,
  sandboxLiveRebuild,
  underlyingOf,
  type Target,
  type SandboxTarget,
  type SandboxLiveTarget,
} from './state.js';
import { wrapSandboxDocSnap, tagSnapshotRefs } from './snapshots.js';
import type {
  DocumentReference,
  Query,
  Unsubscribe,
} from './types.js';

// ─── Snapshot listeners ───────────────────────────────────────────────

export interface SnapshotListenOptions {
  includeMetadataChanges?: boolean;
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
  if (isSandboxKind(target)) {
    // Resolve the chainable ref. For frozen sandbox, this is the held
    // chainable; for sandbox-live, build a fresh chainable bound to the
    // *current* `sandbox.currentUser` — the listener captures that
    // identity as its initial auth. For sandbox-live the listener also
    // FOLLOWS `currentUser`: a later sign-out / sign-in re-evaluates it
    // under the new auth (an auth-gated listener loses access on
    // sign-out, regains under a different signed-in user). This matches
    // production, which re-establishes the listen stream on a session
    // auth change. Frozen-ctx (`getFirestore(ctx)`) listeners stay
    // pinned to their chosen identity (admin/testing path).
    const r = resolveSandboxListenable(target, ref);
    // Wrap the next callback so any ref the snapshot carries (the
    // document's `.ref` for a doc snapshot; each doc's `.ref` for a
    // query snapshot) gets tagged in `refToTarget` before the consumer
    // ever sees it. Without this, `snap.ref` / `snap.docs[i].ref`
    // come back from the chainable adapter untagged, and the next
    // `onSnapshot(ref, …)` / `setDoc(ref, …)` throws
    // "pyric/firestore: unrecognized reference."
    const wrappedArgs = tagSandboxSnapshotArgs(arg2, arg3, arg4, target);
    // Thread the live-vs-frozen marker down to the chainable adapter so
    // it can set `addSnapshotListener`'s `followsCurrentUser` flag. The
    // adapter sees only a `SandboxContext` and can't recover the
    // distinction on its own; we stamp an internal symbol onto the
    // forwarded options object (prepending one when the call used the
    // callback-first form). The adapter reads + strips it.
    const finalArgs = markSandboxLiveSnapshotArgs(wrappedArgs, target);
    return finalArgs.length === 3
      ? r.onSnapshot(finalArgs[0], finalArgs[1], finalArgs[2])
      : finalArgs.length === 2
        ? r.onSnapshot(finalArgs[0], finalArgs[1])
        : r.onSnapshot(finalArgs[0]);
  }
  // prod — `firebase/firestore`'s onSnapshot takes the same arg shapes.
  // fb's modular SDK already returns refs that route through `targetOf`'s
  // `TARGET_SYMBOL` path (we set the symbol on each ref the package
  // exposes), so no wrapping is needed on the prod side.
  const fbRef = ref as unknown as fb.DocumentReference | fb.Query;
  // The fb overload set is wide — cast through `any` for the arg
  // forwarding; the types match at runtime.
  return arg4 !== undefined
    ? (fb.onSnapshot as unknown as (...a: unknown[]) => Unsubscribe)(fbRef, arg2, arg3, arg4)
    : arg3 !== undefined
      ? (fb.onSnapshot as unknown as (...a: unknown[]) => Unsubscribe)(fbRef, arg2, arg3)
      : (fb.onSnapshot as unknown as (...a: unknown[]) => Unsubscribe)(fbRef, arg2);
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
 * adapter. Only used for the sandbox target — prod refs from
 * `firebase/firestore` already carry `TARGET_SYMBOL`.
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
      return [arg2, wrapNext(next as (snap: unknown) => void, target), arg4 ?? defaultSnapshotErrorHandler];
    }
    if (next && typeof next === 'object') {
      return [arg2, wrapObserver(next as SnapshotObserver<unknown>, target)];
    }
    return [arg2];
  }
  // (next | observer, error?)
  if (typeof arg2 === 'function') {
    return [
      wrapNext(arg2 as (snap: unknown) => void, target),
      (arg3 as ((error: unknown) => void) | undefined) ?? defaultSnapshotErrorHandler,
    ];
  }
  if (arg2 && typeof arg2 === 'object') {
    return [wrapObserver(arg2 as SnapshotObserver<unknown>, target)];
  }
  return [arg2];
}

/**
 * Stamp the internal `FOLLOWS_CURRENT_USER` marker onto the options
 * object of a forwarded `onSnapshot` arg tuple, so the chainable adapter
 * can set `addSnapshotListener`'s `followsCurrentUser` flag. Only applies
 * to `sandbox-live` targets — frozen-ctx (`sandbox`) and prod listeners
 * keep their pinned identity and are returned unchanged.
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
    const opts = { ...(first as Record<PropertyKey, unknown>), [FOLLOWS_CURRENT_USER]: true };
    return [opts, ...args.slice(1)];
  }
  return [{ [FOLLOWS_CURRENT_USER]: true }, ...args];
}

function finalizeSandboxSnapshot(snap: unknown, target: Target): unknown {
  if (!isSandboxKind(target) || !snap || typeof snap !== 'object') return snap;
  const s = snap as {
    data?: () => DocumentData | undefined;
    docs?: Array<object>;
  };
  if (typeof s.data === 'function') {
    wrapSandboxDocSnap(snap as object);
  }
  if (Array.isArray(s.docs)) {
    for (const d of s.docs) wrapSandboxDocSnap(d as object);
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
): (snap: unknown) => void {
  return (snap) => next(finalizeSandboxSnapshot(tagSnapshotRefs(snap, target), target));
}

function wrapObserver(
  obs: SnapshotObserver<unknown>,
  target: Target,
): SnapshotObserver<unknown> {
  return {
    ...obs,
    next: obs.next
      ? (snap) => obs.next!(finalizeSandboxSnapshot(tagSnapshotRefs(snap, target), target))
      : undefined,
    // Surface an unobserved listener error instead of swallowing it.
    error: obs.error ?? defaultSnapshotErrorHandler,
  };
}
