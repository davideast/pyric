/**
 * `pyric/database` sandbox-only modular SDK mirror.
 *
 * Mirrors `firebase/database`'s tree-shakable free-function shape:
 * `getDatabase`, `ref`, `child`, `get`, `set`, `update`, `remove`,
 * `push`, `onValue`, `serverTimestamp`, `connectDatabaseEmulator`.
 *
 * Two sandbox identity modes are picked by what's passed to `getDatabase`:
 *
 *   - **Sandbox target** — wraps `RtdbBackend` (in-memory JSON tree
 *     plus the existing RTDB rule simulator). Identity is the
 *     `SandboxContext`'s frozen `auth`.
 *   - **Sandbox-live target** — same backend, but identity is read
 *     per-op from `sandbox.currentUser` so a `pyric/auth`-driven
 *     sign-in flips the next op's `request.auth` without re-binding.
 *
 * Routing machinery mirrors `pyric/firestore`:
 *   - {@link TARGET_SYMBOL} brand on every {@link Database} handle.
 *   - {@link refToTarget} WeakMap from refs to their owning target so
 *     chained calls (`child(ref, 'sub')`, `get(ref)`) recover routing.
 *
 * **Critical contract — error shape (locked by oracle observation
 * `packages/conformance/observations/rtdb/rtdb-rules-denied-error-code.json`):**
 *
 *   - Throws a **plain `Error`** (NOT a `FirebaseError`).
 *   - `.code === 'PERMISSION_DENIED'` (uppercase snake-case — distinct
 *     from Firestore's `'permission-denied'`).
 *   - `.message === 'PERMISSION_DENIED: Permission denied'`.
 *
 * The sandbox backend matches this shape exactly. Tests assert against
 * `.constructor.name === 'Error'` to catch any future "improvement" to
 * a custom subclass.
 */

import type { AuthState, Sandbox, SandboxContext } from 'pyric/sandbox';
import { SandboxContextImpl } from 'pyric/sandbox';

import type { FirebaseApp } from '../app/types.js';
import {
  defaultClientApp,
  resolveClientApp,
} from '../sandbox/internal/client-app.js';

import { RtdbBackend } from './sandbox/backend.js';
import { getOrCreateBackend } from './sandbox/backend-for.js';
import { generatePushId } from './sandbox/push-id.js';
import {
  serverTimestampSentinel,
  incrementSentinel,
  type ServerTimestampSentinel,
  type IncrementSentinel,
} from './sandbox/sentinels.js';
import { joinPath, pathSegments, type JsonValue } from './sandbox/data-tree.js';
import { coerceArrays } from './sandbox/normalize.js';
import {
  applyConstraint,
  emptySpec,
  type Constraint,
  type QueryRow,
  type QuerySpec,
} from './sandbox/query.js';
import { ListenerRegistry, type ListenerRegistration } from './listener-registry.js';
import { RtdbConnectionLifecycle } from './connection-lifecycle.js';

// ─── Brand + routing ─────────────────────────────────────────────────

/** Hidden brand on every {@link Database} handle. */
export const TARGET_SYMBOL: unique symbol = Symbol('pyric/database/target');

type SandboxTarget = {
  kind: 'sandbox';
  backend: RtdbBackend;
  auth: AuthState;
  admin?: boolean;
  connection: RtdbConnectionLifecycle;
};
type SandboxLiveTarget = {
  kind: 'sandbox-live';
  backend: RtdbBackend;
  sandbox: Sandbox;
  currentUser?: () => AuthState;
  onCurrentUserChanged?: (callback: (user: AuthState) => void) => Unsubscribe;
  own?: (cleanup: () => void | Promise<void>) => () => void;
  assertUsable?: () => void;
  admin?: boolean;
  connection: RtdbConnectionLifecycle;
};
type Target = SandboxTarget | SandboxLiveTarget;

/** Resolve the active identity for a sandbox-flavored target. */
function authFor(t: SandboxTarget | SandboxLiveTarget): AuthState {
  if (t.admin) return null;
  return t.kind === 'sandbox' ? t.auth : (t.currentUser?.() ?? t.sandbox.currentUser);
}

const refToTarget = new WeakMap<object, Target>();

function tag<T extends object>(obj: T, target: Target): T {
  refToTarget.set(obj, target);
  return obj;
}

function targetOf(refOrDb: object): Target {
  let target: Target | undefined;
  if (TARGET_SYMBOL in refOrDb) {
    target = (refOrDb as { [TARGET_SYMBOL]: Target })[TARGET_SYMBOL];
  } else {
    target = refToTarget.get(refOrDb);
  }
  if (!target) {
    throw new TypeError(
      'pyric/database: unrecognized reference — was it produced by a factory in this package?',
    );
  }
  if (target.kind === 'sandbox-live') target.assertUsable?.();
  return target;
}

// ─── Public types ────────────────────────────────────────────────────

/** Opaque RTDB handle. Routes via {@link TARGET_SYMBOL}. */
export interface Database {
  readonly [TARGET_SYMBOL]: Target;
  readonly app?: FirebaseApp;
}

/** Database handle returned by Firebase-shaped app overloads. */
export type AppDatabase = Database & { readonly app: FirebaseApp };

/**
 * RTDB-shaped reference. Backend-opaque to consumers; mirrors
 * `firebase/database`'s `DatabaseReference` for the subset of methods
 * the modular SDK uses idiomatically as plain free-function args.
 *
 * `key` is the last path segment (matches `DatabaseReference.key`).
 * `null` for the root ref. `parent` is the ref one segment up
 * (`null` at root). `root` is always the root ref.
 *
 * `toString()` returns a stable `sandbox://` URL.
 */
export interface DatabaseReference {
  readonly key: string | null;
  readonly parent: DatabaseReference | null;
  readonly root: DatabaseReference;
  toString(): string;
  /** Internal — the canonical path (`'/users/alice'`). */
  readonly _path: string;
}

/**
 * Lightweight `DataSnapshot` — matches the subset of
 * `firebase/database`'s `DataSnapshot` we surface synchronously on a
 * `get()`. Methods are the load-bearing ones (`val`, `exists`, `key`,
 * `child`) plus a few utilities consumer code routinely reads.
 */
