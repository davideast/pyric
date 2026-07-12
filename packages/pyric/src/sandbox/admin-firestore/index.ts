/**
 * `pyric-admin` — Admin-SDK-shaped chainable Firestore adapter for
 * the Pyric sandbox.
 *
 * `getFirestore(ctx)` returns a `SandboxFirestore` whose operations
 * run under the context's auth identity and against the underlying
 * `LocalEnvironment` of the context's sandbox. Idempotent — a second
 * call with the same `SandboxContext` returns the same wrapper.
 *
 * Wraps the `pyric/sandbox/admin-compat` implementation.
 * Per-operation methods construct a fresh delegate so a
 * `sandbox.reset()` (which swaps the underlying environment) is
 * picked up on the next operation. Refs returned from the wrapper
 * (`DocumentReference`, `Query`) are bound to whichever environment
 * was live when they were obtained — re-acquire them after reset to
 * avoid stale-state confusion.
 */

import { createCompatFirestore } from 'pyric/sandbox/admin-compat';
import type {
  CollectionReference,
  DocumentData,
  DocumentReference,
  Firestore,
  LiveDocumentSnapshot,
  LiveQuerySnapshot,
  OperationOptions,
  Query,
  SnapshotListenerOptions,
  Transaction,
  WriteBatch,
} from 'pyric/sandbox/admin-compat';
import type { LintResult } from 'pyric/rules/internal';

import { isRemoteSandbox, SandboxError, type AuthLens, type AuthState, type Sandbox, type SandboxContext } from 'pyric/sandbox';
import { getInternalEnv } from 'pyric/sandbox/internal';
import { CONTEXT_SYMBOL, registerOnSnapshotImpl, wrapWithErrorTranslation } from './error-translation.js';
import { createRemoteFirestore } from './remote/remote-firestore.js';
import {
  getRemoteSnapshotRegistrar,
  registerRemoteOnSnapshotImpl,
} from './remote/listeners.js';

// Re-export commonly-needed foundation types so most consumers can
// import everything from `pyric-admin`. Anyone needing more reaches
// into `pyric/sandbox` directly.
export type {
  AuthState,
  Sandbox,
  SandboxContext,
} from 'pyric/sandbox';
export { SandboxError } from 'pyric/sandbox';

// Re-export the production-shaped types so consumers can spell them
// with a `pyric-admin` import path.
//
// `DocumentSnapshot`, `QueryDocumentSnapshot`, `QuerySnapshot` are
// re-exported from the Web-SDK-shaped snapshot-listener types — that's
// what `onSnapshot` callbacks receive and what consumers expect when
// they spell the type. Refs returned by `db.doc()` / `db.collection()`
// also produce data via `.get()`, but those return values use the
// Admin-shaped variants which are exported with `Admin*` prefixes for
// the rare consumer that needs them in the same file.
export type {
  AggregateField,
  AggregateQuerySnapshot,
  AggregateSpec,
  Filter,
  CollectionReference,
  DocumentData,
  DocumentReference,
  DocumentSnapshot as AdminDocumentSnapshot,
  FieldValueSentinel,
  Firestore,
  OrderDirection,
  Query,
  QueryDocumentSnapshot as AdminQueryDocumentSnapshot,
  QuerySnapshot as AdminQuerySnapshot,
  SetOptions,
  Transaction,
  WhereFilterOp,
  WriteBatch,
} from 'pyric/sandbox/admin-compat';
export type { LintResult, LintWarning, RulesMetrics } from 'pyric/rules/internal';
export { FieldValue, Timestamp } from 'pyric/sandbox/admin-compat';

// Web-SDK-shaped snapshot types — what `onSnapshot` callbacks receive.
// Spelled with the conventional Web SDK names so consumers can type
// their callbacks naturally:
//
//   import { onSnapshot, type DocumentSnapshot } from 'pyric-admin/firestore';
//   onSnapshot(db.doc('games/g1'), (snap: DocumentSnapshot) => { ... });
export type {
  LiveDocumentSnapshot as DocumentSnapshot,
  LiveQueryDocumentSnapshot as QueryDocumentSnapshot,
  LiveQuerySnapshot as QuerySnapshot,
  DocumentChange,
  DocumentChangeType,
  DocChangesOptions,
  SnapshotMetadata,
} from 'pyric/sandbox/admin-compat';

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
 * Returned from `onSnapshot`. Calling it deregisters the listener and
 * stops further callback invocations. Idempotent.
 */
