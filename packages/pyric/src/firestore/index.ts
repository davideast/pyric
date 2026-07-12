/**
 * `pyric/firestore` — modular Web-SDK Firestore adapter for the
 * Pyric sandbox.
 *
 * Mirrors `firebase/firestore`'s tree-shakable free-function shape:
 * `getDoc`, `setDoc`, `addDoc`, `query`, `where`, `orderBy`, `limit`,
 * `onSnapshot`, `runTransaction`, etc. All operations route to one of
 * two backends, picked at init time:
 *
 *   - **Sandbox target** — wraps `pyric-admin`'s chainable adapter,
 *     which sits on `pyric/sandbox`'s `LocalEnvironment`. No
 *     network. Identity comes from a `SandboxContext`.
 *   - **Prod target** — wraps `firebase/firestore` against a real
 *     Firebase project. Identity comes from `firebase/auth`'s
 *     current user.
 *
 * Same call surface across both. Agent code that writes against the
 * sandbox during iteration runs unmodified against prod at deploy.
 *
 * The dual-target machinery lives in two pieces:
 *   - {@link TARGET_SYMBOL} — hidden brand on every {@link Firestore}
 *     handle that names the active backend.
 *   - {@link refToTarget} — WeakMap from refs/queries back to their
 *     owning target, so chained calls (`query(coll, where(...))`,
 *     `getDocs(q)`) recover routing without re-tagging at every step.
 *
 * Every public function has a `target.kind` switch with explicit
 * branches — the structure is parallel and grep-friendly.
 */

import {
  getFirestore as getChainableFirestore,
  getAdminFirestore as getChainableAdminFirestore,
  Timestamp as ChainTimestamp,
  FieldValue as ChainFieldValue,
  FOLLOWS_CURRENT_USER,
  SandboxError,
  type SandboxFirestore,
  type DocumentReference as ChainDocRef,
  type CollectionReference as ChainCollRef,
  type Query as ChainQuery,
  type AdminDocumentSnapshot as ChainDocSnap,
  type AdminQuerySnapshot as ChainQuerySnap,
  type AggregateField as ChainAggregateField,
  type AggregateSpec as ChainAggregateSpec,
  type Filter as ChainFilter,
  type DocumentData,
  type FieldValueSentinel,
  type LintResult,
  type OrderDirection,
  type SetOptions as ChainSetOptions,
  type Transaction as ChainTransaction,
  type WhereFilterOp,
  type WriteBatch as ChainWriteBatch,
} from 'pyric/sandbox/admin-firestore';
import { SandboxContextImpl } from 'pyric/sandbox';
import { getInternalEnv } from 'pyric/sandbox/internal';
import type { AuthState, Sandbox, SandboxContext } from 'pyric/sandbox';
import {
  Bytes as RulesBytes,
  LatLng as RulesLatLng,
  Vector as RulesVector,
  lintFirestoreRules,
} from 'pyric/rules/internal';

// `firebase/app` + `firebase/firestore` provide the prod backend.
// Imported as a star so individual functions (`getFirestore`,
// `doc`, `getDoc`, etc.) can be referenced unambiguously alongside
// pyric's free functions of the same name.
import type { FirebaseApp } from 'firebase/app';
import * as fb from 'firebase/firestore';

// Phase 3 unified app handle. Adapter dispatch reads `APP_TARGET` and
// routes to the existing direct-handle path (sandbox vs prod).
import { APP_TARGET, type PyricApp } from 'pyric/app';

// ─── Branding + routing ───────────────────────────────────────────────

/**
 * Hidden property on every {@link Firestore} handle. Discriminates
 * between sandbox and prod backends so free functions can route
 * without consumer-visible API differences.
 */
export const TARGET_SYMBOL: unique symbol = Symbol('pyric/firestore/target');

type SandboxTarget = { kind: 'sandbox'; db: SandboxFirestore; sandbox: Sandbox };
/**
 * Live-identity sandbox target — built by `getFirestore(sandbox)`.
 *
 * Unlike {@link SandboxTarget} (a frozen `SandboxContext` chosen at
 * `getFirestore(ctx)` time), this variant reads `sandbox.currentUser`
 * per operation via {@link getDb}. Every op constructs a fresh
 * `SandboxContext` from the sandbox's *current* `currentUser` and
 * obtains a chainable handle bound to that ctx.
 *
 * Wired into the modular surface so app code that uses both
 * `pyric/auth` and `pyric/firestore` against the same `Sandbox` sees
 * live auth-state changes: a `signInAnonymously` / `setUser` call on
 * the auth side mutates `sandbox.currentUser`, and the next Firestore
 * op evaluates rules under the new identity.
 *
 * `withAuth(null)` is anonymous; `withAuth(state)` is signed-in.
 */
type SandboxLiveTarget = { kind: 'sandbox-live'; sandbox: Sandbox; getDb: () => SandboxFirestore };
type ProdTarget = { kind: 'prod'; db: fb.Firestore };
type Target = SandboxTarget | SandboxLiveTarget | ProdTarget;

/** True for both sandbox variants — used at dispatch sites that share a
 *  branch (every sandbox op routes the same way once we've resolved the
 *  chainable handle). The prod branch is the complement. */
function isSandboxKind(target: Target): target is SandboxTarget | SandboxLiveTarget {
  return target.kind === 'sandbox' || target.kind === 'sandbox-live';
}

/**
 * Resolve a sandbox-flavored target to its chainable Firestore handle.
 *
 * `sandbox` targets carry a frozen handle from `getFirestore(ctx)` time;
 * `sandbox-live` targets build a fresh handle bound to the sandbox's
 * current `currentUser` at every call. Callers that issue multiple ops
 * in a row should cache the result into a local — every `getDb()` call
 * rebuilds the chainable, which is correct but wasteful when the auth
 * state hasn't moved between adjacent ops.
 */
function sandboxDb(target: SandboxTarget | SandboxLiveTarget): SandboxFirestore {
  return target.kind === 'sandbox' ? target.db : target.getDb();
}

/**
 * Map from refs / queries to their owning target. Populated by every
 * factory + chaining operation; consulted by every free function.
 *
 * WeakMap keys let entries GC alongside the refs that produced them.
 */
const refToTarget = new WeakMap<object, Target>();

function tag<T extends object>(obj: T, target: Target): T {
  refToTarget.set(obj, target);
  return obj;
}

/**
 * For `sandbox-live` refs/queries, record a closure that rebuilds the
 * chainable ref against a fresh `SandboxFirestore` handle. Used by
 * every dispatch site to re-resolve the ref under the sandbox's
 * *current* `currentUser` rather than the auth that was active when
 * the ref was first built.
 *
 * Necessary because `pyric-admin`'s chainable refs capture auth at
 * construction time — calling `chainRef.get()` on a held ref runs
 * under the auth from when the ref was built, not from when the op
 * fires. For sandbox-live, every op must construct a fresh chainable
 * ref bound to the current ctx before issuing the op.
 *
 * The closure form supports the full chain: `doc(coll, id)` rebuilds
 * via `rebuild(coll)(db).doc(id)`; `query(coll, where(...))` rebuilds
 * via `apply(constraints)` over the rebuilt source. Stored only for
 * sandbox-live refs — the `sandbox` (frozen-ctx) and `prod` paths
 * keep their existing held-ref semantics.
 */
const sandboxLiveRebuild = new WeakMap<object, (db: SandboxFirestore) => object>();

function tagLive<T extends object>(
  obj: T,
  target: SandboxLiveTarget,
  rebuild: (db: SandboxFirestore) => object,
): T {
  refToTarget.set(obj, target);
  sandboxLiveRebuild.set(obj, rebuild);
  return obj;
}

/** Resolve the chainable doc ref to use for an op against `ref`. For
 *  `sandbox`, returns the held chainable; for `sandbox-live`, runs
 *  the recorded rebuild closure against a fresh handle. */
function chainDocFor(
  target: SandboxTarget | SandboxLiveTarget,
  ref: object,
): ChainDocRef {
  const underlying = underlyingOf(ref);
  if (target.kind === 'sandbox') return underlying as ChainDocRef;
  const rebuild = sandboxLiveRebuild.get(underlying);
  if (!rebuild) {
    throw new TypeError(
      'pyric/firestore: live ref missing rebuild closure — was it produced by a factory in this package?',
    );
  }
  return rebuild(sandboxDb(target)) as ChainDocRef;
}

/** Same as {@link chainDocFor} but typed for collection refs. */
function chainCollFor(
  target: SandboxTarget | SandboxLiveTarget,
  ref: object,
): ChainCollRef {
  const underlying = underlyingOf(ref);
  if (target.kind === 'sandbox') return underlying as ChainCollRef;
  const rebuild = sandboxLiveRebuild.get(underlying);
  if (!rebuild) {
    throw new TypeError(
      'pyric/firestore: live collection ref missing rebuild closure.',
    );
  }
  return rebuild(sandboxDb(target)) as ChainCollRef;
}

/** Same as {@link chainDocFor} but typed for queries. */
function chainQueryFor(
  target: SandboxTarget | SandboxLiveTarget,
  q: object,
): ChainQuery {
  const underlying = underlyingOf(q);
  if (target.kind === 'sandbox') return underlying as ChainQuery;
  const rebuild = sandboxLiveRebuild.get(underlying);
  if (!rebuild) {
    throw new TypeError(
      'pyric/firestore: live query missing rebuild closure.',
    );
  }
  return rebuild(sandboxDb(target)) as ChainQuery;
}

/**
 * Tag a sandbox-flavored ref + (optionally) record its rebuild
 * closure. Routes to {@link tag} for frozen-ctx targets and
 * {@link tagLive} for live targets. Centralizes the per-factory
 * "record rebuild on live, plain tag on frozen" decision.
 */
function tagSandboxRef<T extends object>(
  obj: T,
  target: SandboxTarget | SandboxLiveTarget,
  rebuild: (db: SandboxFirestore) => object,
): T {
  if (target.kind === 'sandbox-live') {
    return tagLive(obj, target, rebuild);
  }
  return tag(obj, target);
}

/** Resolve a sandbox-flavored parent's rebuild closure. For
 *  sandbox-live, the parent must have been tagged via
 *  {@link tagSandboxRef}; for sandbox, returns a no-op stand-in
 *  since the held chainable is the only ref the dispatch sites use.
 *
 *  Used by chaining factories (`doc(coll, …)`, `collection(doc, …)`,
 *  `query(coll, …)`) to derive a rebuild that reads the parent's
 *  rebuild and applies one more step. */
function parentRebuild(parent: object): (db: SandboxFirestore) => object {
  const underlying = underlyingOf(parent);
  const fn = sandboxLiveRebuild.get(underlying);
  if (fn) return fn;
  // Frozen-ctx target. The chainable parent ref is bound to the same
  // ctx for life; returning it as-is is correct because frozen-ctx
  // chaining is what `pyric-admin`'s adapter already supports.
  return () => underlying;
}

function targetOf(refOrDb: object): Target {
  if (TARGET_SYMBOL in refOrDb) {
    return (refOrDb as { [TARGET_SYMBOL]: Target })[TARGET_SYMBOL];
  }
  const t = refToTarget.get(refOrDb);
  if (!t) {
    throw new TypeError(
      'pyric/firestore: unrecognized reference — was it produced by a factory in this package?',
    );
  }
  return t;
}

// ─── Converter tracking (sandbox-target only) ─────────────────────────
//
// For prod targets, `firebase/firestore`'s native `withConverter` keeps
// the converter on the fb ref itself — every read/write through fb's
// own API surface applies it transparently. We just route those refs
// through unchanged.
//
// For sandbox targets, the chainable refs don't know about converters.
// We track a per-ref converter + a pointer to the underlying chain ref
// in WeakMaps, and apply `toFirestore` / `fromFirestore` at each free-
// function boundary. The original plain chain ref keeps its identity;
// `withConverter` returns a NEW shell object so consumer code can
// hold both typed and untyped views of the same path without
// interference.

