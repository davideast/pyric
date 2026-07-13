/**
 * `onSnapshot` — Web-SDK-shaped streaming reads over the chainable Admin
 * surface. The four overloads mirror `firebase/firestore`'s `onSnapshot`
 * so existing call sites copied from production code typecheck
 * unchanged.
 *
 * Routing:
 *   - `DocumentReference` → `LocalEnvironment.addSnapshotListener`
 *      with `target = { kind: 'doc', path }`.
 *   - `CollectionReference` (and any `Query` whose collection root is
 *      reachable via `.path` or `.parent.path`) → `target = { kind: 'query', collection }`.
 *   - Chained queries (`.where`/`.orderBy`/`.limit`) currently route as
 *      whole-collection listeners; the simulator fires for any change in
 *      the collection, and the callback receives every document. Slice 6
 *      will add filter/order honoring at the listener layer.
 *
 * The registering context's `auth` is captured at register time and
 * threaded through to `addSnapshotListener` so notifications evaluate
 * rules under the auth that subscribed — not whatever auth happens to
 * be active when a write triggers dispatch
 * (`addSnapshotListener`'s auth-capture invariant).
 *
 * REMOTE ARM: refs minted by the channel-backed handle carry their own
 * listener registrar (`getRemoteSnapshotRegistrar`) — dispatched before
 * any local-engine resolution, since `getInternalEnv` rejects remote
 * handles.
 */

import { SandboxError, type SandboxContext } from 'pyric/sandbox';
import type {
  CollectionReference,
  DocumentReference,
  Query,
  SnapshotListenerOptions,
} from 'pyric/sandbox/admin-compat';
import { getInternalEnv } from 'pyric/sandbox/internal';
import {
  BYPASS_RULES_SYMBOL,
  CONTEXT_SYMBOL,
  registerOnSnapshotImpl,
} from './error-translation.js';
import { getRemoteSnapshotRegistrar, registerRemoteOnSnapshotImpl } from './remote/listeners.js';
import type { SnapshotObserver, Unsubscribe } from './types.js';

/**
 * Mirrors `firebase/firestore`'s `SnapshotListenOptions`. The
 * `includeMetadataChanges` flag is accepted for API parity but has no
 * observable effect in the sandbox: there's no offline cache and no
 * pending-writes window, so `metadata.fromCache` and
 * `metadata.hasPendingWrites` are always `false` (snapshot-listeners.ts section 6).
 */
export type SnapshotListenOptions = SnapshotListenerOptions;

/**
 * Internal channel for the modular `pyric/firestore` layer to mark a
 * listener as live (identity follows `sandbox.currentUser`) vs frozen
 * (`getFirestore(ctx)`, pinned identity). The chainable adapter sees only
 * a `SandboxContext` per call and can't tell the two apart on its own — the
 * live-vs-frozen distinction lives one layer up. The modular `onSnapshot`
 * stamps this symbol onto the options object it forwards; {@link onSnapshot}
 * here reads + strips it and threads the boolean into
 * `LocalEnvironment.addSnapshotListener`'s `followsCurrentUser` parameter.
 *
 * Symbol-keyed (not a named field) so it never collides with a real
 * `SnapshotListenOptions` field and never leaks to consumer code.
 */
export const FOLLOWS_CURRENT_USER: unique symbol = Symbol('pyric/firestore/followsCurrentUser');

/**
 * Extract a `{ collectionPath }` for query-shaped refs. The compat
 * `QueryImpl` keeps its `collectionPath` as a `protected` field, but
 * `CollectionRefImpl` exposes it via the public `path` getter, and
 * chained queries (the only thing `where`/`orderBy`/`limit` produces)
 * inherit from `QueryImpl` — both expose the same internal field.
 *
 * Read it via a structural lookup rather than `instanceof` so this
 * adapter never has to import the compat impl class (which would create
 * a circular dependency through `pyric/sandbox/admin-compat`).
 *
 * Returns `null` for refs we cannot route (anonymous/foreign Query
 * implementations); the caller throws a clear remediation error.
 */
function extractCollectionPath(ref: unknown): string | null {
  if (ref === null || typeof ref !== 'object') return null;
  const obj = ref as { path?: unknown; collectionPath?: unknown };
  // CollectionReference exposes `path` publicly.
  if (typeof obj.path === 'string' && obj.path.length > 0) return obj.path;
  // QueryImpl keeps it on a protected field; protected is a TypeScript-
  // only restriction at runtime, so this lookup succeeds for anything
  // produced by `db.collection('x').where(...)` etc.
  if (typeof obj.collectionPath === 'string' && obj.collectionPath.length > 0) {
    return obj.collectionPath;
  }
  return null;
}