export type Unsubscribe = () => void;

/**
 * Observer form accepted by `onSnapshot`. Mirrors `firebase/firestore`'s
 * `PartialObserver<T>` shape — any subset of the three handlers. `complete`
 * is accepted for shape parity but never fires in the sandbox: the local
 * listener stream has no terminal state.
 */
export interface SnapshotObserver<T> {
  next?: (snapshot: T) => void;
  error?: (error: unknown) => void;
  complete?: () => void;
}

/**
 * Sandbox-extended Firestore handle. Adds three sandbox-only methods
 * on top of the production-shaped {@link Firestore} surface:
 *
 *   - {@link SandboxFirestore.setRules} — replace the active ruleset
 *     for subsequent operations.
 *   - {@link SandboxFirestore.seed} — replace stored documents with a
 *     fresh seed map (rules are preserved).
 *   - {@link SandboxFirestore.snapshot} — capture all stored documents
 *     as a path-keyed map.
 *
 * These have no production analog. They use sandbox vocabulary
 * (`setRules`, `seed`, `snapshot`) deliberately so a reader can't
 * confuse them with Firebase deployment semantics.
 */
export interface SandboxFirestore extends Firestore {
  /**
   * Replace the active ruleset. Returns the lint result so callers can
   * surface warnings; if the source has parse-level errors, the rules
   * are not swapped (consistent with `LocalEnvironment.deployRules`).
   */
  setRules(rules: string): LintResult;

  /**
   * Replace stored documents with a new seed map. Active rules are
   * preserved. Pass an empty `documents` map (or omit it) to clear
   * state without touching rules.
   */
  seed(options?: { documents?: Record<string, DocumentData> }): LintResult;

  /**
   * Capture every stored document as a `{ [path]: data }` map. Reads
   * from the live state and is independent of rules.
   */
  snapshot(): Record<string, DocumentData>;
}

/**
 * Idempotency cache. Each `SandboxContext` gets its own handle because
 * each context carries its own auth identity. Cached by reference,
 * garbage-collected with the context.
 */
const handleCache = new WeakMap<SandboxContext, SandboxFirestore>();

/**
 * Build a `SandboxFirestore` that delegates each operation to a freshly
 * constructed compat impl. Constructing the delegate per-call is cheap
 * (no allocation cost beyond the class instance) and ensures the
 * operation reads from whatever environment the sandbox currently
 * exposes — `reset()` propagates without explicit cache invalidation.
 *
 * The handle ignores any per-op `OperationOptions` it receives and
 * always issues operations under `ctx.auth`. To test as a different
 * user, derive a sibling context via `sandbox.withAuth(...)` and
 * attach a service handle to that.
 */
function buildFirestoreHandle(
  ctx: SandboxContext,
  bypassRules = false,
): SandboxFirestore {
  // Invariant: remote-branded sandboxes are dispatched to the channel-backed
  // arm by getFirestore/getAdminFirestore before this builder runs. Reaching
  // here with a remote ctx means a dispatch bug, not a capability gap.
  if (isRemoteSandbox(ctx.sandbox)) {
    throw new Error(
      'pyric/sandbox/admin-firestore: internal — a remote sandbox context ' +
        'reached the local engine builder; remote dispatch should have ' +
        'handled it. Please report this.',
    );
  }
  const delegate = (): Firestore =>
    createCompatFirestore(getInternalEnv(ctx.sandbox), { auth: ctx.auth, bypassRules });

  return {
    // ── Production-shaped surface ────────────────────────────────────
    collection(path: string): CollectionReference {
      return delegate().collection(path);
    },
    doc(path: string): DocumentReference {
      return delegate().doc(path);
    },
    collectionGroup(collectionId: string): Query {
      return delegate().collectionGroup(collectionId);
    },
    batch(): WriteBatch {
      return delegate().batch();
    },
    runTransaction<R>(
      fn: (tx: Transaction) => Promise<R> | R,
      _opts?: OperationOptions,
    ): Promise<R> {
      return delegate().runTransaction(fn);
    },

    // ── Sandbox-only surface ─────────────────────────────────────────
    setRules(rules: string): LintResult {
      return getInternalEnv(ctx.sandbox).deployRules(rules);
    },
    seed(options?: { documents?: Record<string, DocumentData> }): LintResult {
      const env = getInternalEnv(ctx.sandbox);
      // `LocalEnvironment.seed` rebuilds state and returns the lint of
      // the (preserved) ruleset. Pass the current rules through so
      // `db.seed({ documents })` doesn't accidentally clear them.
      return env.seed({
        rules: env.getRules(),
        documents: options?.documents ?? {},
      });
    },
    snapshot(): Record<string, DocumentData> {
      return getInternalEnv(ctx.sandbox).snapshot();
    },
  };
}