/**
 * Pair of translators between the consumer's app model and the
 * underlying Firestore representation. Mirrors `firebase/firestore`'s
 * `FirestoreDataConverter` shape.
 *
 *   - `toFirestore(model)` runs on every write (`setDoc`, `addDoc`)
 *     through a converted ref. Returns the `DocumentData` to send.
 *   - `fromFirestore(snapshot)` runs on every read (`getDoc`,
 *     `getDocs`, snapshot listener callback) through a converted ref.
 *     Receives the raw snapshot, returns the typed model.
 */
export interface FirestoreDataConverter<
  AppModelType,
  DbModelType extends DocumentData = DocumentData,
> {
  toFirestore(modelObject: AppModelType): DbModelType;
  fromFirestore(snapshot: QueryDocumentSnapshot<DbModelType>): AppModelType;
}

const refToConverter = new WeakMap<object, FirestoreDataConverter<unknown> | null>();
const refToUnderlying = new WeakMap<object, object>();

function converterOf(obj: object): FirestoreDataConverter<unknown> | null | undefined {
  return refToConverter.get(obj);
}

/** Resolve to the plain chain / fb ref. `withConverter` shells point
 *  at the underlying; everything else is its own underlying. */
function underlyingOf<T extends object>(obj: T): object {
  return refToUnderlying.get(obj) ?? obj;
}

/** Build a new sandbox shell that points at `underlying` and carries
 *  `converter`. Inherits routing + identity (id/path) from underlying.
 *
 *  Accepts both `SandboxTarget` and `SandboxLiveTarget`: the shell
 *  exists at the modular layer (above the chainable), so it only
 *  needs to record routing for `targetOf` and the underlying pointer
 *  for `underlyingOf`. The chain re-resolution (under current auth)
 *  happens at op time via {@link chainDocFor} / {@link chainCollFor}
 *  / {@link chainQueryFor} on the underlying. */
function buildSandboxShell(
  underlying: { id?: string; path?: string },
  target: SandboxTarget | SandboxLiveTarget,
  converter: FirestoreDataConverter<unknown>,
): object {
  const shell = {
    id: underlying.id ?? '',
    path: underlying.path ?? '',
  };
  refToConverter.set(shell, converter);
  refToUnderlying.set(shell, underlying);
  refToTarget.set(shell, target);
  return shell;
}

// ─── Public Firestore handle ──────────────────────────────────────────

/**
 * Opaque handle returned by {@link getFirestoreSandbox} or
 * {@link getFirestoreProd}. Carries the target via {@link TARGET_SYMBOL};
 * never inspected by consumer code.
 */
export interface Firestore {
  readonly [TARGET_SYMBOL]: Target;
}

/**
 * Construct a Firestore handle. Three overloads dispatch by the
 * input's shape:
 *
 *   - `SandboxContext` → sandbox-backed Firestore with a frozen
 *     identity (the ctx's `auth` chosen at `getFirestore` time). Best
 *     for runner/test code that names identity explicitly per
 *     scenario.
 *   - `Sandbox` → sandbox-backed Firestore that reads
 *     `sandbox.currentUser` per-call. Best for app code that drives
 *     identity through `pyric/auth` — every Firestore op evaluates
 *     rules under whatever user is currently signed in.
 *   - `FirebaseApp` → prod-backed Firestore (delegates to
 *     `firebase/firestore`'s `getFirestore(app)`).
 *
 * @example
 * ```ts
 * // Sandbox, frozen identity (runner / explicit tests).
 * import { initializeSandbox } from 'pyric/sandbox';
 * import { getFirestore, doc, setDoc } from 'pyric/firestore';
 * const sandbox = initializeSandbox();
 * const db = getFirestore(sandbox.withAuth({ uid: 'alice' }));
 *
 * // Sandbox, live identity (app code paired with pyric/auth).
 * import { initializeSandbox } from 'pyric/sandbox';
 * import { getAuth, signInAnonymously } from 'pyric/auth';
 * const sandbox = initializeSandbox();
 * const auth = getAuth(sandbox);
 * const db = getFirestore(sandbox); // reads sandbox.currentUser per op
 * await signInAnonymously(auth);    // subsequent db ops use the new identity
 *
 * // Prod.
 * import { initializeApp } from 'firebase/app';
 * import { getFirestore } from 'pyric/firestore';
 * const app = initializeApp(userProjectConfig);
 * const db = getFirestore(app);
 * ```
 */
export function getFirestore(ctx: SandboxContext): Firestore;
export function getFirestore(sandbox: Sandbox): Firestore;
export function getFirestore(app: FirebaseApp): Firestore;
export function getFirestore(app: PyricApp): Firestore;
export function getFirestore(target: SandboxContext | Sandbox | FirebaseApp | PyricApp): Firestore {
  // PyricApp dispatch: inspect the brand and forward to the existing
  // direct-handle path. Kept ABOVE the legacy probes so a sandbox-app
  // handle (which structurally carries `sandbox` + the brand symbol)
  // routes through the unified path, not the structural sandbox sniff.
  if (isPyricApp(target)) {
    return target[APP_TARGET] === 'sandbox'
      ? getFirestore(target.sandbox)
      : getFirestore(target.firebaseApp);
  }
  if (isSandboxContext(target)) {
    const chainable = getChainableFirestore(target);
    const t: SandboxTarget = { kind: 'sandbox', db: chainable, sandbox: target.sandbox };
    return { [TARGET_SYMBOL]: t };
  }
  if (isSandbox(target)) {
    const t: SandboxLiveTarget = {
      kind: 'sandbox-live',
      sandbox: target,
      getDb: makeGetDb(target),
    };
    return { [TARGET_SYMBOL]: t };
  }
  const fbDb = fb.getFirestore(target);
  const t: ProdTarget = { kind: 'prod', db: fbDb };
  return { [TARGET_SYMBOL]: t };
}

/**
 * A Firestore handle scoped to a specific identity, for multi-user testing.
 *
 * `actingAs(sandbox, { uid })` returns a `Firestore` whose ops evaluate security
 * rules as that user (`request.auth.uid === uid`; custom claims via `token`);
 * `actingAs(sandbox, null)` is the anonymous (signed-out) path. Multiple
 * identities over ONE sandbox share the same store, so a write by one is
 * delivered to another's `onSnapshot`: the basis for multi-user sync testing.
 *
 * @example
 * ```ts
 * import { initializeSandbox } from 'pyric/sandbox';
 * import { actingAs, doc, setDoc, onSnapshot } from 'pyric/firestore';
 * const sandbox = initializeSandbox();
 * const alice = actingAs(sandbox, { uid: 'alice' });
 * const bob   = actingAs(sandbox, { uid: 'bob', token: { role: 'member' } });
 * onSnapshot(doc(bob, 'rooms/r1'), () => {
 *   // fires when alice writes (same store; rules evaluated as bob)
 * });
 * await setDoc(doc(alice, 'rooms/r1'), { owner: 'alice' });
 * ```
 *
 * Thin sugar over `getFirestore(sandbox.withAuth(identity))`; the value is a
 * named, discoverable seam for multi-user scenarios. See
 * the design rationale.
 */
export function actingAs(sandbox: Sandbox, identity: AuthState): Firestore {
  return getFirestore(sandbox.withAuth(identity));
}

/**
 * Construct a **rules-bypassing** sandbox Firestore handle — the Pyric
 * Studio admin lens (Gap #2). Every modular op issued against the returned
 * handle (`getDoc`/`getDocs`/`setDoc`/`updateDoc`/`deleteDoc`/`addDoc`/
 * `count`/`writeBatch`/`runTransaction`) SKIPS security-rule evaluation and
 * is treated as ALLOW, while still going through the same store + emitting
 * the same events + waking the same listeners. This is the modular sibling
 * of the path-string `sandbox.admin.*` bypass; it reuses the underlying
 * `LocalEnvironment` bypass execution path (the `bypassRules` op flag),
 * not a parallel reimplementation.
 *
 * Sandbox-only. There is no prod analog (you cannot bypass deployed
 * security rules from a client), so this overload set accepts only a
 * `Sandbox` / `SandboxContext` / sandbox-backed `PyricApp` — never a
 * `FirebaseApp`. Admin ops are identity-agnostic (rules are off), so the
 * handle is a FROZEN `sandbox` target: it does not track
 * `sandbox.currentUser`.
 *
 * Intended for Studio's "edit anything as admin" surfaces (F2) and the
 * serve worker's `{ mode: 'admin' }` auth lens. For rules-applied
 * impersonation ("act as this user"), use `getFirestore(sandbox.withAuth({
 * uid }))` instead.
 *
 * @example
 * ```ts
 * import { initializeSandbox } from 'pyric/sandbox';
 * import { getAdminFirestore, doc, setDoc } from 'pyric/firestore';
 * const sandbox = initializeSandbox();
 * const adminDb = getAdminFirestore(sandbox);
 * await setDoc(doc(adminDb, 'locked/x'), { a: 1 }); // bypasses rules
 * ```
 */
export function getAdminFirestore(sandbox: Sandbox): Firestore;
export function getAdminFirestore(ctx: SandboxContext): Firestore;
export function getAdminFirestore(app: PyricApp): Firestore;
export function getAdminFirestore(target: Sandbox | SandboxContext | PyricApp): Firestore {
  // Sandbox-backed PyricApp → unwrap to its Sandbox. A prod-backed app has
  // no admin-bypass analog, so reject it loudly rather than silently
  // returning a rules-enforced prod handle.
  if (isPyricApp(target)) {
    if (target[APP_TARGET] !== 'sandbox') {
      throw new TypeError(
        'getAdminFirestore: the admin (rules-bypass) lens is sandbox-only — ' +
          'a prod-backed app has no way to bypass deployed security rules.',
      );
    }
    return getAdminFirestore(target.sandbox);
  }
  const sandbox: Sandbox = isSandboxContext(target) ? target.sandbox : (target as Sandbox);
  const chainable = getChainableAdminFirestore(sandbox);
  const t: SandboxTarget = { kind: 'sandbox', db: chainable, sandbox };
  return { [TARGET_SYMBOL]: t };
}

/**
 * Brand-based test for the {@link PyricApp} overload. Reads the
 * `APP_TARGET` symbol that `pyric/app`'s `initializeApp` stamps on
 * every handle. Cheap + collision-free: a `Sandbox` / `FirebaseApp`
 * / `SandboxContext` will never carry this symbol.
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

/**
 * Brand-based test for the SandboxContext overload. Uses
 * `instanceof SandboxContextImpl` for robustness — structural
 * dispatch would silently break if `SandboxContext`'s shape ever
 * changed, or if a future `FirebaseApp` grew a `withAuth` method.
 *
 * Internal — consumers always call `getFirestore` and let the
 * dispatch figure it out.
 */
function isSandboxContext(target: SandboxContext | Sandbox | FirebaseApp): target is SandboxContext {
  return target instanceof SandboxContextImpl;
}

/**
 * Structural test for the `Sandbox` overload. The class is internal
 * to `pyric/sandbox` (not exported), so we recognize it by the
 * presence of `currentUser` + `onCurrentUserChanged` + `withAuth` +
 * `admin` — the four members that distinguish `Sandbox` from
 * `SandboxContext` (which has `withAuth` only) and `FirebaseApp`
 * (which has none). Tightening to a brand symbol would require an
 * `pyric/sandbox` change; structural recognition is safe here
 * because every member of this set has been on `Sandbox` since v0
 * and `FirebaseApp` would have to grow all four to collide.
 */
function isSandbox(target: SandboxContext | Sandbox | FirebaseApp): target is Sandbox {
  if (target === null || typeof target !== 'object') return false;
  const o = target as unknown as Record<string, unknown>;
  return (
    typeof o.withAuth === 'function'
    && typeof o.onCurrentUserChanged === 'function'
    && 'currentUser' in o
    && 'admin' in o
  );
}

/**
 * Build the per-call ctx-resolver for a `sandbox-live` target. Each
 * call reads `sandbox.currentUser` (the source of truth that
 * `pyric/auth` writes through to), constructs a fresh
 * `SandboxContext`, and returns the chainable Firestore handle bound
 * to it. Constructing per-call is cheap — `SandboxContext` is a tiny
 * object — and `pyric-admin`'s `getFirestore(ctx)` caches by ctx
 * identity via WeakMap, so the chainable is collected once the ctx
 * is.
 *
 * `withAuth(null)` is the anonymous path; rules evaluate with
 * `request.auth == null`, matching production Firebase Auth's
 * "signed out" state.
 */