/**
 * Pull the query's `where` / `orderBy` / cursor / `limit` constraints
 * off a query-shaped ref as a pure row transformer (FS-B2), so a
 * filtered `onSnapshot(query(...))` delivers the same membership as a
 * one-shot `getDocs(query(...))`. `QueryImpl.snapshotConstraints()` is a
 * public method on every query produced by `db.collection(...).where(...)`
 * etc.; a bare `CollectionReference` returns `undefined` (no filtering).
 * Structural lookup keeps this adapter from importing the compat class.
 */
function extractSnapshotConstraints(
  ref: unknown,
): import('pyric/sandbox/admin-compat').QueryConstraintApplier | undefined {
  if (ref !== null && typeof ref === 'object') {
    const fn = (ref as { snapshotConstraints?: unknown }).snapshotConstraints;
    if (typeof fn === 'function') {
      return (fn as () => import('pyric/sandbox/admin-compat').QueryConstraintApplier | undefined).call(ref);
    }
  }
  return undefined;
}

/**
 * Discriminate a `DocumentReference` from a `Query`/`CollectionReference`.
 * The Admin-shaped `DocumentReference` always has a `parent: CollectionReference`
 * field; `Query` and `CollectionReference` do not have a `parent` field.
 */
function isDocumentReference(ref: unknown): ref is DocumentReference {
  if (ref === null || typeof ref !== 'object') return false;
  const obj = ref as { parent?: unknown; path?: unknown };
  return (
    typeof obj.path === 'string' &&
    obj.path.length > 0 &&
    obj.parent !== undefined &&
    obj.parent !== null
  );
}

// Overloads — order matches `firebase/firestore`'s `onSnapshot`.
export function onSnapshot(
  reference: DocumentReference,
  observer: SnapshotObserver<import('pyric/sandbox/admin-compat').LiveDocumentSnapshot>,
): Unsubscribe;
export function onSnapshot(
  reference: DocumentReference,
  options: SnapshotListenOptions,
  observer: SnapshotObserver<import('pyric/sandbox/admin-compat').LiveDocumentSnapshot>,
): Unsubscribe;
export function onSnapshot(
  reference: DocumentReference,
  onNext: (snapshot: import('pyric/sandbox/admin-compat').LiveDocumentSnapshot) => void,
  onError?: (error: unknown) => void,
  onCompletion?: () => void,
): Unsubscribe;
export function onSnapshot(
  reference: DocumentReference,
  options: SnapshotListenOptions,
  onNext: (snapshot: import('pyric/sandbox/admin-compat').LiveDocumentSnapshot) => void,
  onError?: (error: unknown) => void,
  onCompletion?: () => void,
): Unsubscribe;
export function onSnapshot(
  reference: Query | CollectionReference,
  observer: SnapshotObserver<import('pyric/sandbox/admin-compat').LiveQuerySnapshot>,
): Unsubscribe;
export function onSnapshot(
  reference: Query | CollectionReference,
  options: SnapshotListenOptions,
  observer: SnapshotObserver<import('pyric/sandbox/admin-compat').LiveQuerySnapshot>,
): Unsubscribe;
export function onSnapshot(
  reference: Query | CollectionReference,
  onNext: (snapshot: import('pyric/sandbox/admin-compat').LiveQuerySnapshot) => void,
  onError?: (error: unknown) => void,
  onCompletion?: () => void,
): Unsubscribe;
export function onSnapshot(
  reference: Query | CollectionReference,
  options: SnapshotListenOptions,
  onNext: (snapshot: import('pyric/sandbox/admin-compat').LiveQuerySnapshot) => void,
  onError?: (error: unknown) => void,
  onCompletion?: () => void,
): Unsubscribe;
/**
 * Implementation. The argument shape is normalized into
 * `{ options, onNext, onError, onCompletion }` here, then routed to
 * `LocalEnvironment.addSnapshotListener`.
 *
 * `onCompletion` is accepted but never invoked: the local listener
 * stream has no terminal state. Documented in the `SnapshotObserver`
 * contract.
 *
 * Routing failures (Query without a discoverable collection path, or a
 * ref that is neither doc nor query) throw immediately — they indicate
 * a programming mistake the caller can fix. Per-call rule denials, by
 * contrast, are routed through `onError` (or swallowed if no handler is
 * supplied), matching production `onSnapshot` behavior.
 */
