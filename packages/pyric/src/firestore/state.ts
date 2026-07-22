/**
 * `pyric/firestore` — shared routing + branding state.
 *
 * The sandbox routing machinery every family module depends on: the
 * {@link TARGET_SYMBOL} brand, the ref→target / converter / underlying
 * WeakMaps, the tag / resolve helpers, and the sandbox read-path value
 * finalizers. Hoisted out of the former single-file entry first (see the
 * barrel `index.ts`) so the per-family moves that follow are clean.
 *
 * Only {@link TARGET_SYMBOL} is part of the published `pyric/firestore`
 * surface (re-exported by the barrel). Every other export here is
 * package-internal: it is imported by the family modules but never
 * re-exported by the barrel, so it stays off the public subpath.
 */

import {
  type SandboxFirestore,
  type DocumentReference as ChainDocRef,
  type CollectionReference as ChainCollRef,
  type Query as ChainQuery,
  type DocumentData,
} from 'pyric/sandbox/admin-firestore';
import type { Sandbox } from 'pyric/sandbox';
import {
  Bytes as RulesBytes,
  LatLng as RulesLatLng,
  Vector as RulesVector,
} from 'pyric/rules/internal';
import type { FirestoreDataConverter } from './types.js';
import { Bytes, GeoPoint, vector } from './field-values.js';

// ─── Branding + routing ───────────────────────────────────────────────

/**
 * Hidden property on every {@link Firestore} handle. Discriminates
 * the sandbox backend so free functions can recover their owner.
 */
export const TARGET_SYMBOL: unique symbol = Symbol('pyric/firestore/target');

export type SandboxTarget = { kind: 'sandbox'; db: SandboxFirestore; sandbox: Sandbox };
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
export type SandboxLiveTarget = {
  kind: 'sandbox-live';
  sandbox: Sandbox;
  getDb: () => SandboxFirestore;
  authScope?: object;
  own?: (cleanup: () => void) => () => void;
  assertUsable?: () => void;
};
export type Target = SandboxTarget | SandboxLiveTarget;

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
export function sandboxDb(target: SandboxTarget | SandboxLiveTarget): SandboxFirestore {
  return target.kind === 'sandbox' ? target.db : target.getDb();
}

/**
 * Map from refs / queries to their owning target. Populated by every
 * factory + chaining operation; consulted by every free function.
 *
 * WeakMap keys let entries GC alongside the refs that produced them.
 */
export const refToTarget = new WeakMap<object, Target>();

export function tag<T extends object>(obj: T, target: Target): T {
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
 * sandbox-live refs; frozen `sandbox` refs keep held-ref semantics.
 */
export const sandboxLiveRebuild = new WeakMap<object, (db: SandboxFirestore) => object>();

export function tagLive<T extends object>(
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
export function chainDocFor(
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
export function chainCollFor(
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
export function chainQueryFor(
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
export function tagSandboxRef<T extends object>(
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
export function parentRebuild(parent: object): (db: SandboxFirestore) => object {
  const underlying = underlyingOf(parent);
  const fn = sandboxLiveRebuild.get(underlying);
  if (fn) return fn;
  // Frozen-ctx target. The chainable parent ref is bound to the same
  // ctx for life; returning it as-is is correct because frozen-ctx
  // chaining is what `pyric-admin`'s adapter already supports.
  return () => underlying;
}

export function targetOf(refOrDb: object): Target {
  let target: Target | undefined;
  if (TARGET_SYMBOL in refOrDb) {
    target = (refOrDb as { [TARGET_SYMBOL]: Target })[TARGET_SYMBOL];
  } else {
    target = refToTarget.get(refOrDb);
  }
  if (!target) {
    throw new TypeError(
      'pyric/firestore: unrecognized reference — was it produced by a factory in this package?',
    );
  }
  if (target.kind === 'sandbox-live') target.assertUsable?.();
  return target;
}

export const refToConverter = new WeakMap<object, FirestoreDataConverter<unknown> | null>();
export const refToUnderlying = new WeakMap<object, object>();

export function converterOf(obj: object): FirestoreDataConverter<unknown> | null | undefined {
  return refToConverter.get(obj);
}

/** Resolve to the plain chain / fb ref. `withConverter` shells point
 *  at the underlying; everything else is its own underlying. */
export function underlyingOf<T extends object>(obj: T): object {
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
export function buildSandboxShell(
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

// Shorthand: cast helpers used inside route arms. The runtime objects
// match these shapes precisely; the casts let the routing keep its
// single-typed public surface.
export function asChainDoc(r: object): ChainDocRef { return r as ChainDocRef; }
export function asChainColl(r: object): ChainCollRef { return r as ChainCollRef; }
export function asChainQuery(r: object): ChainQuery { return r as ChainQuery; }

/** Return components only from the trusted internal Vector wrapper. Plain
 * maps may legitimately use `typeName`/`value` or `__type__`/`value`; treating
 * those shapes as vectors erases Firestore's map-versus-vector distinction. */
export function vectorValuesOf(value: unknown): number[] | null {
  if (value instanceof RulesVector) return Array.from(value.value);
  return null;
}

/**
 * Final read-path translation for sandbox-target snapshots.
 *
 * The admin-compat read-path walker (in `pyric/sandbox`'s admin-compat
 * `snapshots.ts`) leaves `pyric/rules` wrappers (`Bytes`,
 * `LatLng`) as identity. The modular mirror owns the final conversion to
 * its public scalar classes.
 *
 * Walk the value tree and convert recognized rules wrappers into the
 * corresponding local modular value class so `instanceof` survives a
 * sandbox round trip.
 *
 * Closes firestore COMPAT rows #109 (`Bytes`) and #110 (`GeoPoint`).
 * Vectors (#111, `VectorValue` / `vector()`) round-trip the same way as of
 * Phase 0-F; the formal COMPAT ✓ + oracle observation land with the
 * conformance phase (Phase 5b). Vector SEARCH (`findNearest`) is separate.
 */
export function finalizeSandboxValue(value: unknown): unknown {
  if (value instanceof RulesBytes) {
    return Bytes.fromUint8Array(value.data);
  }
  if (value instanceof RulesLatLng) {
    return new GeoPoint(value.lat, value.lng);
  }
  const vectorValues = vectorValuesOf(value);
  if (vectorValues) {
    return vector(vectorValues);
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

export function finalizeSandboxData(data: DocumentData | undefined): DocumentData | undefined {
  if (data === undefined) return undefined;
  return finalizeSandboxValue(data) as DocumentData;
}