function makeGetDb(sandbox: Sandbox): () => SandboxFirestore {
  return () => {
    const ctx = sandbox.withAuth(sandbox.currentUser);
    return getChainableFirestore(ctx);
  };
}

// ─── Reference / query types ──────────────────────────────────────────
//
// Modular refs are the underlying chainable refs (sandbox) or the
// Firebase modular refs (prod) at runtime — we tag them in
// `refToTarget` to recover routing.
//
// At the type level, exposing a discriminated union per ref kind would
// be uniformly nice but costs a lot in user-side ergonomics. Instead
// the public types are structural intersections of the operations we
// support; consumer code interacts with refs only through our free
// functions, never property access, so the runtime heterogeneity is
// invisible.

/** A reference to a Firestore document. Backend-opaque. */
export interface DocumentReference<_T = DocumentData> {
  readonly id: string;
  readonly path: string;
}
/** A reference to a Firestore collection. Backend-opaque. */
export interface CollectionReference<_T = DocumentData> {
  readonly id: string;
  readonly path: string;
}
/** A Firestore query (a collection ref or one with where/orderBy/limit applied). */
export interface Query<_T = DocumentData> {
  readonly _isQuery?: true;
}
/** A point-in-time view of one document. */
export interface DocumentSnapshot<T = DocumentData> {
  readonly id: string;
  readonly exists: boolean | (() => boolean);
  data(): T | undefined;
}
/**
 * `QueryDocumentSnapshot` is a `DocumentSnapshot` known to exist —
 * `.data()` always returns the typed model, never `undefined`. Yielded
 * by `QuerySnapshot.docs` and passed to converter `fromFirestore`
 * callbacks. Mirrors the JS SDK's narrowing.
 */
export interface QueryDocumentSnapshot<T = DocumentData> extends DocumentSnapshot<T> {
  data(): T;
}
/** A point-in-time view of a query result. */
export interface QuerySnapshot<T = DocumentData> {
  readonly size: number;
  readonly empty: boolean;
  readonly docs: ReadonlyArray<QueryDocumentSnapshot<T>>;
}
export type WriteBatch = ChainWriteBatch | fb.WriteBatch;
export type Transaction = ChainTransaction | fb.Transaction;
export type Unsubscribe = () => void;

export type {
  AuthState,
  Sandbox,
  SandboxContext,
  DocumentData,
  FieldValueSentinel,
  LintResult,
  OrderDirection,
  WhereFilterOp,
  FirebaseApp,
};

export { SandboxError };

// ─── Tier 1: scalar types + sentinels re-exported from firebase ──────
//
// These types are class shapes (or sentinels) the `firebase/firestore`
// modular SDK exposes. They're shared across both targets in the
// sense that:
//
//   - **Prod target** uses them natively (round-trips through the
//     wire encoder, server stores them as proper Firestore values).
//   - **Sandbox target** rides `Bytes`, `GeoPoint`, and `VectorValue`
//     through their converters at `sandbox/firestore/converters/` on
//     write, then finalizes the read back to `fb.Bytes` / `fb.GeoPoint`
//     / `fb.VectorValue` in {@link finalizeSandboxValue} so consumer
//     code's `instanceof` checks match prod. `vector()` / `VectorValue`
//     are re-exported from `firebase/firestore` like the others.
//
// `documentId()` and `FieldPath` ARE supported on both sides today —
// `documentId()` returns a `FieldPath` sentinel that the chainable
// adapter recognizes as "by document id" when passed to `where()`.

export {
  Bytes,
  GeoPoint,
  documentId,
  FieldPath,
  vector,
  VectorValue,
} from 'firebase/firestore';

// ─── Tier 1: equality helpers (target-aware) ─────────────────────────

/**
 * Structural equality for two refs / queries / snapshots. The
 * native helpers (`fb.refEqual` etc.) only handle prod-shape values;
 * for sandbox-shape values we fall back to a fullPath / toString
 * comparison that matches the JS SDK's semantics. Throws when the
 * pair routes to different targets — that's a programming error.
 */
/**
 * Routing match for equality helpers. Sandbox and sandbox-live are
 * compatible at the equality layer — two refs that name the same
 * path are equal regardless of whether their owning Firestore
 * handle was built from a frozen `SandboxContext` or a live
 * `Sandbox`. The structural comparison falls back to `fullPath` /
 * `toString` per the JS SDK's semantics, which works uniformly
 * across both shapes.
 *
 * Crossing sandbox vs prod is still a programming error and throws.
 */
function targetMatch(a: object, b: object): Target {
  const ta = targetOf(a);
  const tb = targetOf(b);
  const aSandbox = isSandboxKind(ta);
  const bSandbox = isSandboxKind(tb);
  if (aSandbox !== bSandbox) {
    throw new TypeError(
      'pyric/firestore: cannot compare references / queries / snapshots across different targets.',
    );
  }
  return ta;
}

/** True when two `DocumentReference`s point at the same path under
 *  the same target. */
export function refEqual(a: DocumentReference, b: DocumentReference): boolean {
  const t = targetMatch(a, b);
  if (t.kind === 'prod') return fb.refEqual(asFbDoc(a), asFbDoc(b));
  // Sandbox + sandbox-live both compare by path — `underlyingOf` peels
  // any `withConverter` shell so a typed ref equals its underlying.
  return (underlyingOf(a) as { path: string }).path
    === (underlyingOf(b) as { path: string }).path;
}

/** True when two `Query`s are structurally identical (same source +
 *  same constraint chain). */
export function queryEqual(a: Query, b: Query): boolean {
  const t = targetMatch(a as object, b as object);
  if (t.kind === 'prod') return fb.queryEqual(asFbQuery(a), asFbQuery(b));
  // Sandbox-target queries don't expose a deep-equality contract;
  // fall back to identity. Most consumer code that asks `queryEqual`
  // is comparing the same returned object against a cached one,
  // which identity handles.
  return a === b;
}

/** True when two `DocumentSnapshot` / `QuerySnapshot` pairs describe
 *  the same underlying data + path. */
export function snapshotEqual(
  a: DocumentSnapshot | QuerySnapshot,
  b: DocumentSnapshot | QuerySnapshot,
): boolean {
  const t = targetMatch(a as object, b as object);
  if (t.kind === 'prod') {
    return fb.snapshotEqual(
      a as unknown as fb.DocumentSnapshot | fb.QuerySnapshot,
      b as unknown as fb.DocumentSnapshot | fb.QuerySnapshot,
    );
  }
  return a === b;
}

// ─── Tier 1: emulator connect (prod-target only) ─────────────────────

/**
 * Point the prod-target Firestore handle at the Firestore emulator.
 * Must be called BEFORE any operation runs against `db`. No-op on
 * sandbox-target handles (the sandbox IS a local emulator).
 *
 * `options` mirrors `firebase/firestore`'s shape — pass
 * `{ mockUserToken: '…' }` to bypass auth checks under the emulator,
 * matching how the JS SDK lets tests skip Firebase Auth.
 */
export function connectFirestoreEmulator(
  db: Firestore,
  host: string,
  port: number,
  options?: { mockUserToken?: string | fb.EmulatorMockTokenOptions },
): void {
  const target = targetOf(db);
  if (isSandboxKind(target)) {
    // The sandbox already runs locally; pointing it at an emulator
    // host is a no-op rather than an error so consumer code that
    // does the wiring unconditionally compiles against both targets.
    return;
  }
  fb.connectFirestoreEmulator(target.db, host, port, options);
}

// ─── Tier: offline / persistence / network family (issue #144) ────────
//
// HONEST-MIRROR NOTE — read this before touching any function below.
//
// `firebase/firestore`'s persistence and network toggles exist because
// the real SDK juggles THREE tiers: an in-memory cache, an optional
// IndexedDB cache, and a server. These functions negotiate which tiers
// are active and whether the client is reachable.
//
// The sandbox has none of that structure. It IS the backend — writes
// land directly in the sandbox's store, with no server round-trip to
// wait on and no network link to drop. When the host (`pyric-tools
// serve`, or a bare `initializeSandbox()` call with persistence
// enabled) turns on IndexedDB persistence, EVERY sandbox write already
// flushes to IndexedDB by default — an app never has to ask for it.
//
// So each function below does the one HONEST thing available in that
// model: either resolve immediately because the thing it promises is
// already true, or resolve as a documented no-op because there is
// nothing local for it to mean. None of these SIMULATE a capability
// the sandbox doesn't have (there is no fake "offline mode" here) —
// they just stop a real app's init sequence from crashing on an
// import that used to not exist.
//
// Prod targets are unaffected: every function below forwards to the
// real `fb.*` implementation when `db` was built from a `FirebaseApp`.

/**
 * Sandbox: no-op success. The sandbox's default persistence (IndexedDB
 * on the SharedWorker/serve path, or whatever backend `enablePersistence`
 * was configured with) already caches every write — this call has
 * nothing left to enable. Resolves immediately.
 *
 * Unlike the real SDK, this does NOT reject with `'failed-precondition'`
 * when called after other Firestore ops have already run. The guard
 * exists in the real SDK to protect an actual cache-initialization
 * race; the sandbox has no such race (there's no cache to initialize),
 * so enforcing the same restriction would only make app code that
 * calls this defensively at startup fail for no local reason.
 *
 * Prod: forwards to `firebase/firestore`'s real implementation.
 */
export function enableIndexedDbPersistence(
  db: Firestore,
  persistenceSettings?: fb.PersistenceSettings,
): Promise<void> {
  const target = targetOf(db);
  if (isSandboxKind(target)) return Promise.resolve();
  return fb.enableIndexedDbPersistence(target.db, persistenceSettings);
}

/**
 * Sandbox: no-op success, same rationale as {@link enableIndexedDbPersistence}.
 * Multi-tab coordination is meaningless here too: the sandbox's
 * SharedWorker path already IS the single shared store every tab talks
 * to, so there's no separate "multi-tab" mode to opt into.
 *
 * Prod: forwards to `firebase/firestore`.
 */
export function enableMultiTabIndexedDbPersistence(db: Firestore): Promise<void> {
  const target = targetOf(db);
  if (isSandboxKind(target)) return Promise.resolve();
  return fb.enableMultiTabIndexedDbPersistence(target.db);
}

/**
 * Sandbox: actually clears the sandbox's persisted store via
 * `Sandbox.clearPersistence()` — the honest mapping, not a no-op. This
 * wipes the persisted blob (IndexedDB, or whatever backend
 * `enablePersistence` was configured with) while leaving in-memory
 * state untouched, matching `clearPersistence`'s own contract. It is
 * ALREADY a no-op when persistence was never enabled, so callers that
 * invoke this defensively at startup are safe either way.
 *
 * `getFirestore(ctx)` (frozen `SandboxContext`) targets don't carry a
 * live `Sandbox` handle with a `clearPersistence` method reachable the
 * same way as a `sandbox`/`sandbox-live` target's `.sandbox` field —
 * both variants do, in fact, so this always has a sandbox to call into.
 *
 * Prod: forwards to `firebase/firestore`. Note the real SDK requires
 * this to be called before Firestore starts; the sandbox's mapped
 * `clearPersistence()` has no such restriction.
 */
export function clearIndexedDbPersistence(db: Firestore): Promise<void> {
  const target = targetOf(db);
  if (isSandboxKind(target)) return target.sandbox.clearPersistence();
  return fb.clearIndexedDbPersistence(target.db);
}

/**
 * Sandbox: no-op success. There is no network in the sandbox — every
 * op is a local call into the in-memory/IndexedDB-backed store — so
 * there is nothing to disable. This deliberately does NOT simulate an
 * offline mode: queued writes still commit immediately rather than
 * queuing, because the sandbox cannot honestly deliver "queued until
 * reconnected" when there is no connection to lose in the first place.
 * App code that calls this to prep for flaky connectivity will not
 * crash, but it also will not observe write-queuing behavior.
 *
 * Prod: forwards to `firebase/firestore`, which has a real network to
 * disable.
 */