export function onSnapshot(
  reference: DocumentReference | Query | CollectionReference,
  // `any`-typed callback in the impl signature is intentional: each
  // overload narrows the callback to a specific snapshot shape, but
  // function parameter types are contravariant — a `(snap: LiveDoc) => void`
  // is *not* assignable to a `(snap: unknown) => void`. Using `any`
  // here keeps every overload assignable to the impl signature without
  // weakening the public surface (the overloads are what consumers see).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  arg2: SnapshotListenOptions | SnapshotObserver<any> | ((snapshot: any) => void),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  arg3?: SnapshotObserver<any> | ((snapshot: any) => void) | ((error: unknown) => void),
  arg4?: ((error: unknown) => void) | (() => void),
  arg5?: () => void,
): Unsubscribe {
  // ── Normalize the (options, observer | callback set) variations. ──
  let options: SnapshotListenOptions = {};
  let onNext: ((snapshot: unknown) => void) | undefined;
  let onError: ((error: unknown) => void) | undefined;

  // Detect whether arg2 is the SnapshotListenOptions slot. The options
  // object is the only plain-object value at arg2 that lacks both `next`
  // and an `error` handler shaped like a function — the observer form
  // always has at least one handler. This matches how the Web SDK
  // discriminates.
  const arg2IsOptions =
    typeof arg2 === 'object' &&
    arg2 !== null &&
    typeof (arg2 as { next?: unknown }).next !== 'function' &&
    typeof (arg2 as { error?: unknown }).error !== 'function' &&
    typeof (arg2 as { complete?: unknown }).complete !== 'function';

  if (arg2IsOptions) {
    options = arg2 as SnapshotListenOptions;
    if (typeof arg3 === 'function') {
      onNext = arg3 as (s: unknown) => void;
      onError = arg4 as ((e: unknown) => void) | undefined;
      // arg5 is onCompletion — accepted, never invoked (no terminal state).
    } else if (typeof arg3 === 'object' && arg3 !== null) {
      const obs = arg3 as SnapshotObserver<unknown>;
      onNext = obs.next;
      onError = obs.error;
    }
  } else if (typeof arg2 === 'function') {
    onNext = arg2 as (s: unknown) => void;
    onError = arg3 as ((e: unknown) => void) | undefined;
    // arg4 is onCompletion — accepted, never invoked.
  } else if (typeof arg2 === 'object' && arg2 !== null) {
    const obs = arg2 as SnapshotObserver<unknown>;
    onNext = obs.next;
    onError = obs.error;
  }

  if (!onNext && !onError) {
    // FS-B14 — prod accepts an observer carrying only `error` (or
    // `complete`); it registers and routes denials to the error handler.
    // Only a fully-empty observer (no next AND no error) is a programming
    // error. Pre-fix this required `next`, so an `{ error: fn }` observer
    // threw "missing next handler".
    throw new TypeError(
      'onSnapshot: missing handler. Provide a callback, or an observer with a ' +
        '`next` and/or `error` method.',
    );
  }
  // The local listener stream has no terminal state, so a `next`-less
  // observer registers purely to receive errors — `onNext` stays undefined
  // and `addSnapshotListener` only fires the error path.

  // ── REMOTE ARM: refs minted by the channel-backed handle carry their
  // own listener registrar — dispatch on it BEFORE any local-engine
  // resolution (`getInternalEnv` rejects remote handles). The registrar
  // pins the handle's auth lens on the worker subscription; error
  // callbacks receive `SandboxError`s with `denialContext` when the
  // worker carried one.
  const remoteRegistrar = getRemoteSnapshotRegistrar(reference);
  if (remoteRegistrar) {
    if ((options as { [FOLLOWS_CURRENT_USER]?: boolean })[FOLLOWS_CURRENT_USER] === true) {
      // The live-listener marker is stamped by the modular browser layer,
      // which never runs against a remote handle — defensive throw so a
      // future mis-wiring fails loudly instead of silently freezing.
      throw new SandboxError(
        'unimplemented',
        'onSnapshot: live (follows-current-user) listeners are not supported on a ' +
          'remote sandbox — remote listeners are frozen to the identity of the ' +
          'context that created the ref.',
      );
    }
    return remoteRegistrar(options, onNext, onError);
  }

  // ── Resolve the context + target from the ref. ──
  const ctx = contextFromRef(reference);
  const env = getInternalEnv(ctx.sandbox);

  let target: import('pyric/sandbox/admin-compat').SnapshotTarget;
  if (isDocumentReference(reference)) {
    target = { kind: 'doc', path: reference.path };
  } else {
    const collectionPath = extractCollectionPath(reference);
    if (collectionPath === null) {
      throw new TypeError(
        'onSnapshot: could not determine the collection path for this Query. ' +
          'Pass a CollectionReference or a Query produced by `.where`/`.orderBy`/`.limit` ' +
          'on a CollectionReference obtained from `getFirestore(ctx)`.',
      );
    }
    // FS-B2 — thread the query's where/orderBy/limit/cursor constraints
    // into the target so the listener delivers a filtered/ordered/limited
    // view (matching getDocs), not the whole collection.
    const constraints = extractSnapshotConstraints(reference);
    target = { kind: 'query', collection: collectionPath, constraints };
  }

  // Read the live-vs-frozen marker the modular layer stamped onto the
  // options object (FOLLOWS_CURRENT_USER), then strip it so it never
  // reaches the listener record's public `options`. Absent ⇒ frozen
  // (the safe default for any direct chainable-adapter caller).
  const followsCurrentUser =
    (options as { [FOLLOWS_CURRENT_USER]?: boolean })[FOLLOWS_CURRENT_USER] === true;
  const bypassRules =
    (reference as { [BYPASS_RULES_SYMBOL]?: boolean })[BYPASS_RULES_SYMBOL] === true;
  if (FOLLOWS_CURRENT_USER in options) {
    const { [FOLLOWS_CURRENT_USER]: _omit, ...rest } = options as Record<PropertyKey, unknown>;
    options = rest as SnapshotListenOptions;
  }

  // A `next`-less (error-only) observer registers with a no-op data handler
  // so the listener machinery stays on its non-optional callback contract;
  // denials still route to `onError` (FS-B14).
  return env.addSnapshotListener(
    target,
    onNext ?? (() => {}),
    options,
    ctx.auth,
    onError,
    followsCurrentUser,
    bypassRules,
  );
}