/**
 * Resolve the Firestore service handle for a context. Idempotent —
 * subsequent calls with the same context return the same wrapper.
 *
 * Requires a `SandboxContext`, never a bare `Sandbox`. Anonymous is
 * `sandbox.withAuth(null)`, written explicitly — every call site
 * states identity.
 *
 * @example
 * ```ts
 * import { initializeSandbox } from 'pyric/sandbox';
 * import { getFirestore } from 'pyric-admin/firestore';
 *
 * const sandbox = initializeSandbox();
 * const db = getFirestore(sandbox.withAuth({ uid: 'alice' }));
 * db.setRules(MY_RULES);
 * db.seed({ documents: { 'tickets/T-1': { ... } } });
 *
 * // Different identity? Different context, same data.
 * const dbAsBob = getFirestore(sandbox.withAuth({ uid: 'bob' }));
 * ```
 */
export function getFirestore(ctx: SandboxContext): SandboxFirestore {
  const cached = handleCache.get(ctx);
  if (cached) return cached;
  // REMOTE ARM (remote sandbox, slice 2): a remote-branded sandbox has no
  // in-process engine — return the channel-backed parallel implementation
  // instead of building the local compat handle. Identity mapping: the
  // context's frozen auth pins the per-op lens — `withAuth(null)` means
  // `{ mode: 'anon' }` (an ABSENT lens would silently resolve to the
  // browser tab's port session), and a signed identity pins
  // `{ mode: 'as', uid, token? }` with the FULL claims token (the worker
  // resolves it via `sandbox.withAuth({ uid, token })`, so custom claims
  // evaluate in rules exactly as on the local arm).
  const fresh = isRemoteSandbox(ctx.sandbox)
    ? createRemoteFirestore(ctx.sandbox, lensForAuth(ctx.auth))
    : // Wrap the raw handle so every operation (and every object returned
      // from it: `DocumentReference`, `Query`, `WriteBatch`, `Transaction`)
      // re-throws compat errors as `SandboxError` with structured
      // `denialContext`. The wrapper also stashes `ctx` on every wrapped
      // value via CONTEXT_SYMBOL so `onSnapshot` can recover it.
      wrapWithErrorTranslation(buildFirestoreHandle(ctx), ctx);
  handleCache.set(ctx, fresh);
  return fresh;
}

/** Map a context's frozen `AuthState` to the worker-relay lens the remote
 *  arm pins on every op/sub. Never absent — see {@link getFirestore}. */
function lensForAuth(auth: AuthState): AuthLens {
  if (auth === null || auth === undefined) return { mode: 'anon' };
  return auth.token === undefined
    ? { mode: 'as', uid: auth.uid }
    : { mode: 'as', uid: auth.uid, token: auth.token };
}

/**
 * Idempotency cache for admin (rules-bypassing) handles. Keyed by ctx,
 * SEPARATE from {@link handleCache} so the same `SandboxContext` can vend
 * both a rules-enforced handle (`getFirestore`) and a rules-bypassing one
 * (`getAdminFirestore`) without one clobbering the other.
 */
const adminHandleCache = new WeakMap<SandboxContext, SandboxFirestore>();

/**
 * Resolve a **rules-bypassing** Firestore handle for a context — the
 * Pyric Studio admin lens (Gap #2). Same chainable `SandboxFirestore`
 * surface as {@link getFirestore}, but every operation it issues (reads,
 * writes, queries, batches, transactions) SKIPS security-rule evaluation
 * and is treated as ALLOW. This is the modular/chainable-shaped sibling of
 * the path-string `sandbox.admin.*` bypass — it reuses the exact same
 * `LocalEnvironment` bypass execution path (`bypassRules` on the op),
 * rather than reimplementing it.
 *
 * Storage preconditions still apply (a `create` on an existing doc still
 * fails `already-exists`, matching real Firestore admin), and the same
 * `request`/`write` events fire + listeners wake, so the change shows up
 * live and on the traffic log (stamped as an admin-bypass read/write).
 *
 * Use for "edit anything as admin" surfaces (Studio F2). For rules-applied
 * impersonation ("act as this user"), use `getFirestore(sandbox.withAuth({
 * uid }))` instead — that path is unchanged.
 *
 * @example
 * ```ts
 * import { initializeSandbox } from 'pyric/sandbox';
 * import { getFirestore, getAdminFirestore } from 'pyric-admin/firestore';
 *
 * const sandbox = initializeSandbox();
 * getFirestore(sandbox.withAuth(null)).setRules('...deny everything...');
 *
 * // Denied under rules:
 * await getFirestore(sandbox.withAuth({ uid: 'alice' }))
 *   .doc('locked/x').set({ a: 1 }); // throws permission-denied
 *
 * // Bypasses rules:
 * await getAdminFirestore(sandbox).doc('locked/x').set({ a: 1 }); // ok
 * ```
 */