export function disableNetwork(db: Firestore): Promise<void> {
  const target = targetOf(db);
  if (isSandboxKind(target)) return Promise.resolve();
  return fb.disableNetwork(target.db);
}

/**
 * Sandbox: no-op success, symmetric with {@link disableNetwork} — since
 * network was never disabled locally, there is nothing to re-enable.
 *
 * Prod: forwards to `firebase/firestore`.
 */
export function enableNetwork(db: Firestore): Promise<void> {
  const target = targetOf(db);
  if (isSandboxKind(target)) return Promise.resolve();
  return fb.enableNetwork(target.db);
}

/**
 * Sandbox: resolves immediately. The real SDK's version waits for
 * queued writes to reach the server; the sandbox has no server to wait
 * on — every write it accepts is already committed to the local store
 * by the time the write's own promise resolves, so by the time this is
 * called there are, honestly, never any writes still pending a round
 * trip.
 *
 * Prod: forwards to `firebase/firestore`.
 */
export function waitForPendingWrites(db: Firestore): Promise<void> {
  const target = targetOf(db);
  if (isSandboxKind(target)) return Promise.resolve();
  return fb.waitForPendingWrites(target.db);
}

/**
 * Sandbox: genuinely tears the target down by calling
 * `Sandbox.dispose()` — NOT a pure no-op like the rest of this family.
 * `dispose()` tears down listener registries on the sandbox's
 * environment without replacing it (idempotent, doesn't touch data).
 * This is the honest mapping of "terminate this Firestore instance":
 * a real app that calls `terminate(db)` expects listeners to stop and
 * the instance to be unusable for further meaningful work, and
 * `dispose()` delivers exactly that for the sandbox.
 *
 * Caveat: `dispose()` operates on the whole `Sandbox`, not a
 * Firestore-only slice of it — if `pyric/database` or `pyric/storage`
 * share the same `Sandbox`, their listener registries are torn down
 * too. This differs from the real SDK, where `terminate()` only
 * affects the one `Firestore` instance. Documented divergence.
 *
 * Prod: forwards to `firebase/firestore`'s real `terminate`, which
 * only tears down the one Firestore instance.
 */
export function terminate(db: Firestore): Promise<void> {
  const target = targetOf(db);
  if (isSandboxKind(target)) {
    target.sandbox.dispose();
    return Promise.resolve();
  }
  return fb.terminate(target.db);
}

// ─── Tier-1 cache-init + get-from-* + log-level + snapshot-sync ───────
// (issue #144, tier-1 pass). These extend the honest-mirror rationale
// above: a real app's explicit-init pattern —
//
//   initializeFirestore(app, {
//     localCache: persistentLocalCache(persistentMultipleTabManager()),
//   })
//
// — crashed at IMPORT (a missing named export) before this pass, before
// the app ever ran a read or write. `initializeFirestore` and the six
// cache-factory tokens below are aliases and honest no-op config
// tokens, not new feature work: the sandbox is local-first with
// persistence on by default, so there is no separate cache tier to
// configure into existence. `getDocFromServer`/`getDocFromCache` and
// their plural forms delegate to the same read path as `getDoc`/
// `getDocs` on sandbox targets (the sandbox store IS the authoritative,
// always-fresh source — there's no cache/server split to honor);
// on prod targets they forward to the real split. `setLogLevel` and
// `onSnapshotsInSync` round out the surface a real app's init sequence
// commonly touches alongside the persistence family.

/** Hidden brand on {@link LocalCache} tokens returned by
 *  {@link persistentLocalCache} / {@link memoryLocalCache}. Never
 *  inspected by consumer code — `initializeFirestore` accepts the
 *  token but the cache/network settings it carries are no-ops. */
const LOCAL_CACHE_SYMBOL: unique symbol = Symbol('pyric/firestore/localCache');
/** Hidden brand on tab-manager tokens returned by
 *  {@link persistentSingleTabManager} / {@link persistentMultipleTabManager}. */
const TAB_MANAGER_SYMBOL: unique symbol = Symbol('pyric/firestore/tabManager');
/** Hidden brand on garbage-collector tokens returned by
 *  {@link memoryEagerGarbageCollector} / {@link memoryLruGarbageCollector}. */
const GC_SYMBOL: unique symbol = Symbol('pyric/firestore/gc');

/** Opaque tab-manager config token. Inert — persistence is always on,
 *  and the SharedWorker/`pyric dev` path already is the one shared
 *  store every tab talks to, so there is no separate multi-tab mode
 *  to opt into. Carries the requested kind only for debugging. */
export interface PersistentTabManager {
  readonly [TAB_MANAGER_SYMBOL]: 'single' | 'multiple';
}

/** Opaque garbage-collector config token. Inert for the same reason —
 *  there is no memory cache tier with GC pressure to tune. */
export interface MemoryGarbageCollector {
  readonly [GC_SYMBOL]: 'eager' | 'lru';
}

/** Opaque local-cache config token accepted by {@link initializeFirestore}'s
 *  `settings.localCache`. Inert — see the tier-1 section rationale above. */
export interface LocalCache {
  readonly [LOCAL_CACHE_SYMBOL]: 'persistent' | 'memory';
  readonly tabManager?: PersistentTabManager;
  readonly garbageCollector?: MemoryGarbageCollector;
}

/**
 * Inert config token. Real Firebase uses this to select an on-disk,
 * persistent IndexedDB cache tier; the sandbox has no separate cache
 * tier — persistence is already the default — so this just returns a
 * tagged token `initializeFirestore` can accept without crashing.
 */
export function persistentLocalCache(settings?: {
  tabManager?: PersistentTabManager;
  cacheSizeBytes?: number;
}): LocalCache {
  return { [LOCAL_CACHE_SYMBOL]: 'persistent', tabManager: settings?.tabManager };
}

/** Inert config token — the memory-cache counterpart of {@link persistentLocalCache}. */
export function memoryLocalCache(settings?: {
  garbageCollector?: MemoryGarbageCollector;
}): LocalCache {
  return { [LOCAL_CACHE_SYMBOL]: 'memory', garbageCollector: settings?.garbageCollector };
}

/** Inert config token accepted by {@link persistentLocalCache}'s `tabManager`. */
export function persistentSingleTabManager(
  _settings?: { forceOwnership?: boolean },
): PersistentTabManager {
  return { [TAB_MANAGER_SYMBOL]: 'single' };
}

/** Inert config token accepted by {@link persistentLocalCache}'s `tabManager`. */
export function persistentMultipleTabManager(): PersistentTabManager {
  return { [TAB_MANAGER_SYMBOL]: 'multiple' };
}

/** Inert config token accepted by {@link memoryLocalCache}'s `garbageCollector`. */
export function memoryEagerGarbageCollector(): MemoryGarbageCollector {
  return { [GC_SYMBOL]: 'eager' };
}

/** Inert config token accepted by {@link memoryLocalCache}'s `garbageCollector`. */
export function memoryLruGarbageCollector(
  _settings?: { cacheSizeBytes?: number },
): MemoryGarbageCollector {
  return { [GC_SYMBOL]: 'lru' };
}

/** Client-cache/network settings `initializeFirestore` accepts but no-ops
 *  on sandbox targets — see the tier-1 section rationale above. */
export interface FirestoreSettings {
  localCache?: LocalCache;
  cacheSizeBytes?: number;
  ignoreUndefinedProperties?: boolean;
  experimentalForceLongPolling?: boolean;
  experimentalAutoDetectLongPolling?: boolean;
  host?: string;
  ssl?: boolean;
}

/**
 * Delegates to {@link getFirestore} and returns the same handle. Accepts
 * the `settings` argument (so the explicit-init pattern app code commonly
 * writes — `initializeFirestore(app, { localCache: persistentLocalCache(...) } )`
 * — no longer crashes at import) but no-ops the cache/network settings:
 * persistence is already the sandbox default, so there is nothing left to
 * configure into existence.
 *
 * Prod: settings ARE meaningful to `firebase/firestore`, but this helper
 * still only forwards to `getFirestore(app)` — a real cache/network
 * settings pass-through for the prod path is out of scope for this tier-1
 * pass (tracked separately).
 */
export function initializeFirestore(
  app: FirebaseApp | PyricApp,
  _settings?: FirestoreSettings,
  _databaseId?: string,
): Firestore {
  return getFirestore(app as FirebaseApp);
}

/**
 * Sandbox: delegates to {@link getDoc}. The sandbox store IS the
 * authoritative, always-fresh source — there is no separate server
 * round-trip to force, so "from server" and the default read are the
 * same honest thing.
 *
 * Prod: forwards to `firebase/firestore`'s real `getDocFromServer`,
 * which does force a server round-trip.
 */
export function getDocFromServer<T = DocumentData>(
  ref: DocumentReference<T>,
): Promise<DocumentSnapshot<T>> {
  const target = targetOf(ref);
  if (isSandboxKind(target)) return getDoc(ref);
  return fb.getDocFromServer(asFbDoc(ref)) as unknown as Promise<DocumentSnapshot<T>>;
}

/** Query-plural form of {@link getDocFromServer}. */
export function getDocsFromServer<T = DocumentData>(
  query: Query<T>,
): Promise<QuerySnapshot<T>> {
  const target = targetOf(query);
  if (isSandboxKind(target)) return getDocs(query);
  return fb.getDocsFromServer(asFbQuery(query)) as unknown as Promise<QuerySnapshot<T>>;
}

/**
 * Sandbox: delegates to {@link getDoc}. Real Firebase THROWS
 * `'unavailable'` here on a cache miss (nothing local matches the
 * ref); pyric never misses — the local store always has whatever is
 * there — so this never throws for that reason. Documented divergence,
 * not a claim of parity.
 *
 * Prod: forwards to `firebase/firestore`'s real `getDocFromCache`,
 * which DOES throw `'unavailable'` on a genuine cache miss.
 */
export function getDocFromCache<T = DocumentData>(
  ref: DocumentReference<T>,
): Promise<DocumentSnapshot<T>> {
  const target = targetOf(ref);
  if (isSandboxKind(target)) return getDoc(ref);
  return fb.getDocFromCache(asFbDoc(ref)) as unknown as Promise<DocumentSnapshot<T>>;
}

/** Query-plural form of {@link getDocFromCache} — same cache-miss divergence. */
export function getDocsFromCache<T = DocumentData>(
  query: Query<T>,
): Promise<QuerySnapshot<T>> {
  const target = targetOf(query);
  if (isSandboxKind(target)) return getDocs(query);
  return fb.getDocsFromCache(asFbQuery(query)) as unknown as Promise<QuerySnapshot<T>>;
}

/** Mirrors `firebase/firestore`'s `LogLevel` union. */
export type LogLevel = fb.LogLevel;

/**
 * Accepted no-op: the sandbox has no modular-SDK-style logger to wire
 * a level into (it uses host-level `console` logging directly, gated
 * by `pyric dev`'s own flags, not this call). Exists purely so app
 * code that calls this defensively at startup doesn't crash on a
 * missing export.
 */
export function setLogLevel(logLevel: LogLevel): void {
  void logLevel;
}

/**
 * Sandbox: fires the callback once the current snapshot-delivery
 * microtask queue settles — the closest honest approximation of "every
 * active listener has delivered its latest state" available without a
 * true cross-listener sync signal (the sandbox doesn't track one).
 * This is NOT the real SDK's guarantee (which is scoped to actual
 * server round-trips); it is scoped to local delivery only.
 *
 * Prod: forwards to `firebase/firestore`'s real `onSnapshotsInSync`.
 */
export function onSnapshotsInSync(
  db: Firestore,
  observerOrCallback: (() => void) | { next?: () => void; complete?: () => void; error?: (error: unknown) => void },
): Unsubscribe {
  const target = targetOf(db);
  if (isSandboxKind(target)) {
    const cb = typeof observerOrCallback === 'function' ? observerOrCallback : observerOrCallback.next;
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled && cb) cb();
    });
    return () => {
      cancelled = true;
    };
  }
  return fb.onSnapshotsInSync(
    target.db,
    observerOrCallback as unknown as Parameters<typeof fb.onSnapshotsInSync>[1],
  );
}