/**
 * Recover the {@link SandboxContext} that produced a ref. Refs returned
 * from `db.doc(path)` / `db.collection(path)` are wrapped by
 * `wrapWithErrorTranslation`, which stashes the owning context on the
 * `CONTEXT_SYMBOL` property of every wrapped object. Reading that
 * symbol gives us the auth + sandbox in one step — multiple contexts
 * can share an env, and this lookup correctly picks the one that
 * produced *this* ref.
 */
function contextFromRef(ref: unknown): SandboxContext {
  if (ref === null || typeof ref !== 'object') {
    throw new TypeError('onSnapshot: reference must be a DocumentReference or Query.');
  }
  const ctx = (ref as { [CONTEXT_SYMBOL]?: SandboxContext })[CONTEXT_SYMBOL];
  if (!ctx) {
    throw new TypeError(
      'onSnapshot: reference was not produced by a sandbox context — pass a ref obtained from `getFirestore(ctx)`.',
    );
  }
  return ctx;
}

// ─── Chainable `.onSnapshot(...)` shim ─────────────────────────────────
//
// The free `onSnapshot(ref, observer)` function above mirrors
// `firebase/firestore`'s modular shape. The rest of `pyric-admin` is
// chainable-method-shaped, though, and agents reach for
// `db.collection(path).where(...).onSnapshot(cb)` more often than the
// free form. To eliminate the asymmetry without losing the modular
// surface, we declare a chainable `.onSnapshot(...)` method on
// DocumentReference/CollectionReference/Query via module augmentation
// and synthesize the implementation in the error-translation Proxy.
// Both forms route through the same listener registration.
//
// The free function stays exported — both styles are first-class.

// Augmentation made the chainable `.onSnapshot()` method appear on
// DocumentReference and Query. Under the consolidated layout (admin-compat
// and admin-firestore in the same package), the augmentation strict-checks
// every impl class against this signature, which breaks the impl classes
// that don't define `.onSnapshot()` directly (the Proxy synthesizes it).
//
// Post-cutover behavior: use the free `onSnapshot(ref, observer)` function
// exported above. The chainable `ref.onSnapshot()` continues to work at
// runtime via the Proxy in error-translation.ts, but is no longer typed.
// A future iteration can revive the typed chainable variant by moving the
// augmentation into a separate consumer-facing declaration file that's
// excluded from impl compilation.

// Wire the synthesizer. Done at module init, after `onSnapshot` is
// fully declared so the function reference is stable. The remote arm's
// chainable `ref.onSnapshot(...)` late-binds through the same free
// function (a static import back from remote/listeners.ts would be a cycle).
registerOnSnapshotImpl(onSnapshot as (ref: unknown, ...args: unknown[]) => () => void);
registerRemoteOnSnapshotImpl(onSnapshot as (ref: unknown, ...args: unknown[]) => () => void);