export function getAdminFirestore(ctx: SandboxContext): SandboxFirestore;
export function getAdminFirestore(sandbox: Sandbox): SandboxFirestore;
export function getAdminFirestore(target: SandboxContext | Sandbox): SandboxFirestore {
  // Admin reads/writes are identity-agnostic (rules are off), so a bare
  // `Sandbox` is accepted as well as a `SandboxContext`. A bare sandbox is
  // normalised to an anonymous ctx — the captured auth is irrelevant since
  // no rule reads `request.auth` on the bypass path.
  const ctx: SandboxContext = isSandboxContext(target)
    ? target
    : target.withAuth(null);
  const cached = adminHandleCache.get(ctx);
  if (cached) return cached;
  // REMOTE ARM: rules bypass rides the worker's `{ mode: 'admin' }` lens
  // (the same lens Studio's admin surface uses) — identity-agnostic, so
  // the normalised ctx's auth is irrelevant, exactly like the local path.
  const fresh = isRemoteSandbox(ctx.sandbox)
    ? createRemoteFirestore(ctx.sandbox, { mode: 'admin' })
    : wrapWithErrorTranslation(buildFirestoreHandle(ctx, true), ctx);
  adminHandleCache.set(ctx, fresh);
  return fresh;
}

/**
 * Brand test for the `SandboxContext` overload of {@link getAdminFirestore}.
 * A `SandboxContext` carries `withAuth` + a `sandbox` back-reference; a bare
 * `Sandbox` carries `withAuth` too but also `admin`/`currentUser`. We test
 * for the `sandbox` property which only the context has.
 */
function isSandboxContext(target: SandboxContext | Sandbox): target is SandboxContext {
  return (
    target !== null &&
    typeof target === 'object' &&
    'sandbox' in target &&
    typeof (target as { withAuth?: unknown }).withAuth === 'function'
  );
}

// ─── onSnapshot ────────────────────────────────────────────────────────
//
// Web-SDK-shaped streaming reads. The four overloads mirror
// `firebase/firestore`'s `onSnapshot` so existing call sites copied from
// production code typecheck unchanged.
//
// Routing:
//   - `DocumentReference` → `LocalEnvironment.addSnapshotListener`
//      with `target = { kind: 'doc', path }`.
//   - `CollectionReference` (and any `Query` whose collection root is
//      reachable via `.path` or `.parent.path`) → `target = { kind: 'query', collection }`.
//   - Chained queries (`.where`/`.orderBy`/`.limit`) currently route as
//      whole-collection listeners; the simulator fires for any change in
//      the collection, and the callback receives every document. Slice 6
//      will add filter/order honoring at the listener layer.
//
// The registering context's `auth` is captured at register time and
// threaded through to `addSnapshotListener` so notifications evaluate
// rules under the auth that subscribed — not whatever auth happens to
// be active when a write triggers dispatch
// (`addSnapshotListener`'s auth-capture invariant).

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
  if (FOLLOWS_CURRENT_USER in options) {
    const { [FOLLOWS_CURRENT_USER]: _omit, ...rest } = options as Record<PropertyKey, unknown>;
    options = rest as SnapshotListenOptions;
  }

  // A `next`-less (error-only) observer registers with a no-op data handler
  // so the listener machinery stays on its non-optional callback contract;
  // denials still route to `onError` (FS-B14).
  return env.addSnapshotListener(
    target, onNext ?? (() => {}), options, ctx.auth, onError, followsCurrentUser,
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
// function (a static back-import from remote.ts would be a cycle).
registerOnSnapshotImpl(onSnapshot as (ref: unknown, ...args: unknown[]) => () => void);
registerRemoteOnSnapshotImpl(onSnapshot as (ref: unknown, ...args: unknown[]) => () => void);