// Shorthand: cast helpers used inside route arms. The runtime objects
// match these shapes precisely; the casts let the routing keep its
// single-typed public surface.
function asChainDoc(r: object): ChainDocRef { return r as ChainDocRef; }
function asChainColl(r: object): ChainCollRef { return r as ChainCollRef; }
function asChainQuery(r: object): ChainQuery { return r as ChainQuery; }
function asFbDoc(r: object): fb.DocumentReference { return r as fb.DocumentReference; }
function asFbColl(r: object): fb.CollectionReference { return r as fb.CollectionReference; }
function asFbQuery(r: object): fb.Query { return r as fb.Query; }

// ─── Path constructors ────────────────────────────────────────────────

export function doc<T = DocumentData>(
  parent: Firestore | CollectionReference<T>,
  ...pathSegments: string[]
): DocumentReference<T> {
  const target = targetOf(parent);
  const isHandle = TARGET_SYMBOL in parent;
  // Propagate any converter from a typed collection to the resulting
  // doc — `doc(coll<User>, 'u1')` returns `DocumentReference<User>`.
  // For prod, fb's `.doc()` chain inherits the converter natively, so
  // this only needs to fire on the sandbox side.
  const conv = isHandle ? undefined : converterOf(parent);
  if (isSandboxKind(target)) {
    const db = sandboxDb(target);
    if (isHandle) {
      if (pathSegments.length === 0) {
        throw new TypeError('doc(db, path) requires at least one path segment.');
      }
      const path = pathSegments.join('/');
      const built = db.doc(path);
      const tagged = tagSandboxRef(
        built as object,
        target,
        (fresh) => fresh.doc(path) as unknown as object,
      );
      return tagged as DocumentReference<T>;
    }
    const coll = asChainColl(underlyingOf(parent));
    const ref = pathSegments.length === 0
      ? coll.doc()
      : coll.doc(pathSegments.join('/'));
    // The path is now known (either the explicit segments under the
    // parent's path, or the auto-minted id appended). Rebuild from
    // the absolute path so the live ref re-resolves under whatever
    // auth the next op picks up.
    const absPath = (ref as { path: string }).path;
    const tagged = tagSandboxRef(
      ref as object,
      target,
      (fresh) => fresh.doc(absPath) as unknown as object,
    );
    if (conv) {
      return buildSandboxShell(
        tagged as { id: string; path: string },
        target,
        conv,
      ) as DocumentReference<T>;
    }
    return tagged as DocumentReference<T>;
  }
  // prod
  if (isHandle) {
    if (pathSegments.length === 0) {
      throw new TypeError('doc(db, path) requires at least one path segment.');
    }
    return tag(fb.doc(target.db, pathSegments.join('/')) as object, target) as DocumentReference<T>;
  }
  const coll = asFbColl(parent);
  const ref = pathSegments.length === 0
    ? fb.doc(coll)
    : fb.doc(coll, pathSegments.join('/'));
  return tag(ref as object, target) as DocumentReference<T>;
}

/**
 * Cross-collection query — scans every document under every
 * collection whose final segment matches `collectionId`. Mirrors
 * `firebase/firestore`'s `collectionGroup(db, id)` shape.
 *
 * Returned `Query` accepts the same `where` / `orderBy` / `limit`
 * constraints as any other query.
 */
export function collectionGroup(db: Firestore, collectionId: string): Query {
  const target = targetOf(db);
  if (isSandboxKind(target)) {
    const q = sandboxDb(target).collectionGroup(collectionId);
    return tagSandboxRef(
      q as unknown as Query,
      target,
      (fresh) => fresh.collectionGroup(collectionId) as unknown as object,
    );
  }
  const q = fb.collectionGroup(target.db, collectionId);
  return tag(q as unknown as Query, target);
}

export function collection(parent: Firestore | DocumentReference, ...pathSegments: string[]): CollectionReference {
  const target = targetOf(parent);
  const isHandle = TARGET_SYMBOL in parent;
  if (pathSegments.length === 0) {
    throw new TypeError('collection() requires at least one path segment.');
  }
  // Note: any converter on `parent` (typed DocumentReference<T>) does
  // NOT propagate to the sub-collection — matches `firebase/firestore`'s
  // `collection(typedDoc, path)` returning `CollectionReference<DocumentData>`.
  // A parent doc's T describes its own data, not its subcollections'.
  if (isSandboxKind(target)) {
    if (isHandle) {
      const path = pathSegments.join('/');
      const built = sandboxDb(target).collection(path);
      return tagSandboxRef(
        built as CollectionReference,
        target,
        (fresh) => fresh.collection(path) as unknown as object,
      );
    }
    const docRef = asChainDoc(underlyingOf(parent));
    const subPath = pathSegments.join('/');
    const built = docRef.collection(subPath);
    const absPath = (built as { path: string }).path;
    return tagSandboxRef(
      built as CollectionReference,
      target,
      (fresh) => fresh.collection(absPath) as unknown as object,
    );
  }
  // prod
  if (isHandle) {
    return tag(fb.collection(target.db, pathSegments.join('/')) as CollectionReference, target);
  }
  const docRef = asFbDoc(parent);
  return tag(fb.collection(docRef, pathSegments.join('/')) as CollectionReference, target);
}

// ─── Reads ────────────────────────────────────────────────────────────

function isNumberArray(a: unknown): a is number[] {
  return Array.isArray(a) && a.every((n) => typeof n === 'number');
}

/**
 * A vector read from the sandbox may arrive as a live `Vector` wrapper, a
 * prototype-stripped plain object (`{typeName:'vector', value}`), or the wire
 * sentinel (`{__type__:'__vector__', value}`). Duck-type all three; `instanceof`
 * alone misses the stripped form the read path hands back. Returns the
 * components, or null if `value` isn't a vector.
 */
function vectorValuesOf(value: unknown): number[] | null {
  if (value instanceof RulesVector) return Array.from(value.value);
  if (value === null || typeof value !== 'object') return null;
  const o = value as Record<string, unknown>;
  if (o.typeName === 'vector' && isNumberArray(o.value)) return o.value;
  if (o.__type__ === '__vector__' && isNumberArray(o.value)) return o.value;
  return null;
}

/**
 * Final read-path translation for sandbox-target snapshots.
 *
 * The admin-compat read-path walker (in `pyric/sandbox`'s admin-compat
 * `snapshots.ts`) leaves `pyric/rules` wrappers (`Bytes`,
 * `LatLng`) as identity — it can't translate them to
 * `firebase/firestore`'s `Bytes` / `GeoPoint` because the admin-compat
 * layer doesn't depend on `firebase/firestore`.
 *
 * This package does, so we do the final hop here: walk the value tree
 * and convert any rules-wrapper instance into its `firebase/firestore`
 * counterpart so consumer code can rely on
 * `data.b instanceof fb.Bytes === true` and
 * `data.g instanceof fb.GeoPoint === true` against sandbox reads —
 * matching the prod-target invariant.
 *
 * Closes firestore COMPAT rows #109 (`Bytes`) and #110 (`GeoPoint`).
 * Vectors (#111, `VectorValue` / `vector()`) round-trip the same way as of
 * Phase 0-F; the formal COMPAT ✓ + oracle observation land with the
 * conformance phase (Phase 5b). Vector SEARCH (`findNearest`) is separate.
 */
function finalizeSandboxValue(value: unknown): unknown {
  if (value instanceof RulesBytes) {
    return fb.Bytes.fromUint8Array(value.data);
  }
  if (value instanceof RulesLatLng) {
    return new fb.GeoPoint(value.lat, value.lng);
  }
  const vectorValues = vectorValuesOf(value);
  if (vectorValues) {
    return fb.vector(vectorValues);
  }
  if (Array.isArray(value)) {
    return value.map(finalizeSandboxValue);
  }
  // Only walk plain objects (`{...}` literals + `Object.create(null)`).
  // Class instances we don't recognize pass through as identity so we
  // don't accidentally destructure their private state (the same gap
  // that motivated #109/#110 in the first place).
  if (value !== null && typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto === Object.prototype || proto === null) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = finalizeSandboxValue(v);
      }
      return out;
    }
  }
  return value;
}

function finalizeSandboxData(data: DocumentData | undefined): DocumentData | undefined {
  if (data === undefined) return undefined;
  return finalizeSandboxValue(data) as DocumentData;
}

/**
 * Wrap a raw sandbox `DocumentSnapshot` so `.data()` runs the final
 * value translation (rules wrappers → `firebase/firestore` types).
 * Other surface (id / ref / exists) passes through unchanged so
 * `tagSnapshotRefs` still operates on the original snap object.
 */
function wrapSandboxDocSnap<T>(snap: object): DocumentSnapshot<T> {
  const s = snap as {
    data: () => DocumentData | undefined;
  };
  const original = s.data.bind(snap);
  Object.defineProperty(s, 'data', {
    value: () => finalizeSandboxData(original()),
    configurable: true,
    writable: true,
  });
  return snap as DocumentSnapshot<T>;
}

/**
 * Wrap a plain sandbox `DocumentSnapshot` so `.data()` runs the
 * converter's `fromFirestore`. Identity / `exists` pass through.
 */
function applyConverterToDocSnap<AppModel>(
  snap: ChainDocSnap,
  conv: FirestoreDataConverter<AppModel>,
): DocumentSnapshot<AppModel> {
  return {
    id: snap.id,
    exists: snap.exists,
    data: () => {
      // Sandbox snaps expose `exists` as a property (Admin shape).
      const exists = typeof snap.exists === 'function'
        ? (snap.exists as () => boolean)()
        : snap.exists;
      if (!exists) return undefined;
      const raw = finalizeSandboxData(snap.data() as DocumentData) as DocumentData;
      // fromFirestore receives a QueryDocumentSnapshot-narrowed view —
      // doc is known to exist at this branch, so `data()` returns the
      // raw value (never undefined).
      const queryDocSnap: QueryDocumentSnapshot = {
        id: snap.id,
        exists: true,
        data: () => raw,
      };
      return conv.fromFirestore(queryDocSnap);
    },
  };
}

export async function getDoc<T = DocumentData>(ref: DocumentReference<T>): Promise<DocumentSnapshot<T>> {
  const target = targetOf(ref);
  if (isSandboxKind(target)) {
    const conv = converterOf(ref);
    const snap = await chainDocFor(target, ref).get();
    if (conv) {
      return applyConverterToDocSnap(
        snap as unknown as ChainDocSnap,
        conv as FirestoreDataConverter<T>,
      );
    }
    // Normalize `.exists` to method form + tag the snap's ref so
    // consumers get Firebase-modular-SDK shape uniformly.
    tagSnapshotRefs(snap, target);
    // Wrap .data() to translate `pyric/rules` wrappers
    // (Bytes / LatLng) into `firebase/firestore` types so reads match
    // prod's instanceof semantics. Closes firestore #109 + #110.
    return wrapSandboxDocSnap<T>(snap as object);
  }
  return fb.getDoc(asFbDoc(ref)) as unknown as Promise<DocumentSnapshot<T>>;
}

export async function getDocs<T = DocumentData>(query: Query<T>): Promise<QuerySnapshot<T>> {
  const target = targetOf(query);
  if (isSandboxKind(target)) {
    const conv = converterOf(query);
    const snap = await chainQueryFor(target, query).get();
    if (conv) {
      const c = conv as FirestoreDataConverter<T>;
      const wrappedDocs = (snap as unknown as ChainQuerySnap).docs.map((d) =>
        applyConverterToDocSnap(d as unknown as ChainDocSnap, c) as QueryDocumentSnapshot<T>,
      );
      return {
        size: wrappedDocs.length,
        empty: wrappedDocs.length === 0,
        docs: wrappedDocs,
      };
    }
    // Normalize each doc's `.exists` + tag the doc refs so consumer
    // code targeting Firebase's modular SDK works uniformly.
    tagSnapshotRefs(snap, target);
    // Wrap each doc snap's .data() to translate rules-wrappers to
    // `firebase/firestore` types — same parity hop as `getDoc` above.
    const docs = (snap as unknown as ChainQuerySnap).docs;
    for (const d of docs) wrapSandboxDocSnap(d as object);
    return snap as unknown as QuerySnapshot<T>;
  }
  return fb.getDocs(asFbQuery(query)) as unknown as Promise<QuerySnapshot<T>>;
}