export interface DataSnapshot {
  readonly key: string | null;
  /**
   * Number of child properties of this snapshot. A getter (NOT a
   * `numChildren()` method — that was the legacy namespaced API). Locked
   * by oracle `rtdb-modular-get-snapshot-shape.json`
   * (`hasSize: true, hasNumChildren: false`) + upstream
   * `api/Reference_impl.ts:331-333`.
   */
  readonly size: number;
  /**
   * The node's priority, or `null`. The sandbox does not model RTDB's
   * priority values, so this is always `null`, matching
   * the common case (no `.priority` set). Mirrors `api/Reference_impl.ts:312`.
   */
  readonly priority: string | number | null;
  exists(): boolean;
  val(): JsonValue;
  child(path: string): DataSnapshot;
  hasChild(path: string): boolean;
  hasChildren(): boolean;
  /**
   * Like `val()` but includes priority info (for backups). With no
   * priority modeled, this equals `val()`. Mirrors
   * `api/Reference_impl.ts:374-376`.
   */
  exportVal(): JsonValue;
  toJSON(): JsonValue;
  /**
   * Iterate the snapshot's immediate children. The callback is invoked
   * with a child `DataSnapshot` for each child; return `true` to stop
   * iteration early (matches the `firebase/database` contract).
   *
   * For a snapshot built from a {@link Query}, children are visited in
   * the order the query's `orderBy*` constraint computed — the windowed
   * + filtered + limited sequence. For a plain ref snapshot, children
   * are visited in key-insertion order (V8 object iteration order; the
   * RTDB SDK does NOT guarantee an order on plain refs either).
   */
  forEach(cb: (child: DataSnapshot) => boolean | void): boolean;
  /** The ref the snap was taken from. */
  readonly ref: DatabaseReference;
}

/**
 * The return type of {@link push} — a regular {@link DatabaseReference}
 * with `.then` / `.catch` attached so it can be `await`ed. Mirrors
 * `firebase/database`'s `ThenableReference` (`api/Reference_impl.ts:569`).
 *
 * Critical (DB-B7): the ref + its `.key` are available SYNCHRONOUSLY —
 * the key is minted client-side. The promise covers only the optional
 * value write; a rules-denied write rejects the promise (it does NOT
 * throw synchronously and lose the key). Oracle:
 * `rtdb-push-autoid-format.json`.
 */
