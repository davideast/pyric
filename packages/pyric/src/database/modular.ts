/**
 * `pyric/database` modular SDK surface — Phase 3 implementation.
 *
 * Mirrors `firebase/database`'s tree-shakable free-function shape:
 * `getDatabase`, `ref`, `child`, `get`, `set`, `update`, `remove`,
 * `push`, `onValue`, `serverTimestamp`, `connectDatabaseEmulator`.
 *
 * Three backends picked by what's passed to `getDatabase`:
 *
 *   - **Sandbox target** — wraps `RtdbBackend` (in-memory JSON tree
 *     plus the existing `pyric/database` rule simulator). Identity is the
 *     `SandboxContext`'s frozen `auth`.
 *   - **Sandbox-live target** — same backend, but identity is read
 *     per-op from `sandbox.currentUser` so a `pyric/auth`-driven
 *     sign-in flips the next op's `request.auth` without re-binding.
 *   - **Prod target** — wraps `firebase/database` against a real
 *     Firebase project.
 *
 * Dispatch machinery mirrors `pyric/firestore`:
 *   - {@link TARGET_SYMBOL} brand on every {@link Database} handle.
 *   - {@link refToTarget} WeakMap from refs to their owning target so
 *     chained calls (`child(ref, 'sub')`, `get(ref)`) recover routing.
 *
 * Every public function has a `target.kind` switch with explicit
 * branches — structure is parallel and grep-friendly.
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

import type { FirebaseApp } from 'firebase/app';
import * as fb from 'firebase/database';
import type { AuthState, Sandbox, SandboxContext } from 'pyric/sandbox';
import { SandboxContextImpl } from 'pyric/sandbox';

// A PyricApp always wraps a sandbox. Direct FirebaseApp support remains a
// temporary service-level production arm until the RTDB package migration.
import { APP_TARGET, type PyricApp } from 'pyric/app';

import { RtdbBackend } from './sandbox/backend.js';
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

// ─── Brand + routing ─────────────────────────────────────────────────

/** Hidden brand on every {@link Database} handle. */
export const TARGET_SYMBOL: unique symbol = Symbol('@pyric/rtdb/target');

type SandboxTarget = {
  kind: 'sandbox';
  backend: RtdbBackend;
  auth: AuthState;
  admin?: boolean;
};
type SandboxLiveTarget = {
  kind: 'sandbox-live';
  backend: RtdbBackend;
  sandbox: Sandbox;
  admin?: boolean;
};
type ProdTarget = { kind: 'prod'; db: fb.Database };
type Target = SandboxTarget | SandboxLiveTarget | ProdTarget;

function isSandboxKind(t: Target): t is SandboxTarget | SandboxLiveTarget {
  return t.kind === 'sandbox' || t.kind === 'sandbox-live';
}

/** Resolve the active identity for a sandbox-flavored target. */
function authFor(t: SandboxTarget | SandboxLiveTarget): AuthState {
  if (t.admin) return null;
  return t.kind === 'sandbox' ? t.auth : t.sandbox.currentUser;
}

/**
 * One backend per `Sandbox`. The modular surface tracks the binding
 * here so successive `getDatabase(sandbox)` calls return handles that
 * share data (matches `firebase/database`'s singleton-per-`FirebaseApp`).
 */
const backendBySandbox = new WeakMap<Sandbox, RtdbBackend>();