// ─── Writes ───────────────────────────────────────────────────────────

/**
 * Modular Web-SDK-shaped `SetOptions`. Either flag controls how `data`
 * combines with the existing document; passing nothing replaces the
 * existing doc entirely (Firestore default).
 *
 *   - `{ merge: true }` — shallow-merge every top-level field in
 *     `data` into the existing document, preserving fields not in
 *     `data`. Equivalent to `firebase/firestore`'s `setDoc(ref, data,
 *     { merge: true })`.
 *   - `{ mergeFields: [...] }` — project `data` to just the listed
 *     top-level fields, then merge. Other fields in `data` are
 *     ignored; other fields in the existing doc are preserved.
 *
 * `merge` and `mergeFields` are mutually exclusive; passing both is
 * a programming error (`mergeFields` wins on the sandbox path,
 * matching the JS SDK's effective behavior).
 */
export interface SetOptions {
  merge?: boolean;
  mergeFields?: readonly string[];
}

export async function setDoc<T = DocumentData>(
  ref: DocumentReference<T>,
  data: T,
  options?: SetOptions,
): Promise<void> {
  const target = targetOf(ref);
  if (isSandboxKind(target)) {
    const conv = converterOf(ref);
    const payload = conv
      ? (conv as FirestoreDataConverter<T>).toFirestore(data)
      : (data as unknown as DocumentData);
    // Pass `options` through verbatim — `ChainSetOptions` is structurally
    // the same shape as our public `SetOptions` (sandbox layer adds an
    // optional `auth` field we don't expose at the modular layer).
    return chainDocFor(target, ref).set(payload, options as ChainSetOptions | undefined);
  }
  // Prod refs that came through `withConverter` carry their converter
  // on the fb ref itself — `fb.setDoc` invokes `toFirestore` natively.
  if (options === undefined) return fb.setDoc(asFbDoc(ref) as fb.DocumentReference<T>, data);
  return fb.setDoc(asFbDoc(ref) as fb.DocumentReference<T>, data, options as fb.SetOptions);
}

/**
 * `updateDoc` does NOT run the converter. Matches `firebase/firestore`'s
 * Web SDK shape — partial updates can target any subset of fields, so
 * a translator built around a full `AppModelType` would be a type-shape
 * mismatch. Use the underlying `DocumentData` view (`withConverter(ref,
 * null)`) for typed-and-untyped mixed access if you need both styles
 * against the same path.
 */
export async function updateDoc(ref: DocumentReference, data: DocumentData): Promise<void> {
  const target = targetOf(ref);
  if (isSandboxKind(target)) return chainDocFor(target, ref).update(data);
  return fb.updateDoc(asFbDoc(ref), data);
}

export async function deleteDoc(ref: DocumentReference): Promise<void> {
  const target = targetOf(ref);
  if (isSandboxKind(target)) return chainDocFor(target, ref).delete();
  return fb.deleteDoc(asFbDoc(ref));
}

export async function addDoc<T = DocumentData>(
  coll: CollectionReference<T>,
  data: T,
): Promise<DocumentReference<T>> {
  const target = targetOf(coll);
  if (isSandboxKind(target)) {
    const conv = converterOf(coll);
    const payload = conv
      ? (conv as FirestoreDataConverter<T>).toFirestore(data)
      : (data as unknown as DocumentData);
    const ref = await chainCollFor(target, coll).add(payload);
    // The freshly-minted doc has its auto-id path baked in. Record a
    // rebuild closure for sandbox-live so subsequent ops on `ref`
    // re-resolve against the current user (matches the doc()-factory
    // semantics for explicitly-pathed refs).
    const absPath = (ref as unknown as { path: string }).path;
    const tagged = tagSandboxRef(
      ref as object,
      target,
      (fresh) => fresh.doc(absPath) as unknown as object,
    );
    // Propagate the collection's converter onto the freshly-created
    // doc ref so `getDoc(addDocResult)` round-trips through the same
    // typing without an extra `withConverter` call. Matches fb's
    // native behavior.
    if (conv) {
      return buildSandboxShell(
        tagged as { id: string; path: string },
        target,
        conv,
      ) as DocumentReference<T>;
    }
    return tagged as DocumentReference<T>;
  }
  const ref = await fb.addDoc(asFbColl(coll) as fb.CollectionReference<T>, data);
  return tag(ref as object, target) as DocumentReference<T>;
}

// ─── withConverter (typed refs / queries) ────────────────────────────
//
// Modular Web-SDK shape (the JS SDK exposes it as a method on the ref;
// pyric exposes it as a free function for consistency with the rest of
// the surface, where every operation routes through a free call):
//
//   interface UserDb { name: string; createdAt: Timestamp; }
//   interface User    { name: string; createdAt: Date; }
//
//   const userConverter: FirestoreDataConverter<User, UserDb> = {
//     toFirestore: (u) => ({ name: u.name, createdAt: Timestamp.fromDate(u.createdAt) }),
//     fromFirestore: (snap) => {
//       const d = snap.data();
//       return { name: d.name, createdAt: d.createdAt.toDate() };
//     },
//   };
//
//   const users = withConverter(collection(db, 'users'), userConverter);
//   await setDoc(doc(users, 'alice'), { name: 'Alice', createdAt: new Date() });
//   const snap = await getDoc(doc(users, 'alice'));
//   const user: User | undefined = snap.data(); // typed!
//
// Behavior:
//   - The returned ref carries the converter forward through chain
//     factories (`doc(typedColl, id)`, `query(typedColl, ...)`).
//   - `setDoc` / `addDoc` invoke `toFirestore` before the write.
//   - `getDoc` / `getDocs` invoke `fromFirestore` on each result.
//   - `updateDoc` does NOT run the converter (matches JS SDK; partial
//     writes don't have a typed home).
//   - Passing `null` strips an existing converter, returning the
//     underlying untyped ref.

export function withConverter<AppModel, DbModel extends DocumentData = DocumentData>(
  ref: DocumentReference<DocumentData>,
  converter: FirestoreDataConverter<AppModel, DbModel>,
): DocumentReference<AppModel>;
export function withConverter(
  ref: DocumentReference<unknown>,
  converter: null,
): DocumentReference<DocumentData>;
export function withConverter<AppModel, DbModel extends DocumentData = DocumentData>(
  ref: CollectionReference<DocumentData>,
  converter: FirestoreDataConverter<AppModel, DbModel>,
): CollectionReference<AppModel>;
export function withConverter(
  ref: CollectionReference<unknown>,
  converter: null,
): CollectionReference<DocumentData>;
export function withConverter<AppModel, DbModel extends DocumentData = DocumentData>(
  q: Query<DocumentData>,
  converter: FirestoreDataConverter<AppModel, DbModel>,
): Query<AppModel>;
export function withConverter(
  q: Query<unknown>,
  converter: null,
): Query<DocumentData>;
export function withConverter(
  source: object,
  converter: FirestoreDataConverter<unknown, DocumentData> | null,
): object {
  const target = targetOf(source);
  if (target.kind === 'prod') {
    // fb's native withConverter is on every ref / query — applies the
    // converter to all subsequent reads / writes through fb's own API.
    const native = (source as fb.DocumentReference | fb.CollectionReference | fb.Query) as {
      withConverter: (
        c: fb.FirestoreDataConverter<unknown, DocumentData> | null,
      ) => fb.DocumentReference | fb.CollectionReference | fb.Query;
    };
    const out = native.withConverter(
      converter as fb.FirestoreDataConverter<unknown, DocumentData> | null,
    );
    return tag(out as object, target);
  }
  // Sandbox.
  if (converter === null) {
    // Strip — return the underlying plain ref. Falls back to `source`
    // itself if it was never wrapped (no-op).
    return underlyingOf(source);
  }
  const underlying = underlyingOf(source) as { id?: string; path?: string };
  return buildSandboxShell(underlying, target, converter);
}

// ─── Query constraints ────────────────────────────────────────────────

export interface QueryConstraint {
  // Apply against either backend's query type. Each constraint factory
  // builds a per-target apply function so query() doesn't need to
  // re-discriminate.
  applySandbox(q: ChainQuery): ChainQuery;
  applyProd(q: fb.Query): fb.Query;
  /**
   * Internal — the filter representation for composite-filter
   * composition. `where()` populates it as a leaf; `or()` / `and()`
   * combine sub-constraints' filters into a composite tree. Non-filter
   * constraints (`orderBy`, `limit`) leave it undefined; passing one
   * to `or()` / `and()` throws.
   */
  _sandboxFilter?: ChainFilter;
  _fbFilter?: fb.QueryFilterConstraint;
}

export function query<T = DocumentData>(
  source: CollectionReference<T> | Query<T>,
  ...constraints: QueryConstraint[]
): Query<T> {
  const target = targetOf(source);
  const conv = converterOf(source);
  if (isSandboxKind(target)) {
    // Apply constraints to the source's chainable query. For
    // sandbox-live we rebuild via the parent's rebuild closure under
    // a transient handle so the resulting tagged query has a known
    // shape; the rebuild closure we record below applies the same
    // constraint chain against a *fresh* handle at op time.
    const sourceRebuild = parentRebuild(source);
    const buildAt = (db: SandboxFirestore): ChainQuery => {
      let q = sourceRebuild(db) as ChainQuery;
      for (const c of constraints) q = c.applySandbox(q);
      return q;
    };
    const q = buildAt(sandboxDb(target));
    const tagged = tagSandboxRef(
      q as unknown as Query<T>,
      target,
      (fresh) => buildAt(fresh) as unknown as object,
    );
    // Propagate any converter from a typed source through the new query.
    if (conv) {
      return buildSandboxShell(
        tagged as unknown as { id?: string; path?: string },
        target,
        conv,
      ) as Query<T>;
    }
    return tagged as Query<T>;
  }
  let q = asFbQuery(source);
  for (const c of constraints) q = c.applyProd(q);
  return tag(q as unknown as object, target) as Query<T>;
}

export function where(field: string, op: WhereFilterOp, value: unknown): QueryConstraint {
  const sandboxFilter: ChainFilter = { kind: 'where', field, op, value };
  const fbFilter = fb.where(field, op as fb.WhereFilterOp, value);
  return {
    applySandbox: (q) => q.where(field, op, value),
    applyProd: (q) => fb.query(q, fbFilter),
    _sandboxFilter: sandboxFilter,
    _fbFilter: fbFilter,
  };
}

/**
 * OR composite — at least one of the inner constraints must match.
 * Each argument must itself be a filter constraint (`where()`, or
 * nested `or()` / `and()`); passing `orderBy()` or `limit()` here is
 * a type error at runtime.
 *
 * Mirrors `firebase/firestore`'s `or(...filters)` shape.
 */
export function or(...filters: QueryConstraint[]): QueryConstraint {
  return composite('or', filters);
}

/**
 * AND composite. Same shape as `or()` but every inner constraint
 * must match. Useful inside an `or()` to combine constraints that
 * would otherwise be at the top level.
 */
export function and(...filters: QueryConstraint[]): QueryConstraint {
  return composite('and', filters);
}

/**
 * Build a composite QueryConstraint. Extracts each sub-constraint's
 * sandbox + fb filter representations; throws when any input is a
 * non-filter (`orderBy` / `limit`).
 */