export interface ThenableReference extends DatabaseReference {
  then<TResult1 = DatabaseReference, TResult2 = never>(
    onfulfilled?: ((value: DatabaseReference) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2>;
  catch<TResult = never>(
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null,
  ): Promise<DatabaseReference | TResult>;
}

export type Unsubscribe = () => void;

/**
 * Hidden brand on every {@link Query} (and on every QueryConstraint).
 * Distinct from `TARGET_SYMBOL`; this brand is only used to dispatch
 * `get` / `onValue` between plain refs and query-wrapped refs.
 */
export const QUERY_SYMBOL: unique symbol = Symbol('pyric/database/query');

/** Hidden brand on every {@link QueryConstraint}. */
const CONSTRAINT_SYMBOL: unique symbol = Symbol('pyric/database/query-constraint');

/**
 * RTDB-shaped Query — a ref + an immutable constraint chain. Mirrors
 * `firebase/database`'s `Query` for the subset of methods the modular
 * SDK uses idiomatically.
 *
 * Construct with {@link query}; pass to {@link get} or {@link onValue}.
 */
export interface Query {
  /** The Query's location. Used by `query()` chaining + listener fan-out. */
  readonly ref: DatabaseReference;
  /** Resolves to the same URL the ref would. */
  toString(): string;
  /** Internal — the constraint chain that built this query (sandbox path). */
  readonly _spec: QuerySpec;
  readonly [QUERY_SYMBOL]: true;
}

/**
 * Opaque constraint produced by `orderByChild` / `equalTo` / `limitToFirst`
 * etc. Pass to {@link query}.
 */
export interface QueryConstraint {
  /** The constraint's variant — surfaces as the SDK's
   *  `QueryConstraintType` strings. */
  readonly type:
    | 'orderByChild'
    | 'orderByKey'
    | 'orderByValue'
    | 'startAt'
    | 'startAfter'
    | 'endAt'
    | 'endBefore'
    | 'equalTo'
    | 'limitToFirst'
    | 'limitToLast';
  readonly [CONSTRAINT_SYMBOL]: Constraint;
}

function buildConstraint(
  type: QueryConstraint['type'],
  internal: Constraint,
): QueryConstraint {
  return Object.freeze({
    type,
    [CONSTRAINT_SYMBOL]: internal,
  });
}

function isQuery(v: object): v is Query {
  return QUERY_SYMBOL in v;
}

// ─── Constructors ────────────────────────────────────────────────────

/**
 * Build a sandbox Database handle:
 *
 *   - `SandboxContext` → sandbox-backed, frozen identity.
 *   - `Sandbox` → sandbox-backed, live identity (per-op `currentUser`).
 * @example
 * ```ts
 * import { initializeSandbox } from 'pyric/sandbox';
 * import { getDatabase, ref, set, get } from 'pyric/database';
 *
 * const sandbox = initializeSandbox();
 * const db = getDatabase(sandbox.withAuth({ uid: 'alice' }));
 * await set(ref(db, 'greetings/hello'), { text: 'hi' });
 * const snap = await get(ref(db, 'greetings/hello'));
 * console.log(snap.val()); // { text: 'hi' }
 * ```
 */
export function getDatabase(ctx: SandboxContext): Database;
export function getDatabase(sandbox: Sandbox): Database;
export function getDatabase(app: FirebaseApp): AppDatabase;
export function getDatabase(): AppDatabase;
export function getDatabase(
  target?: SandboxContext | Sandbox | FirebaseApp,
): Database {
  if (target === undefined) return getDatabase(defaultClientApp() as FirebaseApp);
  // Package resolution already selected the sandbox mirror; the neutral app
  // adapter resolves an associated FirebaseApp to its app-owned runtime.
  const appRuntime = resolveClientApp(target);
  if (appRuntime) {
    return appRuntime.service('database/default', () => {
      const { sandbox, session } = appRuntime;
      let deleted = false;
      appRuntime.onDelete(() => { deleted = true; });
      const backend = getOrCreateBackend(sandbox);
      const connection = new RtdbConnectionLifecycle(
        backend,
        () => session.currentUser,
        false,
      );
      const resetUnsubscribe = sandbox.onEvent((event) => {
        if (event.kind === 'session_boundary' && event.phase === 'reset') connection.clear();
      });
      appRuntime.onDelete(resetUnsubscribe);
      appRuntime.onDelete(() => connection.drain().catch(() => undefined));
      const t: SandboxLiveTarget = {
        kind: 'sandbox-live',
        backend,
        connection,
        sandbox,
        currentUser: () => session.currentUser,
        onCurrentUserChanged: (callback) => session.onCurrentUserChanged(callback),
        own: (cleanup) => appRuntime.onDelete(cleanup),
        assertUsable: () => {
          if (deleted) {
            throw new Error('FIREBASE FATAL ERROR: Cannot call ref on a deleted database. ');
          }
        },
      };
      return { [TARGET_SYMBOL]: t, app: target as FirebaseApp };
    });
  }
  if (isSandboxContext(target)) {
    const backend = getOrCreateBackend(target.sandbox);
    const connection = new RtdbConnectionLifecycle(backend, () => target.auth, false);
    target.sandbox.onEvent((event) => {
      if (event.kind === 'session_boundary' && event.phase === 'reset') connection.clear();
    });
    const t: SandboxTarget = { kind: 'sandbox', backend, auth: target.auth, connection };
    return { [TARGET_SYMBOL]: t };
  }
  if (isSandbox(target)) {
    const backend = getOrCreateBackend(target);
    const connection = new RtdbConnectionLifecycle(
      backend,
      () => target.currentUser,
      false,
    );
    target.onEvent((event) => {
      if (event.kind === 'session_boundary' && event.phase === 'reset') connection.clear();
    });
    const t: SandboxLiveTarget = {
      kind: 'sandbox-live',
      backend,
      connection,
      sandbox: target,
      onCurrentUserChanged: (callback) => target.onCurrentUserChanged(callback),
    };
    return { [TARGET_SYMBOL]: t };
  }
  throw packageResolutionError();
}

/**
 * Sandbox-only rules-bypass RTDB handle. Mirrors Firestore's
 * `getAdminFirestore(sandbox)` for Studio/Playground data browsers and
 * controlled admin tools.
 */
export function getAdminDatabase(sandbox: Sandbox): Database;
export function getAdminDatabase(ctx: SandboxContext): Database;
export function getAdminDatabase(app: FirebaseApp): Database;
export function getAdminDatabase(target: Sandbox | SandboxContext | FirebaseApp): Database {
  const appRuntime = resolveClientApp(target);
  if (appRuntime) {
    appRuntime.assertAlive();
    return getAdminDatabase(appRuntime.sandbox);
  }
  const sandbox = isSandboxContext(target)
    ? target.sandbox
    : isSandbox(target)
      ? target
      : undefined;
  if (sandbox === undefined) throw packageResolutionError();
  const backend = getOrCreateBackend(sandbox);
  const connection = new RtdbConnectionLifecycle(backend, () => null, true);
  sandbox.onEvent((event) => {
    if (event.kind === 'session_boundary' && event.phase === 'reset') connection.clear();
  });
  const t: SandboxTarget = { kind: 'sandbox', backend, auth: null, admin: true, connection };
  return { [TARGET_SYMBOL]: t };
}

function packageResolutionError(): TypeError {
  return new TypeError(
    'pyric/database is a sandbox-only mirror. Package resolution must leave firebase/database unchanged for production; activate pyric dev or @pyric/cli/register before importing to select the sandbox.',
  );
}

function isSandboxContext(
  target: SandboxContext | Sandbox | FirebaseApp,
): target is SandboxContext {
  return target instanceof SandboxContextImpl;
}

function isSandbox(
  target: SandboxContext | Sandbox | FirebaseApp,
): target is Sandbox {
  if (target === null || typeof target !== 'object') return false;
  const o = target as unknown as Record<string, unknown>;
  return (
    typeof o.withAuth === 'function'
    && typeof o.onCurrentUserChanged === 'function'
    && 'currentUser' in o
    && 'admin' in o
  );
}

// ─── Reference constructors ──────────────────────────────────────────

/**
 * Build a {@link DatabaseReference} at `path` (default root).
 *
 * Path normalisation: leading + trailing slashes are stripped;
 * empty path / `'/'` becomes the root.
 */
export function ref(db: Database, path?: string): DatabaseReference {
  const target = targetOf(db);
  return buildSandboxRef(target, path ?? '/');
}

/**
 * Sub-path constructor. `child(ref, 'sub/path')` returns a ref at
 * `<ref>/sub/path`.
 *
 * Mirrors `firebase/database`'s `child(parent, path)` — leading +
 * empty segments stripped; the result inherits the parent's target.
 */
export function child(parent: DatabaseReference, path: string): DatabaseReference {
  const target = targetOf(parent as unknown as object);
  const absSegs = [...pathSegments(parent._path), ...pathSegments(path)];
  return buildSandboxRef(target, joinPath(absSegs));
}

/**
 * Build a sandbox-backed `DatabaseReference`. Cached parent / root
 * pointers are computed lazily so a long chain doesn't materialise
 * every intermediate ref upfront.
 */
function buildSandboxRef(
  target: SandboxTarget | SandboxLiveTarget,
  path: string,
): DatabaseReference {
  const canonical = joinPath(pathSegments(path));
  const segs = pathSegments(canonical);
  const key = segs.length === 0 ? null : segs[segs.length - 1]!;
  const self: DatabaseReference = {
    key,
    _path: canonical,
    get parent() {
      if (segs.length === 0) return null;
      return buildSandboxRef(target, joinPath(segs.slice(0, -1)));
    },
    get root() {
      return buildSandboxRef(target, '/');
    },
    toString() {
      return `sandbox://rtdb${canonical}`;
    },
  };
  tag(self as unknown as object, target);
  return self;
}

// ─── Reads ───────────────────────────────────────────────────────────

/**
 * `get(ref)` — one-shot read at the ref's path. Resolves to a
 * `DataSnapshot`-shaped object.
 *
 * Runs through the sandbox rule engine; denial throws the plain-`Error`
 * shape locked by the oracle.
 *
 * Absent path → `snap.val() === null && snap.exists() === false`.
 * Matches the SDK's `DataSnapshot.val()` contract.
 */
export async function get(r: DatabaseReference | Query): Promise<DataSnapshot> {
  // Query branch — windowed read.
  if (isQuery(r as object)) {
    const q = r as Query;
    const target = targetOf(q.ref as unknown as object);
    const rows = target.admin
      ? target.backend.adminGetQuery(q.ref._path, q._spec)
      : target.backend.getQuery(authFor(target), q.ref._path, q._spec);
    return buildSandboxQuerySnap(target, q.ref, rows);
  }
  const ref0 = r as DatabaseReference;
  const target = targetOf(ref0 as unknown as object);
  const val = target.admin
    ? target.backend.adminGet(ref0._path)
    : target.backend.get(authFor(target), ref0._path);
  return buildSandboxSnap(target, ref0, val);
}

/**
 * `set(ref, value)` — replace the value at `ref`'s path. `null`
 * deletes (matches the RTDB invariant — locked by oracle observation
 * `rtdb-remove-vs-set-null.json`).
 *
 * `serverTimestamp()` sentinels are resolved at write time.
 */
export async function set(r: DatabaseReference, value: unknown): Promise<void> {
  const target = targetOf(r as unknown as object);
  if (target.admin) {
    target.backend.adminSet(r._path, value as JsonValue);
  } else {
    target.backend.set(authFor(target), r._path, value as JsonValue);
  }
}

/**
 * `update(ref, values)` — partial update.
 *
 *   - When `values` keys contain `/`, the call is a **multi-path atomic
 *     update**: every listed path is written as one transaction (any
 *     denial fails the whole batch).
 *   - Otherwise it's a **shallow merge** at the ref's path: each
 *     top-level key replaces the corresponding child. `null` values
 *     delete.
 *
 * Both behaviors are sandbox-implemented per the RtdbBackend's
 * `update` method (`rtdb-modular`-spec atomic claim, matrix row #23).
 */
export async function update(
  r: DatabaseReference,
  values: Record<string, unknown>,
): Promise<void> {
  const target = targetOf(r as unknown as object);
  if (target.admin) {
    target.backend.adminUpdate(r._path, values as Record<string, JsonValue>);
  } else {
    target.backend.update(
      authFor(target),
      r._path,
      values as Record<string, JsonValue>,
    );
  }
}

/**
 * `remove(ref)` — delete the subtree at the ref's path.
 *
 * RTDB invariant (oracle: `rtdb-remove-vs-set-null.json`): equivalent
 * to `set(ref, null)`. The sandbox backend dispatches `remove` through
 * the same code path as `set(_, null)`.
 */
export async function remove(r: DatabaseReference): Promise<void> {
  const target = targetOf(r as unknown as object);
  if (target.admin) {
    target.backend.adminRemove(r._path);
  } else {
    target.backend.remove(authFor(target), r._path);
  }
}

/**
 * `push(ref, value?)` — mint an auto-id child key under `ref`'s path,
 * optionally writing `value` at the new child.
 *
 * Returns a ref at the new child path. The ref's `key` is the minted
 * id (locked by oracle observation `rtdb-push-autoid-format.json`:
 * 20 chars, leading `-`, lex-sortable).
 *
 * Production note: the key is minted **client-side** (no server
 * round-trip required); it's available synchronously on the returned
 * ref even when the optional write is denied by rules. The oracle
 * observation confirms this — the sandbox matches.
 */
export function push(r: DatabaseReference, value?: unknown): ThenableReference {
  const target = targetOf(r as unknown as object);
  // Mint the key SYNCHRONOUSLY (client-side, no rule check) so the
  // returned ref + `.key` are available even if the optional write is
  // later denied (DB-B7). The write is deferred onto the thenable's
  // promise — a rules denial REJECTS the promise rather than throwing
  // here and discarding the key.
  const key = target.backend.mintKey();
  const childPath = joinPath([...pathSegments(r._path), key]);
  // Two refs (mirroring upstream): `thenablePushRef` gets then/catch and
  // is returned; `pushRef` is a SEPARATE plain ref used as the promise's
  // fulfilled value — so resolving the promise doesn't re-enter the
  // thenable's own `then` (the self-reference unwrap trap).
  const thenablePushRef = buildSandboxRef(target, childPath);
  const pushRef = buildSandboxRef(target, childPath);
  const promise = value === undefined
    ? Promise.resolve(pushRef)
    : set(pushRef, value).then(() => pushRef);
  return makeThenable(thenablePushRef, promise);
}

/**
 * Attach `then`/`catch` to a ref so it satisfies {@link ThenableReference}.
 * Mirrors upstream's `thenablePushRef.then = promise.then.bind(promise)`
 * (`api/Reference_impl.ts:627-629`). The ref's own fields are untouched —
 * it stays a usable {@link DatabaseReference}.
 */
function makeThenable(
  pushRef: DatabaseReference,
  promise: Promise<DatabaseReference>,
): ThenableReference {
  const thenable = pushRef as ThenableReference;
  thenable.then = promise.then.bind(promise) as ThenableReference['then'];
  thenable.catch = promise.catch.bind(promise) as ThenableReference['catch'];
  return thenable;
}

/**
 * Pre-mint a push key without writing. Used by callers that need the
 * key for a multi-path update (`update(rootRef, { [\`/users/${key}\`]: ... })`).
 * Returns a freshly-minted key.
 */
export function pushKey(): string {
  return generatePushId();
}

// ─── Listeners (Tier 2) ──────────────────────────────────────────────

/**
 * RTDB evaluates a listener with the Auth instance attached to its app. When
 * that app's session changes, replace the backend registration with one made
 * under the new identity. Registrations belonging to other app sessions are
 * untouched even though all equal-config apps share one data backend.
 */
function subscribeWithLiveAuth(
  target: Target,
  subscribe: (auth: AuthState) => Unsubscribe,
): Unsubscribe {
  let stopped = false;
  let backendUnsubscribe = subscribe(authFor(target));
  const sessionUnsubscribe = target.kind === 'sandbox-live'
    ? target.onCurrentUserChanged?.(() => {
      backendUnsubscribe();
      try {
        backendUnsubscribe = subscribe(authFor(target));
      } catch {
        // The public subset currently has no cancel callback overload. A
        // denied identity therefore suspends delivery until this app's next
        // Auth transition instead of leaking events under the old identity.
        backendUnsubscribe = () => {};
      }
    })
    : undefined;

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    sessionUnsubscribe?.();
    backendUnsubscribe();
  };
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
 * Errors path: subscribing under rules that deny the read throws the
 * plain-`Error` `PERMISSION_DENIED` shape synchronously (matching the
 * production behavior where the subscribe path immediately errors).
 */
export function onValue(
  r: DatabaseReference | Query,
  cb: (snap: DataSnapshot) => void,
  options?: { onlyOnce?: boolean },
): Unsubscribe {
  // `onlyOnce` (DB-B12): wrap the callback so it unsubscribes itself
  // after the first fire. The unsub is filled in once the real
  // subscription is created below.
  if (options?.onlyOnce) {
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
    unsub = onValue(r, onceCb);
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
        (auth) => target.backend.onValue(auth, q.ref._path, deliver, q._spec),
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
      (auth) => target.backend.onValue(auth, ref0._path, wrapper),
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
  cb: (snap: DataSnapshot) => void,
): Unsubscribe {
  return onChildEvent(r, 'child_added', cb);
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
  cb: (snap: DataSnapshot) => void,
): Unsubscribe {
  return onChildEvent(r, 'child_changed', cb);
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
  cb: (snap: DataSnapshot) => void,
): Unsubscribe {
  return onChildEvent(r, 'child_removed', cb);
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
 * Accepts a {@link Query} WITHOUT throwing, but the sandbox deliberately
 * does NOT fire `child_moved` on reorder yet: prod fires here (matrix row
 * `rtdb-modular#137`) while the sandbox holds — the reorder /
 * `previousChildName` ordering semantics are pending two new oracle
 * captures. This is a documented, pinned divergence (both sides asserted
 * in `test/database/modular/sandbox-child-events.test.ts`).
 */
export function onChildMoved(
  r: DatabaseReference | Query,
  cb: (snap: DataSnapshot) => void,
): Unsubscribe {
  return onChildEvent(r, 'child_moved', cb);
}

type ChildEvent = 'child_added' | 'child_changed' | 'child_removed' | 'child_moved';

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
 * `child_moved` on a query registers but does not fire on reorder — the
 * reorder semantics are held pending fresh oracle captures.)
 */
function onChildEvent(
  r: DatabaseReference | Query,
  event: ChildEvent,
  cb: (snap: DataSnapshot) => void,
): Unsubscribe {
  // Unwrap a Query into its base ref + spec; a plain ref has no spec.
  const isQ = isQuery(r as object);
  const baseRef = isQ ? (r as Query).ref : (r as DatabaseReference);
  const spec = isQ ? (r as Query)._spec : undefined;
  const target = targetOf(baseRef as unknown as object);
  const wrapper = (raw: { key: string; val: JsonValue }): void => {
    // Synthesize a snapshot rooted at the child path so `snap.key`
    // and `snap.val()` match the upstream `onChildAdded` snapshot
    // shape (key = the child's key, val = the child's value).
    const childRef = child(baseRef, raw.key);
    const snap = buildSandboxSnapFromRaw(target, childRef, raw.val);
    try {
      cb(snap);
    } catch {
      // Listener throws are swallowed — match `firebase/database`'s
      // behavior where one observer's exception doesn't block others.
    }
  };
  const unsub = subscribeWithLiveAuth(
    target,
    (auth) => target.backend.onChild(auth, event, baseRef._path, wrapper, spec),
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

// ─── Queries (Tier 3) ────────────────────────────────────────────────

/**
 * `query(ref, ...constraints)` — wrap a ref in an immutable
 * constraint chain. The resulting {@link Query} routes through
 * {@link get}/{@link onValue} and applies the ordering + filtering +
 * limit pipeline on the sandbox backend.
 *
 * Chaining is supported — `query(query(ref, orderByChild('x')),
 * limitToFirst(2))` folds both constraints into one spec.
 *
 * Locked semantics (oracle):
 *   - `orderByChild('p') + startAt(v) + endAt(w)` is BOTH-inclusive
 *     (`rtdb-modular-orderbychild-window.json`).
 *   - `orderByKey() + startAt('b') + endAt('d')` matches `[b, c, d]`
 *     (`rtdb-modular-orderbykey-window.json`).
 *   - `orderByValue() + limitToFirst(3)` returns the 3 smallest by
 *     value (`rtdb-modular-orderbyvalue-numeric.json` — note: prod
 *     requires `.indexOn: ".value"`; sandbox does not enforce indexes).
 *   - `orderByChild('group') + equalTo('b')` returns ALL matching
 *     children (`rtdb-modular-equalTo-filter.json`).
 *   - `limitToFirst(N)` / `limitToLast(N)` take from the start / end of
 *     the ordered window (`rtdb-modular-limittofirst-vs-limittolast.json`).
 *   - `startAfter` / `endBefore` are EXCLUSIVE
 *     (`rtdb-modular-startafter-endbefore-exclusive.json`).
 */
export function query(
  refOrQuery: DatabaseReference | Query,
  ...constraints: QueryConstraint[]
): Query {
  // Resolve base — could be a ref or a prior query (chaining).
  let baseRef: DatabaseReference;
  let baseSpec: QuerySpec;
  if (isQuery(refOrQuery as object)) {
    const prior = refOrQuery as Query;
    baseRef = prior.ref;
    baseSpec = prior._spec;
  } else {
    baseRef = refOrQuery as DatabaseReference;
    baseSpec = emptySpec();
  }
  let spec = baseSpec;
  for (const c of constraints) {
    spec = applyConstraint(spec, c[CONSTRAINT_SYMBOL]);
  }
  const q: Query = {
    ref: baseRef,
    _spec: spec,
    [QUERY_SYMBOL]: true,
    toString() {
      return baseRef.toString();
    },
  };
  return q;
}

/** `orderByChild('path')` — order children by the value at the nested
 *  child path. Locked by oracle observation
 *  `rtdb-modular-orderbychild-window.json`. */
export function orderByChild(path: string): QueryConstraint {
  return buildConstraint('orderByChild', {
    kind: 'orderBy',
    spec: { kind: 'child', path },
  });
}

/** `orderByKey()` — order children lexicographically by key string.
 *  Locked by oracle observation `rtdb-modular-orderbykey-window.json`. */
export function orderByKey(): QueryConstraint {
  return buildConstraint('orderByKey', {
    kind: 'orderBy',
    spec: { kind: 'key' },
  });
}

/** `orderByValue()` — order children by primitive value. Prod requires
 *  `.indexOn: ".value"` (oracle: `rtdb-modular-orderbyvalue-numeric.json`
 *  threw `Index not defined` against blockingfun); sandbox does NOT
 *  enforce indexes (the rules engine here checks read-allow only, not
 *  query-index conformance). */
export function orderByValue(): QueryConstraint {
  return buildConstraint('orderByValue', {
    kind: 'orderBy',
    spec: { kind: 'value' },
  });
}

/** `startAt(value, key?)` — INCLUSIVE lower bound under the active
 *  ordering. Optional `key` is the tie-breaker when ordering by
 *  child/value and multiple children share the bound's value. */
export function startAt(
  value: JsonValue,
  key?: string,
): QueryConstraint {
  return buildConstraint('startAt', {
    kind: 'bound',
    bound: { kind: 'startAt', value, key },
  });
}

/** `startAfter(value, key?)` — EXCLUSIVE lower bound. Locked by
 *  `rtdb-modular-startafter-endbefore-exclusive.json`. */
export function startAfter(
  value: JsonValue,
  key?: string,
): QueryConstraint {
  return buildConstraint('startAfter', {
    kind: 'bound',
    bound: { kind: 'startAfter', value, key },
  });
}

/** `endAt(value, key?)` — INCLUSIVE upper bound. Adjacent to startAt;
 *  same key tie-breaker semantics. */
export function endAt(
  value: JsonValue,
  key?: string,
): QueryConstraint {
  return buildConstraint('endAt', {
    kind: 'bound',
    bound: { kind: 'endAt', value, key },
  });
}

/** `endBefore(value, key?)` — EXCLUSIVE upper bound. Locked by
 *  `rtdb-modular-startafter-endbefore-exclusive.json`. */
export function endBefore(
  value: JsonValue,
  key?: string,
): QueryConstraint {
  return buildConstraint('endBefore', {
    kind: 'bound',
    bound: { kind: 'endBefore', value, key },
  });
}

/** `equalTo(value, key?)` — sugar for `startAt(value, key) +
 *  endAt(value, key)`. Returns ALL matching children (no uniqueness).
 *  Locked by oracle observation `rtdb-modular-equalTo-filter.json`. */
export function equalTo(
  value: JsonValue,
  key?: string,
): QueryConstraint {
  return buildConstraint('equalTo', {
    kind: 'bound',
    bound: { kind: 'equalTo', value, key },
  });
}

/** `limitToFirst(n)` — keep the first N children of the ordered window.
 *  Locked by oracle observation `rtdb-modular-limittofirst-vs-limittolast.json`. */
export function limitToFirst(n: number): QueryConstraint {
  return buildConstraint('limitToFirst', {
    kind: 'limit',
    limitKind: 'limitToFirst',
    n,
  });
}

/** `limitToLast(n)` — keep the last N children of the ordered window.
 *  Locked by oracle observation `rtdb-modular-limittofirst-vs-limittolast.json`. */
export function limitToLast(n: number): QueryConstraint {
  return buildConstraint('limitToLast', {
    kind: 'limit',
    limitKind: 'limitToLast',
    n,
  });
}

// ─── Transactions (Tier 4) ───────────────────────────────────────────

/**
 * Result of {@link runTransaction}. Matches `firebase/database`'s
 * `TransactionResult` for the fields agent / playground code reads
 * idiomatically.
 *
 * `committed === false` when the update fn aborted by returning
 * `undefined`. The snapshot still resolves — it reflects the **pre-
 * transaction** value (oracle:
 * `rtdb-modular-runtransaction-abort-undefined.json` →
 * `afterValOnServer: 100` preserved).
 *
 * On rule denial the promise rejects with a plain `Error` whose
 * `message === 'permission_denied'` (lowercase, no `.code`); see
 * `rtdb-modular-runtransaction-on-rules-denied-path.json`.
 */
export interface TransactionResult {
  readonly committed: boolean;
  readonly snapshot: DataSnapshot;
}

/**
 * `runTransaction(ref, transactionUpdate, options?)` — atomic
 * read-modify-write.
 *
 * Contract (oracle-locked):
 *
 *   1. `transactionUpdate` is called with the CURRENT value at `ref`'s
 *      path. For an absent path the arg is `null` (NOT `undefined`);
 *      oracle:
 *      `rtdb-modular-runtransaction-current-value-arg.json` →
 *      `missingFirstWasNull: true`.
 *   2. Returning `undefined` from the update fn ABORTS the transaction:
 *      resolves `{ committed: false, snapshot }` where the snapshot is
 *      the pre-transaction value; oracle:
 *      `rtdb-modular-runtransaction-abort-undefined.json` → `committed:
 *      false, snapVal: null`.
 *   3. Returning any defined value WRITES that value (rules-checked);
 *      resolves `{ committed: true, snapshot }` where `snapshot.val()`
 *      is the committed value; oracle:
 *      `rtdb-modular-runtransaction-success.json` → `committedNewValue:
 *      true` and
 *      `rtdb-modular-runtransaction-returns-committed-snapshot.json`.
 *   4. If rules deny the write, the promise REJECTS with a plain
 *      `Error` whose `message === 'permission_denied'` and NO `.code`
 *      field (distinct from `set`/`get`'s `'PERMISSION_DENIED:
 *      Permission denied'`); oracle:
 *      `rtdb-modular-runtransaction-on-rules-denied-path.json`.
 *
 * `options.applyLocally` (default `true`): when `false`, the
 * intermediate optimistic value is NOT fanned out to listeners — they
 * see only the committed value. In a single-client harness this is
 * usually invisible; we honor the flag for prod-parity. Oracle
 * observation `rtdb-modular-runtransaction-options-applylocally.json`
 * confirms both branches commit and end at the same value; the
 * intermediate-fire difference isn't observable from a single client.
 *
 * Single-client sandbox doesn't model concurrency conflicts; the
 * documented "retry on conflict" path is degenerate (no other writer
 * exists to conflict with). The fn is invoked once.
 */
export async function runTransaction<T>(
  r: DatabaseReference,
  transactionUpdate: (current: T | null) => T | undefined,
  options?: { applyLocally?: boolean },
): Promise<TransactionResult> {
  const target = targetOf(r as unknown as object);
  const result = target.backend.runTransaction(
    authFor(target),
    r._path,
    transactionUpdate as (current: JsonValue) => JsonValue | undefined,
    options,
  );
  const snap = buildSandboxSnapFromRaw(target, r, result.val);
  return { committed: result.committed, snapshot: snap };
}

// ─── Sentinels ───────────────────────────────────────────────────────

/**
 * `serverTimestamp()` — returns the `{ ".sv": "timestamp" }` sentinel
 * the wire encoder recognises. Resolves to `Date.now()` (epoch ms) on
 * write — locked by the prod SDK's resolved-as-number contract
 * (oracle: `rtdb-servertimestamp-resolves.json`).
 *
 * The sandbox backend recognises the marker.
 */
export function serverTimestamp(): ServerTimestampSentinel {
  return serverTimestampSentinel();
}

/**
 * `increment(delta)` — returns the `{ ".sv": { increment: delta } }`
 * sentinel that atomically adds `delta` to the current value at the
 * write's field. Starts from `0` when the field is absent or
 * non-numeric (oracle: `rtdb-modular-increment-from-missing.json`).
 *
 * The sandbox backend resolves it against the field's prior value at write
 * time. Mirrors `firebase/database`'s `increment` (`api/ServerValue.ts:38-44`).
 */
export function increment(delta: number): IncrementSentinel {
  return incrementSentinel(delta);
}

/** A client-owned queue of writes applied when its Database disconnects. */
export class OnDisconnect {
  /** @internal Construct through {@link onDisconnect}. */
  constructor(
    private readonly _repo: Target,
    private readonly _path: string,
  ) {}

  cancel(): Promise<void> {
    return this._repo.connection.cancel(this._path);
  }

  remove(): Promise<void> {
    return this._repo.connection.register({ kind: 'remove', path: this._path });
  }

  set(value: unknown): Promise<void> {
    return this._repo.connection.register({ kind: 'set', path: this._path, value });
  }

  setWithPriority(value: unknown, priority: string | number | null): Promise<void> {
    return this._repo.connection.register({ kind: 'set', path: this._path, value, priority });
  }

  update(values: Record<string, unknown>): Promise<void> {
    return this._repo.connection.register({ kind: 'update', path: this._path, values });
  }
}

/**
 * Register a one-shot write for this Database client's next disconnect.
 * Registration checks rules immediately; execution checks them again.
 */
export function onDisconnect(r: DatabaseReference): OnDisconnect {
  const target = targetOf(r as unknown as object);
  return new OnDisconnect(target, r._path);
}

// ─── Emulator (no-op on sandbox) ─────────────────────────────────────

/**
 * `connectDatabaseEmulator(db, host, port)` is an accepted no-op because the
 * selected backend already is the local sandbox.
 */
export function connectDatabaseEmulator(
  _db: Database,
  _host: string,
  _port: number,
  _options?: { mockUserToken?: string | Record<string, unknown> },
): void {
  // Accepted no-op.
}

// ─── Low-hanging-fruit exports (issue #149) ─────────────────────────
//
// Honest aliases / honest no-ops for `firebase/database` free functions
// that a real app imports at module load.

/**
 * `goOffline(db)` — disconnect the client from the RTDB backend.
 *
 * Drains this client's one-shot onDisconnect queue. The shared data backend
 * remains available to other Database clients and listeners.
 */
export function goOffline(db: Database): void {
  targetOf(db as unknown as object).connection.goOffline();
}

/**
 * `goOnline(db)` — reconnect the client to the RTDB backend.
 *
 * Reconnects the logical client. Executed disconnect operations are not
 * resurrected; reads and writes remain synchronous in the local sandbox.
 */
export function goOnline(db: Database): void {
  targetOf(db as unknown as object).connection.goOnline();
}

/**
 * `forceLongPolling()` — force the long-polling transport for all
 * subsequent `getDatabase` connections.
 *
 * No-op: transport selection is meaningless to the in-process/worker
 * sandbox, which never opens a real socket. Accepted so init code that
 * calls it unconditionally compiles + runs.
 */
export function forceLongPolling(): void {
  // Accepted no-op — see docstring.
}

/**
 * `forceWebSockets()` — force the WebSocket transport for all
 * subsequent `getDatabase` connections.
 *
 * No-op: transport selection is not applicable to the in-process/worker
 * sandbox (see {@link forceLongPolling}).
 */
export function forceWebSockets(): void {
  // Accepted no-op — see docstring.
}

/**
 * `enableLogging(logger?, persistent?)` — toggle RTDB SDK logging.
 *
 * Accepted no-op: the sandbox has no modular-SDK-style logger to wire a
 * level/sink into (it uses host-level `console` logging directly, gated
 * by `pyric dev`'s own flags — matching `pyric/firestore`'s
 * `setLogLevel`). Accepted so init code that calls it compiles + runs.
 */
export function enableLogging(
  logger?: boolean | ((message: string) => void),
  persistent?: boolean,
): void {
  void logger;
  void persistent;
}

/**
 * `refFromURL(db, url)` — build a {@link DatabaseReference} from an
 * absolute database URL (`https://<namespace>.firebaseio.com/path`).
 *
 * Real alias with real behavior: parses the path out of the URL and
 * delegates to {@link ref}, so the returned ref resolves + reads exactly
 * like `ref(db, path)`. The sandbox is single-database and has no host /
 * namespace, so the URL's HOST is not validated against the handle (the
 * real SDK throws if the host doesn't match the db's namespace); only
 * the path component is honored.
 */
export function refFromURL(db: Database, url: string): DatabaseReference {
  // Strip the scheme + host, keep the path. `new URL` handles the
  // `https://<ns>.firebaseio.com/a/b` and `.firebasedatabase.app`
  // hosts alike; the query string / hash (if any) is dropped —
  // RTDB paths carry neither.
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    throw new Error(
      `pyric/database: refFromURL received a value that is not an absolute URL: ${url}`,
    );
  }
  return ref(db, path);
}

// ─── Sandbox-only ops ───────────────────────────────────────────────
//
// Mirrors `pyric/firestore`'s `sandbox` namespace — explicit
// per-package sandbox lifecycle.

export const sandbox = {
  /**
   * Replace deployed rules. Pass `null` to clear (sandbox returns to
   * default-allow). Rules are evaluated through the existing
   * RTDB rules simulator — the same engine used by the rules tooling.
   *
   * @example
   * ```ts
   * sandbox.setRules(db, {
   *   rules: {
   *     '.read': 'auth != null',
   *     '.write': 'auth != null',
   *   },
   * });
   * ```
   */
  setRules(db: Database, rulesJson: { rules: Record<string, unknown> } | null): void {
    const target = targetOf(db);
    target.backend.setRules(rulesJson);
  },

  /**
   * Bulk-load data bypassing rules. The supplied map's keys are
   * absolute paths (`'/users/alice'`) and the values land at those
   * paths. Convenient for test fixtures.
   */
  setData(db: Database, data: Record<string, unknown>): void {
    const target = targetOf(db);
    target.backend.setData(data as Record<string, JsonValue>);
  },

  /** Snapshot the full sandbox tree (rule-bypass read). Usually a keyed
   *  object; may be a primitive when the root holds one (DB-B13). */
  snapshotState(db: Database): JsonValue {
    const target = targetOf(db);
    return target.backend.snapshotState();
  },
};

// ─── Snapshot wrappers ───────────────────────────────────────────────

function buildSandboxSnap(
  target: SandboxTarget | SandboxLiveTarget,
  refForSnap: DatabaseReference,
  val: JsonValue,
): DataSnapshot {
  return buildSandboxSnapFromRaw(target, refForSnap, val);
}

function buildSandboxSnapFromRaw(
  _target: SandboxTarget | SandboxLiveTarget,
  refForSnap: DatabaseReference,
  val: JsonValue,
): DataSnapshot {
  const exists = val !== null;
  // `val` is the STORED (integer-keyed) shape. Structural ops
  // (`child`/`forEach`/`hasChildren`/`numChildren`) walk it directly;
  // `val()`/`toJSON()` render the DB-B2 array coercion lazily so a list
  // written as an array reads back as an array.
  const coerced = coerceArrays(val);
  const childCount = (val !== null && typeof val === 'object' && !Array.isArray(val))
    ? Object.keys(val as Record<string, JsonValue>).length
    : 0;
  return {
    key: refForSnap.key,
    ref: refForSnap,
    size: childCount,
    priority: null,
    exists(): boolean { return exists; },
    val(): JsonValue { return coerced; },
    child(p: string): DataSnapshot {
      const segs = pathSegments(p);
      let cur: JsonValue = val;
      for (const s of segs) {
        if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) {
          cur = null;
          break;
        }
        cur = (cur as Record<string, JsonValue>)[s] ?? null;
      }
      const childRef = child(refForSnap, p);
      return buildSandboxSnapFromRaw(_target, childRef, cur);
    },
    hasChild(p: string): boolean {
      return this.child(p).exists();
    },
    hasChildren(): boolean {
      return val !== null && typeof val === 'object' && !Array.isArray(val)
        && Object.keys(val as Record<string, JsonValue>).length > 0;
    },
    exportVal(): JsonValue { return coerced; },
    toJSON(): JsonValue { return coerced; },
    forEach(cb): boolean {
      if (val === null || typeof val !== 'object' || Array.isArray(val)) return false;
      for (const [k, v] of Object.entries(val as Record<string, JsonValue>)) {
        const childRef = child(refForSnap, k);
        const childSnap = buildSandboxSnapFromRaw(_target, childRef, v);
        if (cb(childSnap) === true) return true;
      }
      return false;
    },
  };
}

/**
 * Build a snapshot from a query result. Differs from
 * {@link buildSandboxSnapFromRaw} in that the children iterate in the
 * order the executor produced them (not insertion order).
 *
 * `val()` returns a `Record<string, JsonValue>` containing only the
 * windowed children (or `null` if the window is empty), matching
 * `firebase/database`'s `DataSnapshot.val()` on a query snap.
 *
 * `numChildren()` is the window size; `forEach` walks the ordered rows.
 */
function buildSandboxQuerySnap(
  target: SandboxTarget | SandboxLiveTarget,
  refForSnap: DatabaseReference,
  rows: QueryRow[],
): DataSnapshot {
  let val: JsonValue;
  if (rows.length === 0) {
    val = null;
  } else {
    const obj: Record<string, JsonValue> = {};
    for (const { key, value } of rows) obj[key] = value;
    val = obj;
  }
  const exists = rows.length > 0;
  const coerced = coerceArrays(val);
  return {
    key: refForSnap.key,
    ref: refForSnap,
    size: rows.length,
    priority: null,
    exists(): boolean { return exists; },
    val(): JsonValue { return coerced; },
    child(p: string): DataSnapshot {
      const segs = pathSegments(p);
      let cur: JsonValue = val;
      for (const s of segs) {
        if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) {
          cur = null;
          break;
        }
        cur = (cur as Record<string, JsonValue>)[s] ?? null;
      }
      const childRef = child(refForSnap, p);
      return buildSandboxSnapFromRaw(target, childRef, cur);
    },
    hasChild(p: string): boolean {
      return this.child(p).exists();
    },
    hasChildren(): boolean { return rows.length > 0; },
    exportVal(): JsonValue { return coerced; },
    toJSON(): JsonValue { return coerced; },
    forEach(cb): boolean {
      for (const { key, value } of rows) {
        const childRef = child(refForSnap, key);
        const childSnap = buildSandboxSnapFromRaw(target, childRef, value);
        if (cb(childSnap) === true) return true;
      }
      return false;
    },
  };
}

// ─── Type re-exports ─────────────────────────────────────────────────

export type { Sandbox, SandboxContext, AuthState };
export type { JsonValue };