function getOrCreateBackend(sandbox: Sandbox): RtdbBackend {
  let backend = backendBySandbox.get(sandbox);
  if (!backend) {
    // Pass the owning sandbox so the backend can land RTDB write activity
    // on the unified Studio `onEvent`/`history()` stream (keystone T1).
    backend = new RtdbBackend(sandbox);
    backendBySandbox.set(sandbox, backend);
    // Register the RTDB tree as a persistable service on the sandbox — the
    // same durability mechanism auth uses (see auth/index.ts:backendFor).
    // This makes `enablePersistence` include the tree in the serialized blob
    // and restore it on reload (worker death / browser restart), instead of
    // the old memory-only behavior where RTDB data was lost while Firestore
    // docs + auth users came back.
    //
    // Guarded by the WeakMap memoization above: we only reach this branch
    // ONCE per sandbox, so double-registration is impossible in practice
    // (registerPersistableService throws on duplicates anyway).
    //
    //   - snapshot: serialize the tree as a plain JSON value.
    //   - restore : REPLACE the tree AND fire listeners so a live RTDB view
    //               (Studio's RTDB tab) converges on the restored data.
    //   - subscribe: notify the controller on ANY write so a mutation
    //               schedules a debounced flush. RTDB writes emit
    //               `service_mutation` events, which the controller's
    //               `isPersistableEvent` does NOT cover — so this hook is the
    //               sole flush trigger, exactly as auth does it.
    const capturedBackend = backend;
    sandbox.registerPersistableService('rtdb', {
      snapshot: () => capturedBackend.exportTree(),
      restore: (data: unknown) => {
        capturedBackend.restoreTree(data as JsonValue);
      },
      subscribe: (onChange: () => void) => capturedBackend.subscribeWrites(onChange),
    });
  }
  return backend;
}

const refToTarget = new WeakMap<object, Target>();

function tag<T extends object>(obj: T, target: Target): T {
  refToTarget.set(obj, target);
  return obj;
}

function targetOf(refOrDb: object): Target {
  if (TARGET_SYMBOL in refOrDb) {
    return (refOrDb as { [TARGET_SYMBOL]: Target })[TARGET_SYMBOL];
  }
  const t = refToTarget.get(refOrDb);
  if (!t) {
    throw new TypeError(
      '@pyric/rtdb: unrecognized reference — was it produced by a factory in this package?',
    );
  }
  return t;
}

// ─── Public types ────────────────────────────────────────────────────

/** Opaque RTDB handle. Routes via {@link TARGET_SYMBOL}. */
export interface Database {
  readonly [TARGET_SYMBOL]: Target;
}

/**
 * RTDB-shaped reference. Backend-opaque to consumers; mirrors
 * `firebase/database`'s `DatabaseReference` for the subset of methods
 * the modular SDK uses idiomatically as plain free-function args.
 *
 * `key` is the last path segment (matches `DatabaseReference.key`).
 * `null` for the root ref. `parent` is the ref one segment up
 * (`null` at root). `root` is always the root ref.
 *
 * `toString()` returns the absolute URL — for sandbox refs we
 * stub a `sandbox://` URL; for prod refs `firebase/database`
 * provides the real URL.
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
   * priority (deny-listed — see COMPAT) so this is always `null`, matching
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
export const QUERY_SYMBOL: unique symbol = Symbol('@pyric/rtdb/query');

/** Hidden brand on every {@link QueryConstraint}. */
const CONSTRAINT_SYMBOL: unique symbol = Symbol('@pyric/rtdb/query-constraint');

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
  /** Internal — the prod-side fb.Query (when this query routes to prod). */
  readonly _fbQuery?: fb.Query;
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