function composite(
  kind: 'and' | 'or',
  filters: QueryConstraint[],
): QueryConstraint {
  if (filters.length === 0) {
    throw new TypeError(
      `pyric/firestore: ${kind}() requires at least one filter argument.`,
    );
  }
  const sandboxSubs: ChainFilter[] = [];
  const fbSubs: fb.QueryFilterConstraint[] = [];
  for (const c of filters) {
    if (c._sandboxFilter === undefined || c._fbFilter === undefined) {
      throw new TypeError(
        `pyric/firestore: ${kind}() received a non-filter constraint (orderBy / limit are not valid here).`,
      );
    }
    sandboxSubs.push(c._sandboxFilter);
    fbSubs.push(c._fbFilter);
  }
  const sandboxFilter: ChainFilter = { kind, filters: sandboxSubs };
  const fbFilter = kind === 'or' ? fb.or(...fbSubs) : fb.and(...fbSubs);
  return {
    applySandbox: (q) => q.applyFilter(sandboxFilter),
    applyProd: (q) => fb.query(q, fbFilter),
    _sandboxFilter: sandboxFilter,
    _fbFilter: fbFilter,
  };
}

export function orderBy(field: string, direction?: OrderDirection): QueryConstraint {
  return {
    applySandbox: (q) => q.orderBy(field, direction),
    applyProd: (q) => fb.query(q, fb.orderBy(field, direction as fb.OrderByDirection | undefined)),
  };
}

export function limit(n: number): QueryConstraint {
  return {
    applySandbox: (q) => q.limit(n),
    applyProd: (q) => fb.query(q, fb.limit(n)),
  };
}

// ─── Cursor pagination + limitToLast (Tier 3) ────────────────────────
//
// Modular Web-SDK shape:
//
//   query(coll,
//     orderBy('priority'),
//     startAfter(prevPagePriority),
//     limit(10),
//   );
//
// Each cursor factory accepts a positional values list (one per
// orderBy clause). For sandbox-target, the values pass straight into
// the chainable Query.startCursor / endCursor methods; for prod, we
// spread into `fb.startAt(...values)` etc. The DocumentSnapshot
// overload (`startAt(snapshot)`) lands in a follow-up commit.

/**
 * Limit the query to the LAST `n` documents in the ordered result.
 * Requires at least one `orderBy` on the query (production-aligned —
 * the simulator throws at execute time without one).
 */
export function limitToLast(n: number): QueryConstraint {
  return {
    applySandbox: (q) => q.limitToLast(n),
    applyProd: (q) => fb.query(q, fb.limitToLast(n)),
  };
}

/**
 * Cursor argument — either a positional list of field values or a
 * `DocumentSnapshot` to extract the values from. Mirrors the JS
 * SDK's overloaded `startAt` / `startAfter` / `endAt` / `endBefore`
 * shape.
 */
type CursorArg = DocumentSnapshot | unknown;

/**
 * Heuristic for the snapshot overload: a single argument whose
 * `.data` is a function. Both the chainable adapter's
 * `AdminDocumentSnapshot` and `firebase/firestore`'s
 * `DocumentSnapshot` expose `.data()` so this catches both targets
 * cleanly. Falls back to the values-spread variant for everything
 * else (including a single non-snapshot scalar arg, which is
 * legitimate when the orderBy is on one field).
 */
function isDocumentSnapshot(args: unknown[]): args is [DocumentSnapshot] {
  if (args.length !== 1) return false;
  const a = args[0];
  return (
    a !== null &&
    typeof a === 'object' &&
    'data' in a &&
    typeof (a as { data: unknown }).data === 'function'
  );
}

/**
 * Start the query at the document whose ordered field values match
 * the cursor. Inclusive — the document at the cursor IS included in
 * the result. Two overloads:
 *
 *   `startAt(snapshot)` — values come from `snapshot.data()` indexed
 *     by the query's orderBy fields.
 *   `startAt(...values)` — explicit positional values (one per
 *     orderBy clause).
 */
export function startAt(snapshot: DocumentSnapshot): QueryConstraint;
export function startAt(...values: unknown[]): QueryConstraint;
export function startAt(...args: CursorArg[]): QueryConstraint {
  if (isDocumentSnapshot(args)) {
    const snap = args[0];
    return {
      applySandbox: (q) => q.startCursorFromSnapshot(snap as unknown as ChainDocSnap, true),
      applyProd: (q) => fb.query(q, fb.startAt(snap as unknown as fb.DocumentSnapshot)),
    };
  }
  return {
    applySandbox: (q) => q.startCursor(args, true),
    applyProd: (q) => fb.query(q, fb.startAt(...args)),
  };
}

/** Same as `startAt`, but EXCLUDES the document at the cursor — the
 *  result starts at the next ordered position. */
export function startAfter(snapshot: DocumentSnapshot): QueryConstraint;
export function startAfter(...values: unknown[]): QueryConstraint;
export function startAfter(...args: CursorArg[]): QueryConstraint {
  if (isDocumentSnapshot(args)) {
    const snap = args[0];
    return {
      applySandbox: (q) => q.startCursorFromSnapshot(snap as unknown as ChainDocSnap, false),
      applyProd: (q) => fb.query(q, fb.startAfter(snap as unknown as fb.DocumentSnapshot)),
    };
  }
  return {
    applySandbox: (q) => q.startCursor(args, false),
    applyProd: (q) => fb.query(q, fb.startAfter(...args)),
  };
}

/** End the query at the document whose ordered field values match
 *  the cursor. Inclusive — the document at the cursor IS included. */
export function endAt(snapshot: DocumentSnapshot): QueryConstraint;
export function endAt(...values: unknown[]): QueryConstraint;
export function endAt(...args: CursorArg[]): QueryConstraint {
  if (isDocumentSnapshot(args)) {
    const snap = args[0];
    return {
      applySandbox: (q) => q.endCursorFromSnapshot(snap as unknown as ChainDocSnap, true),
      applyProd: (q) => fb.query(q, fb.endAt(snap as unknown as fb.DocumentSnapshot)),
    };
  }
  return {
    applySandbox: (q) => q.endCursor(args, true),
    applyProd: (q) => fb.query(q, fb.endAt(...args)),
  };
}

/** Same as `endAt`, but EXCLUDES the document at the cursor — the
 *  result ends at the prior ordered position. */
export function endBefore(snapshot: DocumentSnapshot): QueryConstraint;
export function endBefore(...values: unknown[]): QueryConstraint;
export function endBefore(...args: CursorArg[]): QueryConstraint {
  if (isDocumentSnapshot(args)) {
    const snap = args[0];
    return {
      applySandbox: (q) => q.endCursorFromSnapshot(snap as unknown as ChainDocSnap, false),
      applyProd: (q) => fb.query(q, fb.endBefore(snap as unknown as fb.DocumentSnapshot)),
    };
  }
  return {
    applySandbox: (q) => q.endCursor(args, false),
    applyProd: (q) => fb.query(q, fb.endBefore(...args)),
  };
}

// ─── Aggregates (Tier 2) ──────────────────────────────────────────────
//
// Modular Web-SDK shape:
//
//   import { getCountFromServer, getAggregateFromServer,
//            count, sum, average } from 'pyric/firestore';
//
//   const c = await getCountFromServer(query(coll, where(...)));
//   c.data().count // → number
//
//   const a = await getAggregateFromServer(coll, {
//     n:           count(),
//     totalPrice:  sum('price'),
//     avgRating:   average('rating'),
//   });
//   a.data() // → { n, totalPrice, avgRating: number|null }
//
// `AggregateField` is target-agnostic at construction time
// (`{ kind: 'count' | 'sum' | 'average', field? }`) and gets translated
// to `firebase/firestore`'s native `fb.AggregateField` instances at
// the prod call site.

/**
 * Aggregate-field descriptor returned by `count()` / `sum(field)` /
 * `average(field)`. Pyric-native; both targets accept it.
 */
export type AggregateField =
  | { readonly kind: 'count' }
  | { readonly kind: 'sum'; readonly field: string }
  | { readonly kind: 'average'; readonly field: string };

/** Spec passed to `getAggregateFromServer(query, spec)`. */
export type AggregateSpec = Record<string, AggregateField>;

/**
 * Snapshot returned by `getCountFromServer` /
 * `getAggregateFromServer`. `.data()` returns the computed numbers
 * keyed by the spec's aliases (or `{ count: number }` for the
 * count-only entry point).
 */
export interface AggregateQuerySnapshot<T extends Record<string, number | null> = Record<string, number | null>> {
  data(): T;
}

/** Factory: count() aggregate. */
export function count(): AggregateField {
  return { kind: 'count' };
}

/** Factory: sum-of-`field` aggregate. */
export function sum(field: string): AggregateField {
  return { kind: 'sum', field };
}

/** Factory: average-of-`field` aggregate. */
export function average(field: string): AggregateField {
  return { kind: 'average', field };
}

/**
 * Count documents matching the query. Returns a snapshot whose
 * `.data()` yields `{ count: N }` — same shape `firebase/firestore`'s
 * `getCountFromServer` produces.
 */
export async function getCountFromServer(
  source: Query | CollectionReference,
): Promise<AggregateQuerySnapshot<{ count: number }>> {
  const target = targetOf(source);
  if (isSandboxKind(target)) {
    const snap = await chainQueryFor(target, source).aggregate({ count: { kind: 'count' } });
    const data = snap.data();
    return { data: () => ({ count: (data.count ?? 0) as number }) };
  }
  const snap = await fb.getCountFromServer(asFbQuery(source));
  return { data: () => ({ count: snap.data().count }) };
}

/**
 * Run a multi-field aggregate against the query. Spec entries are
 * keyed by caller-chosen aliases; the returned snapshot's `.data()`
 * uses the same keys.
 *
 * Sandbox target dispatches straight into the chainable adapter.
 * Prod target translates pyric's `AggregateField` shapes into
 * `firebase/firestore` AggregateField instances (`fb.count()`,
 * `fb.sum(...)`, `fb.average(...)`) before delegating.
 */
export async function getAggregateFromServer<S extends AggregateSpec>(
  source: Query | CollectionReference,
  spec: S,
): Promise<AggregateQuerySnapshot<{ [K in keyof S]: number | null }>> {
  const target = targetOf(source);
  if (isSandboxKind(target)) {
    // The sandbox spec shape is structurally identical to ours, but
    // we re-construct so the type system sees `ChainAggregateSpec`
    // explicitly (avoids a chained cast at the call site).
    const chainSpec: ChainAggregateSpec = {};
    for (const alias of Object.keys(spec)) chainSpec[alias] = spec[alias] as ChainAggregateField;
    const snap = await chainQueryFor(target, source).aggregate(chainSpec);
    return { data: () => snap.data() as { [K in keyof S]: number | null } };
  }
  // Prod — translate spec to firebase/firestore AggregateField objects.
  const fbSpec: Record<string, fb.AggregateField<unknown>> = {};
  for (const alias of Object.keys(spec)) {
    const f = spec[alias];
    if (f.kind === 'count')   fbSpec[alias] = fb.count();
    else if (f.kind === 'sum')     fbSpec[alias] = fb.sum(f.field);
    else                           fbSpec[alias] = fb.average(f.field);
  }
  const snap = await fb.getAggregateFromServer(asFbQuery(source), fbSpec);
  return { data: () => snap.data() as { [K in keyof S]: number | null } };
}

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

/**
 * Walk a snapshot and tag every ref-shaped field in `refToTarget`,
 * AND normalize `.exists` to method form so consumer code targeting
 * Firebase's modular SDK (`if (snap.exists())`) works uniformly.
 *
 * The chainable adapter exposes `exists` as a property (Admin SDK
 * shape — `if (snap.exists)`). Firebase's modular SDK exposes it as
 * a method (`if (snap.exists())`). Without this normalization, user
 * code written against the documented Firebase API crashes against
 * the sandbox with "snap.exists is not a function" — a parity bug
 * agents and developers all rediscover by hand.
 *
 * Both forms remain readable on the returned object — the function
 * branch in any "did the existing FirestoreTab handle both shapes"
 * code still works.
 *
 * Idempotent — tagging an already-tagged object is a no-op, and the
 * `exists` getter we install is a no-op when one already exists.
 */
function tagSnapshotRefs(snap: unknown, target: Target): unknown {
  if (!snap || typeof snap !== 'object') return snap;
  const s = snap as {
    ref?: { id?: string; path?: string };
    docs?: Array<{ ref?: { id?: string; path?: string }; exists?: boolean | (() => boolean) }>;
    exists?: boolean | (() => boolean);
  };
  if (s.ref) {
    tag(s.ref as object, target);
    wireSnapshotRefToUnderlying(s.ref, target);
  }
  normalizeExists(s);
  if (Array.isArray(s.docs)) {
    for (const doc of s.docs) {
      if (doc?.ref) {
        tag(doc.ref as object, target);
        wireSnapshotRefToUnderlying(doc.ref, target);
      }
      if (doc) normalizeExists(doc);
    }
  }
  return snap;
}

/**
 * Snapshot `.ref` objects from the sandbox carry only `{ id, path }`
 * — no `.onSnapshot`, `.get`, `.set`, etc. — so a follow-up
 * `onSnapshot(snap.ref)` would crash with "ref.onSnapshot is not a
 * function." Bind the snapshot ref to a full chainable doc ref via
 * `refToUnderlying`; `underlyingOf(snap.ref)` then returns the real
 * ref the chainable adapter exposes its op methods on. No-op for
 * prod (their refs are already operative) and for refs that already
 * have a registered underlying.
 */
function wireSnapshotRefToUnderlying(
  snapRef: { path?: string },
  target: Target,
): void {
  if (!isSandboxKind(target)) return;
  if (typeof snapRef.path !== 'string' || snapRef.path.length === 0) return;
  if (refToUnderlying.has(snapRef as object)) return;
  const path = snapRef.path;
  try {
    // Build a concrete chainable doc to back the snap-ref via
    // `refToUnderlying`. For sandbox-live, also record a rebuild
    // closure so subsequent ops on the snap ref re-resolve against
    // the *current* `sandbox.currentUser` (rather than re-using the
    // listener-time auth that was frozen into the chainable).
    const full = sandboxDb(target).doc(path) as unknown as object;
    refToUnderlying.set(snapRef as object, full);
    if (target.kind === 'sandbox-live') {
      sandboxLiveRebuild.set(
        full,
        (fresh) => fresh.doc(path) as unknown as object,
      );
    }
  } catch {
    // path → doc resolution can throw if the path is malformed
    // (odd segment count, etc.). Best-effort — leave the snap ref
    // pointing at itself; the next op call will surface a clear
    // "ref.onSnapshot is not a function" instead of mangling state.
  }
}

/**
 * If `obj.exists` is a boolean property, replace it with a function
 * that returns that value — so consumer code can do `snap.exists()`
 * uniformly across the sandbox + Firebase backends. Idempotent: if
 * `exists` is already a function, leave it alone.
 *
 * `configurable: true` so a later normalize (over a re-yielded
 * snapshot from the same listener) can re-install cleanly.
 */
function normalizeExists(obj: {
  exists?: boolean | (() => boolean);
}): void {
  const current = obj.exists;
  if (typeof current === 'function') return;
  const value = current === true;
  try {
    Object.defineProperty(obj, 'exists', {
      value: () => value,
      writable: true,
      configurable: true,
      enumerable: true,
    });
  } catch {
    // Some snapshot impls might freeze the object. Best-effort —
    // a frozen snap already provides the property reading the user
    // can do `if (snap.exists)` against; the call-site failure is
    // surfaced via the error boundary.
  }
}

// ─── Transactions + batches ───────────────────────────────────────────

export async function runTransaction<R>(
  db: Firestore,
  fn: (tx: Transaction) => Promise<R> | R,
): Promise<R> {
  const target = targetOf(db);
  if (isSandboxKind(target)) {
    // For sandbox-live, the transaction (and every op inside the
    // callback) runs under the auth captured at `runTransaction`
    // start. Mutating `sandbox.currentUser` mid-transaction does
    // not retro-actively re-auth in-flight reads (matches
    // production: a transaction is identity-stable by design).
    return sandboxDb(target).runTransaction(fn as (tx: ChainTransaction) => Promise<R> | R);
  }
  return fb.runTransaction(target.db, fn as (tx: fb.Transaction) => Promise<R>);
}

export function writeBatch(db: Firestore): WriteBatch {
  const target = targetOf(db);
  if (isSandboxKind(target)) {
    // Each batch is constructed under a fresh chainable bound to
    // the current user. The batch holds that identity for every
    // op queued through it (matches transactions — once a batch is
    // opened, identity is frozen until `.commit()`).
    const batch = sandboxDb(target).batch();
    return tag(batch as unknown as object, target) as WriteBatch;
  }
  const batch = fb.writeBatch(target.db);
  return tag(batch as unknown as object, target) as WriteBatch;
}

// ─── Sandbox-only operations ──────────────────────────────────────────
//
// Grouped as a named-object export per the v4 plan. These have no
// `firebase/firestore` analog — keeping them under a `sandbox`
// namespace at the import site documents the sandbox-only
// constraint better than the runtime throw could. Calling them on
// a prod-target Firestore still throws `SandboxError` defensively.

/**
 * Sandbox lifecycle operations. Only meaningful against a
 * sandbox-target `Firestore` (built via `getFirestore(ctx)` with a
 * `SandboxContext`). Each function throws `SandboxError` when
 * handed a prod-target handle.
 *
 * **Naming note**: the `sandbox` export name conflicts with the
 * common local variable from `initializeSandbox()` (which also
 * returns a `Sandbox` typically held as `const sandbox = …`).
 * When both are in scope, alias the import:
 *
 * ```ts
 * import { sandbox as sandboxOps } from 'pyric/firestore';
 * import { initializeSandbox } from 'pyric/sandbox';
 *
 * const sandbox = initializeSandbox();      // local var
 * const db = getFirestore(sandbox.withAuth(…));
 * sandboxOps.setRules(db, RULES);            // SDK ops
 * ```
 *
 * The `sandbox` name was kept because it accurately describes the
 * surface (sandbox-only lifecycle). The renaming alternatives —
 * `sbx`, `firestoreSandbox`, `localOps` — all read worse than the
 * import-time alias.
 */
export const sandbox = {
  /** Load a rules source into the underlying `LocalEnvironment`. */
  setRules(db: Firestore, rules: string): LintResult {
    const target = targetOf(db);
    if (!isSandboxKind(target)) {
      throw new SandboxError(
        'failed-precondition',
        'sandbox.setRules is sandbox-only; use firestore.rules.deploy from pyric-tools/deploy for prod targets.',
      );
    }
    return sandboxDb(target).setRules(rules);
  },
  /** Bulk-load documents bypassing rules. */
  seedDocuments(
    db: Firestore,
    documents: Record<string, DocumentData>,
  ): LintResult {
    const target = targetOf(db);
    if (!isSandboxKind(target)) {
      throw new SandboxError(
        'failed-precondition',
        'sandbox.seedDocuments is sandbox-only; populate prod data via writes.',
      );
    }
    return sandboxDb(target).seed({ documents });
  },
  /** Dump every document the underlying `LocalEnvironment` has stored. */
  snapshotState(db: Firestore): Record<string, DocumentData> {
    const target = targetOf(db);
    if (!isSandboxKind(target)) {
      throw new SandboxError(
        'failed-precondition',
        'sandbox.snapshotState is sandbox-only.',
      );
    }
    return sandboxDb(target).snapshot();
  },
  /**
   * Single-call diagnostic an agent uses to answer "what state is the
   * sandbox in?" without grepping internal modules. Born out of
   * CLAUDE_DEBUG_SESSION.md: a real agent took 51 tool calls + 72k
   * tokens to figure out that the scaffold's rules weren't loaded.
   *
   * Returns: current rules source, lint summary, doc count by
   * collection, recent denials, recent requests. Stable JSON shape —
   * marshalled over MCP by `sandbox_inspect`.
   */
  inspect(db: Firestore, opts?: { recentEventLimit?: number }): SandboxInspect {
    const target = targetOf(db);
    if (!isSandboxKind(target)) {
      throw new SandboxError(
        'failed-precondition',
        'sandbox.inspect is sandbox-only.',
      );
    }
    return inspectSandbox(target.sandbox, opts?.recentEventLimit ?? 10);
  },
};

/**
 * Shape returned by {@link sandbox.inspect}. Stable JSON-serializable
 * surface — agents marshal this over MCP.
 */
export interface SandboxInspect {
  rules: {
    source: string;
    sizeBytes: number;
    isEmpty: boolean;
    lint: {
      errors: number;
      warnings: number;
      info: number;
      findings: Array<{ rule: string; severity: string; message: string }>;
    };
  };
  documents: {
    totalCount: number;
    byCollection: Record<string, number>;
  };
  events: {
    totalCount: number;
    recentDenials: Array<{ path: string; method: string; auth: unknown; debugMessage?: string }>;
    recentRequests: Array<{ path: string; method: string; result: string; auth: unknown }>;
  };
}

function inspectSandbox(sandbox: Sandbox, recentLimit: number): SandboxInspect {
  const env = getInternalEnv(sandbox);
  const rulesSource = env.getRules();
  const lint = rulesSource ? lintFirestoreRules(rulesSource) : { warnings: [] };
  const findings = lint.warnings.map((w) => ({
    rule: w.rule,
    severity: w.severity,
    message: w.message,
  }));
  const counts = { errors: 0, warnings: 0, info: 0 };
  for (const w of lint.warnings) {
    if (w.severity === 'error') counts.errors++;
    else if (w.severity === 'warning') counts.warnings++;
    else counts.info++;
  }

  const docs = env.snapshot();
  const byCollection: Record<string, number> = {};
  for (const path of Object.keys(docs)) {
    const top = path.split('/')[0] ?? '';
    if (!top) continue;
    byCollection[top] = (byCollection[top] ?? 0) + 1;
  }

  const history = sandbox.history() as unknown as Array<Record<string, unknown>>;
  const requests = history.filter((e) => e.kind === 'request');
  const denials = requests.filter((e) => e.result === 'deny');
  const recentRequests = requests.slice(-recentLimit).map((e) => ({
    path: String(e.path ?? ''),
    method: String(e.method ?? ''),
    result: String(e.result ?? ''),
    auth: e.auth ?? null,
  }));
  const recentDenials = denials.slice(-recentLimit).map((e) => ({
    path: String(e.path ?? ''),
    method: String(e.method ?? ''),
    auth: e.auth ?? null,
    debugMessage: typeof e.debugMessage === 'string' ? e.debugMessage : undefined,
  }));

  return {
    rules: {
      source: rulesSource,
      sizeBytes: new TextEncoder().encode(rulesSource).byteLength,
      isEmpty: rulesSource.trim().length === 0,
      lint: { ...counts, findings },
    },
    documents: {
      totalCount: Object.keys(docs).length,
      byCollection,
    },
    events: {
      totalCount: history.length,
      recentDenials,
      recentRequests,
    },
  };
}

// ─── Sentinels + scalar types ─────────────────────────────────────────
//
// Sentinels in pyric ride on `pyric-admin`'s sentinel objects, which
// are structurally identical to `firebase/firestore`'s — the simulator
// recognizes them by `__type` discriminator, and so does production
// Firestore (their wire format normalizes through the same path). One
// `FieldValue.increment(1)` works in both targets.
//
// `Timestamp` is similar — admin-shape `{seconds, nanoseconds}` matches
// the modular SDK's `Timestamp` shape.

export { ChainFieldValue as FieldValue, ChainTimestamp as Timestamp };

export function serverTimestamp(): FieldValueSentinel {
  return ChainFieldValue.serverTimestamp();
}
export function increment(n: number): FieldValueSentinel {
  return ChainFieldValue.increment(n);
}
export function arrayUnion(...values: unknown[]): FieldValueSentinel {
  return ChainFieldValue.arrayUnion(...values);
}
export function arrayRemove(...values: unknown[]): FieldValueSentinel {
  return ChainFieldValue.arrayRemove(...values);
}
export function deleteField(): FieldValueSentinel {
  return ChainFieldValue.delete();
}

// ─── Tool factories (Slice 10) ────────────────────────────────────────
export { createFirestoreDataTools, createFirestoreInspectTools } from './tools.js';
export type { FirestoreDataToolDeps, UserAuth, As } from './tools.js';