/** Internal-only: bridge our constraint into the prod-side fb constraint. */
function toFbConstraint(c: QueryConstraint): fb.QueryConstraint {
  switch (c.type) {
    case 'orderByChild': {
      const ic = c[CONSTRAINT_SYMBOL] as { kind: 'orderBy'; spec: { kind: 'child'; path: string } };
      return fb.orderByChild(ic.spec.path);
    }
    case 'orderByKey':
      return fb.orderByKey();
    case 'orderByValue':
      return fb.orderByValue();
    case 'startAt': {
      const ic = c[CONSTRAINT_SYMBOL] as { kind: 'bound'; bound: { value: unknown; key?: string } };
      return fb.startAt(ic.bound.value as never, ic.bound.key);
    }
    case 'startAfter': {
      const ic = c[CONSTRAINT_SYMBOL] as { kind: 'bound'; bound: { value: unknown; key?: string } };
      return fb.startAfter(ic.bound.value as never, ic.bound.key);
    }
    case 'endAt': {
      const ic = c[CONSTRAINT_SYMBOL] as { kind: 'bound'; bound: { value: unknown; key?: string } };
      return fb.endAt(ic.bound.value as never, ic.bound.key);
    }
    case 'endBefore': {
      const ic = c[CONSTRAINT_SYMBOL] as { kind: 'bound'; bound: { value: unknown; key?: string } };
      return fb.endBefore(ic.bound.value as never, ic.bound.key);
    }
    case 'equalTo': {
      const ic = c[CONSTRAINT_SYMBOL] as { kind: 'bound'; bound: { value: unknown; key?: string } };
      return fb.equalTo(ic.bound.value as never, ic.bound.key);
    }
    case 'limitToFirst': {
      const ic = c[CONSTRAINT_SYMBOL] as { kind: 'limit'; n: number };
      return fb.limitToFirst(ic.n);
    }
    case 'limitToLast': {
      const ic = c[CONSTRAINT_SYMBOL] as { kind: 'limit'; n: number };
      return fb.limitToLast(ic.n);
    }
  }
}

// ─── Constructors ────────────────────────────────────────────────────

/**
 * Build a Database handle. Three overloads dispatch by input shape:
 *
 *   - `SandboxContext` → sandbox-backed, frozen identity.
 *   - `Sandbox` → sandbox-backed, live identity (per-op `currentUser`).
 *   - `FirebaseApp` → prod-backed (delegates to `firebase/database`).
 *
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
export function getDatabase(app: FirebaseApp): Database;
export function getDatabase(app: PyricApp): Database;
export function getDatabase(
  target: SandboxContext | Sandbox | FirebaseApp | PyricApp,
): Database {
  // Package resolution already selected the sandbox mirror before this code
  // loaded, so a PyricApp can only unwrap to its Sandbox.
  if (isPyricApp(target)) {
    return getDatabase(target.sandbox);
  }
  if (isSandboxContext(target)) {
    const backend = getOrCreateBackend(target.sandbox);
    const t: SandboxTarget = { kind: 'sandbox', backend, auth: target.auth };
    return { [TARGET_SYMBOL]: t };
  }
  if (isSandbox(target)) {
    const backend = getOrCreateBackend(target);
    const t: SandboxLiveTarget = { kind: 'sandbox-live', backend, sandbox: target };
    return { [TARGET_SYMBOL]: t };
  }
  const fbDb = fb.getDatabase(target);
  const t: ProdTarget = { kind: 'prod', db: fbDb };
  return { [TARGET_SYMBOL]: t };
}

/**
 * Sandbox-only rules-bypass RTDB handle. Mirrors Firestore's
 * `getAdminFirestore(sandbox)` for Studio/Playground data browsers and
 * controlled admin tools.
 */
export function getAdminDatabase(sandbox: Sandbox): Database;
export function getAdminDatabase(ctx: SandboxContext): Database;
export function getAdminDatabase(app: PyricApp): Database;
export function getAdminDatabase(target: Sandbox | SandboxContext | PyricApp): Database {
  if (isPyricApp(target)) {
    return getAdminDatabase(target.sandbox);
  }
  const sandbox = isSandboxContext(target) ? target.sandbox : target;
  const backend = getOrCreateBackend(sandbox);
  const t: SandboxTarget = { kind: 'sandbox', backend, auth: null, admin: true };
  return { [TARGET_SYMBOL]: t };
}

/**
 * Brand-based test for the {@link PyricApp} overload. Direct Sandbox,
 * FirebaseApp, and SandboxContext handles never carry the app-wrapper symbol.
 */
function isPyricApp(
  target: SandboxContext | Sandbox | FirebaseApp | PyricApp,
): target is PyricApp {
  return (
    target !== null
    && typeof target === 'object'
    && APP_TARGET in target
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
 * Sandbox: returns a lightweight ref object owning its absolute path.
 * Prod: delegates to `firebase/database`'s `ref(db, path)` and tags
 * the returned ref so chained ops route correctly.
 *
 * Path normalisation: leading + trailing slashes are stripped;
 * empty path / `'/'` becomes the root.
 */
export function ref(db: Database, path?: string): DatabaseReference {
  const target = targetOf(db);
  if (isSandboxKind(target)) {
    return buildSandboxRef(target, path ?? '/');
  }
  const r = fb.ref(target.db, path);
  // Tag so subsequent free-function calls (child, get, set, …)
  // recover routing without inspecting the ref shape.
  tag(r as unknown as object, target);
  return r as unknown as DatabaseReference;
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
  if (isSandboxKind(target)) {
    const absSegs = [...pathSegments(parent._path), ...pathSegments(path)];
    return buildSandboxRef(target, joinPath(absSegs));
  }
  const r = fb.child(parent as unknown as fb.DatabaseReference, path);
  tag(r as unknown as object, target);
  return r as unknown as DatabaseReference;
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
 * Sandbox: runs through the rule engine; denial throws the plain-`Error`
 * shape locked by the oracle. Prod: delegates to `firebase/database`'s
 * `get(ref)` and wraps the returned snapshot in our minimal shape.
 *
 * Absent path → `snap.val() === null && snap.exists() === false`.
 * Matches the SDK's `DataSnapshot.val()` contract.
 */
export async function get(r: DatabaseReference | Query): Promise<DataSnapshot> {
  // Query branch — windowed read.
  if (isQuery(r as object)) {
    const q = r as Query;
    const target = targetOf(q.ref as unknown as object);
    if (isSandboxKind(target)) {
      const rows = target.admin
        ? target.backend.adminGetQuery(q.ref._path, q._spec)
        : target.backend.getQuery(authFor(target), q.ref._path, q._spec);
      return buildSandboxQuerySnap(target, q.ref, rows);
    }
    // Prod — q._fbQuery was built via fb.query() at construction time.
    const fbQ = q._fbQuery ?? (q.ref as unknown as fb.Query);
    const snap = await fb.get(fbQ);
    return wrapFbSnap(snap, target, q.ref);
  }
  const ref0 = r as DatabaseReference;
  const target = targetOf(ref0 as unknown as object);
  if (isSandboxKind(target)) {
    const val = target.admin
      ? target.backend.adminGet(ref0._path)
      : target.backend.get(authFor(target), ref0._path);
    return buildSandboxSnap(target, ref0, val);
  }
  const snap = await fb.get(ref0 as unknown as fb.DatabaseReference);
  return wrapFbSnap(snap, target, ref0);
}

/**
 * `set(ref, value)` — replace the value at `ref`'s path. `null`
 * deletes (matches the RTDB invariant — locked by oracle observation
 * `rtdb-remove-vs-set-null.json`).
 *
 * `serverTimestamp()` sentinels are resolved at write time on the
 * sandbox side; the prod side relies on `firebase/database`'s wire
 * encoder.
 */
export async function set(r: DatabaseReference, value: unknown): Promise<void> {
  const target = targetOf(r as unknown as object);
  if (isSandboxKind(target)) {
    if (target.admin) {
      target.backend.adminSet(r._path, value as JsonValue);
    } else {
      target.backend.set(authFor(target), r._path, value as JsonValue);
    }
    return;
  }
  await fb.set(r as unknown as fb.DatabaseReference, value);
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
  if (isSandboxKind(target)) {
    if (target.admin) {
      target.backend.adminUpdate(r._path, values as Record<string, JsonValue>);
    } else {
      target.backend.update(
        authFor(target),
        r._path,
        values as Record<string, JsonValue>,
      );
    }
    return;
  }
  await fb.update(r as unknown as fb.DatabaseReference, values);
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
  if (isSandboxKind(target)) {
    if (target.admin) {
      target.backend.adminRemove(r._path);
    } else {
      target.backend.remove(authFor(target), r._path);
    }
    return;
  }
  await fb.remove(r as unknown as fb.DatabaseReference);
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
  if (isSandboxKind(target)) {
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
  const out = value === undefined
    ? fb.push(r as unknown as fb.DatabaseReference)
    : fb.push(r as unknown as fb.DatabaseReference, value);
  tag(out as unknown as object, target);
  return out as unknown as ThenableReference;
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
 * Sandbox-side: returns a freshly-minted key. Prod-side: same — the
 * `push(ref).key` pattern is the documented way.
 */
export function pushKey(): string {
  return generatePushId();
}

// ─── Listeners (Tier 2) ──────────────────────────────────────────────

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
    if (isSandboxKind(target)) {
      return target.backend.onValue(
        authFor(target),
        q.ref._path,
        (raw) => {
          const snap = buildSandboxSnapFromRaw(target, q.ref, raw.val);
          try {
            cb(snap);
          } catch {
            // Listener throws are swallowed.
          }
        },
        q._spec,
      );
    }
    const fbQ = q._fbQuery ?? (q.ref as unknown as fb.Query);
    const off = fb.onValue(fbQ, (snap) => {
      cb(wrapFbSnap(snap, target, q.ref));
    });
    return off;
  }
  const ref0 = r as DatabaseReference;
  const target = targetOf(ref0 as unknown as object);
  if (isSandboxKind(target)) {
    const wrapper = (raw: { val: JsonValue; key: string | null }): void => {
      const snap = buildSandboxSnapFromRaw(target, ref0, raw.val);
      try {
        cb(snap);
      } catch {
        // Listener throws are swallowed — match `firebase/database`'s
        // behavior where one observer's exception doesn't block others.
      }
    };
    rememberWrapper(
      target.backend,
      ref0._path,
      'value',
      cb,
      wrapper as unknown as (snap: { val: JsonValue; key: string }) => void,
    );
    const unsub = target.backend.onValue(authFor(target), ref0._path, wrapper);
    return () => {
      forgetWrapper(target.backend, ref0._path, 'value', cb);
      unsub();
    };
  }
  const off = fb.onValue(ref0 as unknown as fb.DatabaseReference, (snap) => {
    cb(wrapFbSnap(snap, target, ref0));
  });
  return off;
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

/**
 * Map from a user-supplied callback to the wrapper the backend actually
 * stored. Used by `off(ref, eventType, userCb)` to find the wrapper to
 * remove — otherwise the user's callback identity wouldn't match the
 * backend's registered listener.
 *
 * Keyed by `(backend, path, event, userCb)` — same user-cb can subscribe
 * to multiple paths/events under different wrappers. The `WeakMap` outer
 * layer is on the backend so removing a sandbox releases the inner refs.
 */
const wrapperRegistry = new WeakMap<
  RtdbBackend,
  Map<string, (snap: { val: JsonValue; key: string }) => void>
>();

function registryKey(path: string, event: 'value' | ChildEvent, userCb: unknown): string {
  // Identity by cb-object — JS `Map` keys can be objects but we need a
  // string-shaped composite. Use a Symbol-keyed identity weakRefId. The
  // simplest approach: assign each unique user-cb a numeric id once.
  const id = idForCb(userCb as object);
  return `${path} ${event} ${id}`;
}

let nextCbId = 1;
const cbIds = new WeakMap<object, number>();
function idForCb(cb: object): number {
  let id = cbIds.get(cb);
  if (id === undefined) {
    id = nextCbId++;
    cbIds.set(cb, id);
  }
  return id;
}

function rememberWrapper(
  backend: RtdbBackend,
  path: string,
  event: 'value' | ChildEvent,
  userCb: unknown,
  wrapper: (snap: { val: JsonValue; key: string }) => void,
): void {
  let map = wrapperRegistry.get(backend);
  if (!map) {
    map = new Map();
    wrapperRegistry.set(backend, map);
  }
  map.set(registryKey(path, event, userCb), wrapper);
}

function lookupWrapper(
  backend: RtdbBackend,
  path: string,
  event: 'value' | ChildEvent,
  userCb: unknown,
): ((snap: { val: JsonValue; key: string }) => void) | undefined {
  return wrapperRegistry.get(backend)?.get(registryKey(path, event, userCb));
}

function forgetWrapper(
  backend: RtdbBackend,
  path: string,
  event: 'value' | ChildEvent,
  userCb: unknown,
): void {
  wrapperRegistry.get(backend)?.delete(registryKey(path, event, userCb));
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
  if (isSandboxKind(target)) {
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
    rememberWrapper(target.backend, baseRef._path, event, cb, wrapper);
    const unsub = target.backend.onChild(authFor(target), event, baseRef._path, wrapper, spec);
    return () => {
      forgetWrapper(target.backend, baseRef._path, event, cb);
      unsub();
    };
  }
  const handler = (snap: fb.DataSnapshot): void => {
    cb(wrapFbSnap(snap, target, child(baseRef, snap.key ?? '')));
  };
  // Prod: subscribe against the fb Query when one was built at construction
  // time, else the plain fb ref.
  const fbListenTarget = (isQ
    ? ((r as Query)._fbQuery ?? (baseRef as unknown as fb.Query))
    : (baseRef as unknown as fb.Query));
  switch (event) {
    case 'child_added':
      return fb.onChildAdded(fbListenTarget, handler);
    case 'child_changed':
      return fb.onChildChanged(fbListenTarget, handler);
    case 'child_removed':
      return fb.onChildRemoved(fbListenTarget, handler);
    case 'child_moved':
      return fb.onChildMoved(fbListenTarget, handler);
  }
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
  if (isSandboxKind(target)) {
    if (callback !== undefined && eventType !== undefined) {
      // Translate the user-supplied callback to the wrapper actually
      // registered with the backend.
      const wrapper = lookupWrapper(target.backend, r._path, eventType, callback);
      if (wrapper !== undefined) {
        target.backend.off(r._path, eventType, wrapper);
        forgetWrapper(target.backend, r._path, eventType, callback);
      }
      // If no wrapper was found, the user-cb wasn't registered against
      // this ref + eventType — no-throw, matches upstream behavior.
      return;
    }
    target.backend.off(r._path, eventType, undefined);
    return;
  }
  fb.off(
    r as unknown as fb.DatabaseReference,
    eventType as fb.EventType | undefined,
    callback as ((snap: fb.DataSnapshot) => void) | undefined,
  );
}

// ─── Queries (Tier 3) ────────────────────────────────────────────────

/**
 * `query(ref, ...constraints)` — wrap a ref in an immutable
 * constraint chain. The resulting {@link Query} routes through
 * {@link get}/{@link onValue} and applies the ordering + filtering +
 * limit pipeline on the sandbox backend; on prod it delegates to
 * `firebase/database`'s `query()`.
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
  let basePriorFbQuery: fb.Query | undefined;
  if (isQuery(refOrQuery as object)) {
    const prior = refOrQuery as Query;
    baseRef = prior.ref;
    baseSpec = prior._spec;
    basePriorFbQuery = prior._fbQuery;
  } else {
    baseRef = refOrQuery as DatabaseReference;
    baseSpec = emptySpec();
  }
  let spec = baseSpec;
  for (const c of constraints) {
    spec = applyConstraint(spec, c[CONSTRAINT_SYMBOL]);
  }
  // Prod branch — chain into fb.query so the wire encoder + index
  // checks happen in the upstream SDK exactly as a non-shim consumer
  // would see them.
  const target = targetOf(baseRef as unknown as object);
  let fbQuery: fb.Query | undefined;
  if (target.kind === 'prod') {
    const fbBase = (basePriorFbQuery ?? (baseRef as unknown as fb.Query)) as fb.Query;
    fbQuery = constraints.length === 0
      ? fbBase
      : fb.query(fbBase, ...constraints.map(toFbConstraint));
  }
  const q: Query = {
    ref: baseRef,
    _spec: spec,
    _fbQuery: fbQuery,
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
  if (isSandboxKind(target)) {
    const result = target.backend.runTransaction(
      authFor(target),
      r._path,
      transactionUpdate as (current: JsonValue) => JsonValue | undefined,
      options,
    );
    const snap = buildSandboxSnapFromRaw(target, r, result.val);
    return { committed: result.committed, snapshot: snap };
  }
  const fbResult = await fb.runTransaction(
    r as unknown as fb.DatabaseReference,
    transactionUpdate as (current: T | null) => T | undefined,
    options,
  );
  return {
    committed: fbResult.committed,
    snapshot: wrapFbSnap(fbResult.snapshot, target, r),
  };
}

// ─── Sentinels ───────────────────────────────────────────────────────

/**
 * `serverTimestamp()` — returns the `{ ".sv": "timestamp" }` sentinel
 * the wire encoder recognises. Resolves to `Date.now()` (epoch ms) on
 * write — locked by the prod SDK's resolved-as-number contract
 * (oracle: `rtdb-servertimestamp-resolves.json`).
 *
 * Same shape across targets: the sandbox backend recognises the
 * marker; the prod backend's wire encoder does too. Agent code that
 * imports `serverTimestamp` from `pyric/database` works identically on
 * either target.
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
 * Same shape across targets: the sandbox backend resolves it against the
 * field's prior value at write time; the prod backend's wire encoder
 * recognises the marker. Mirrors `firebase/database`'s `increment`
 * (`api/ServerValue.ts:38-44`).
 */
export function increment(delta: number): IncrementSentinel {
  return incrementSentinel(delta);
}

// ─── Emulator (no-op on sandbox) ─────────────────────────────────────

/**
 * `connectDatabaseEmulator(db, host, port)` — point a prod handle at
 * a Firebase emulator. No-op on sandbox handles (the sandbox IS a
 * local emulator); the call is still accepted so consumer code that
 * does the wiring unconditionally compiles against both targets.
 */
export function connectDatabaseEmulator(
  db: Database,
  host: string,
  port: number,
  // The modular SDK's signature lets you pass an optional namespace
  // (multi-DB projects). We accept-and-forward.
  options?: { mockUserToken?: string | fb.EmulatorMockTokenOptions },
): void {
  const target = targetOf(db);
  if (isSandboxKind(target)) return;
  fb.connectDatabaseEmulator(target.db, host, port, options);
}

// ─── Low-hanging-fruit exports (issue #149) ─────────────────────────
//
// Honest aliases / honest no-ops for `firebase/database` free functions
// that a real app imports at module load. Same-shape across targets so
// consumer code that wires them unconditionally compiles + runs against
// both the sandbox and a prod handle.

/**
 * `goOffline(db)` — disconnect the client from the RTDB backend.
 *
 * No-op on sandbox handles: there is NO network connection in the local
 * sandbox to toggle, so honest behavior is to accept the call and do
 * nothing (we deliberately do NOT simulate a disconnect — pending
 * writes, listeners, and `get()` all keep working exactly as before).
 * Forwards to `firebase/database`'s `goOffline` on prod handles.
 */
export function goOffline(db: Database): void {
  const target = targetOf(db);
  if (isSandboxKind(target)) return;
  fb.goOffline(target.db);
}

/**
 * `goOnline(db)` — reconnect the client to the RTDB backend.
 *
 * No-op on sandbox handles (there is no connection to reopen — see
 * {@link goOffline}). Forwards to `firebase/database`'s `goOnline` on
 * prod handles.
 */
export function goOnline(db: Database): void {
  const target = targetOf(db);
  if (isSandboxKind(target)) return;
  fb.goOnline(target.db);
}

/**
 * `forceLongPolling()` — force the long-polling transport for all
 * subsequent `getDatabase` connections.
 *
 * No-op: transport selection is meaningless to the in-process/worker
 * sandbox, which never opens a real socket. Accepted so init code that
 * calls it unconditionally compiles + runs. This is a process-global
 * `firebase/database` setter (no `db` handle), so there is no prod
 * handle to forward through from here.
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
  const target = targetOf(db);
  if (isSandboxKind(target)) {
    // Strip the scheme + host, keep the path. `new URL` handles the
    // `https://<ns>.firebaseio.com/a/b` and `.firebasedatabase.app`
    // hosts alike; the query string / hash (if any) is dropped —
    // RTDB paths carry neither.
    let path: string;
    try {
      path = new URL(url).pathname;
    } catch {
      throw new Error(
        `@pyric/rtdb: refFromURL received a value that is not an absolute URL: ${url}`,
      );
    }
    return ref(db, path);
  }
  const r = fb.refFromURL(target.db, url);
  tag(r as unknown as object, target);
  return r as unknown as DatabaseReference;
}

// ─── Sandbox-only ops ───────────────────────────────────────────────
//
// Mirrors `pyric/firestore`'s `sandbox` namespace — explicit
// per-package sandbox lifecycle that the prod target doesn't ship.
// Calling against a prod handle throws.

export const sandbox = {
  /**
   * Replace deployed rules. Pass `null` to clear (sandbox returns to
   * default-allow). Rules are evaluated through the existing
   * `pyric/database` simulator — same engine as `simulate()` /
   * `rtdb_simulate_access`.
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
    if (!isSandboxKind(target)) {
      throw new Error('sandbox.setRules is sandbox-only.');
    }
    target.backend.setRules(rulesJson);
  },

  /**
   * Bulk-load data bypassing rules. The supplied map's keys are
   * absolute paths (`'/users/alice'`) and the values land at those
   * paths. Convenient for test fixtures.
   */
  setData(db: Database, data: Record<string, unknown>): void {
    const target = targetOf(db);
    if (!isSandboxKind(target)) {
      throw new Error('sandbox.setData is sandbox-only.');
    }
    target.backend.setData(data as Record<string, JsonValue>);
  },

  /** Snapshot the full sandbox tree (rule-bypass read). Usually a keyed
   *  object; may be a primitive when the root holds one (DB-B13). */
  snapshotState(db: Database): JsonValue {
    const target = targetOf(db);
    if (!isSandboxKind(target)) {
      throw new Error('sandbox.snapshotState is sandbox-only.');
    }
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

/**
 * Adapt a `firebase/database` `DataSnapshot` to our minimal interface.
 *
 * The fb snap already has all the methods our `DataSnapshot` shape
 * promises; we just need a `ref` that routes through our `Database`
 * handle's target on subsequent calls. Returning `fbSnap` unchanged
 * works for everything except the ref — the snap's `.ref` is an
 * `fb.DatabaseReference` that hasn't been tagged. Tag it.
 */
function wrapFbSnap(
  fbSnap: fb.DataSnapshot,
  target: Target,
  refForSnap: DatabaseReference,
): DataSnapshot {
  // The fb snap's `.ref` is the same `fb.DatabaseReference` semantically
  // identical to what we built in `get(r)`. Tag it so chained ops
  // through `snap.ref` route correctly.
  tag(fbSnap.ref as unknown as object, target);
  return new Proxy(fbSnap as unknown as DataSnapshot, {
    get(t, prop) {
      if (prop === 'ref') return refForSnap;
      // Forward through to the fb snap for everything else; bind
      // methods so `this` stays the fb snap (it relies on private
      // state).
      const v = (t as unknown as Record<string | symbol, unknown>)[prop];
      if (typeof v === 'function') return (v as (...a: unknown[]) => unknown).bind(t);
      return v;
    },
  });
}

// ─── Type re-exports ─────────────────────────────────────────────────

export type { Sandbox, SandboxContext, AuthState, FirebaseApp };
export type { JsonValue };
