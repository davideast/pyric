/**
 * Translate compat-layer errors (`FirestoreCompatError`) into the
 * sandbox layer's unified `SandboxError`, attaching whatever structured
 * `denialContext` is recoverable from the underlying simulator output.
 *
 * Why a translation layer at all:
 *
 *   The compat impl throws `FirestoreCompatError` because it has to
 *   look like an Admin SDK `FirestoreError` for the production-shaped
 *   surface to feel right. The sandbox layer wants one error class
 *   (`SandboxError`) covering every service so callers can write
 *   `if (err instanceof SandboxError && err.code === 'permission-
 *   denied') { ... }` regardless of which service produced the throw.
 *
 *   The translation also stitches sandbox-known context (the active
 *   auth identity, sourced from `SandboxContext`) and best-effort
 *   recovered context (the underlying `debugMessages`, recovered from
 *   the error's stitched-together message) into `denialContext`.
 *
 * `denialContext.rule` (line + expression) is left undefined: the
 * rules AST does not currently carry source positions, so neither line
 * numbers nor the original expression string are reliably available
 * after evaluation.
 *
 * The recursive `wrapWithErrorTranslation` Proxy applies translation
 * uniformly across the Firestore handle and every object returned from
 * its methods (DocumentRef, Query, WriteBatch, Transaction). It also
 * stashes the owning {@link SandboxContext} on every wrapped value via
 * the {@link CONTEXT_SYMBOL} hidden property — `onSnapshot` reads it
 * back to capture the right auth at listener registration.
 */

import { FirestoreCompatError } from 'pyric/sandbox/admin-compat';
import type { SandboxContext } from 'pyric/sandbox';
import {
  SandboxError,
  type DenialContext,
  type SandboxErrorCode,
} from 'pyric/sandbox';
import { provenanceForOperationContext } from 'pyric/sandbox/internal';

/**
 * Hidden property on every wrapped object that returns the
 * `SandboxContext` that produced it. Used by `onSnapshot` to recover
 * the right auth from a ref produced via `db.doc(path)` /
 * `db.collection(path)` regardless of how many contexts share the
 * underlying sandbox. Symbol so it never collides with a real property.
 */
export const CONTEXT_SYMBOL: unique symbol = Symbol('pyric/sandbox/context');

/** Hidden property carried by wrapped local admin handles and every ref/query
 * they produce. Snapshot listeners read it back so the rules-bypass contract
 * survives registration and every later listener re-evaluation. */
export const BYPASS_RULES_SYMBOL: unique symbol = Symbol('pyric/sandbox/bypassRules');

/**
 * Late-bound reference to the free `onSnapshot(ref, ...args)` function
 * from `index.ts`. Synthesized into wrapped refs as a `.onSnapshot(...)`
 * chainable method (see {@link wrapWithErrorTranslation}).
 *
 * Why late binding: the Proxy wrapper here is consumed from `index.ts`,
 * and that's where the free `onSnapshot` is defined. Statically
 * importing it back would create a circular module init order. The
 * registration call lives at the bottom of `index.ts`, after
 * `onSnapshot` is fully declared.
 */
type OnSnapshotImpl = (ref: unknown, ...args: unknown[]) => () => void;
let onSnapshotImpl: OnSnapshotImpl | null = null;

/**
 * Register the free `onSnapshot` function so wrapped refs can synthesize
 * a chainable `.onSnapshot(...)` method that delegates to it. Called
 * once at module init from `index.ts`.
 */
export function registerOnSnapshotImpl(fn: OnSnapshotImpl): void {
  onSnapshotImpl = fn;
}

/**
 * Heuristic: the wrapped object is a Firestore ref
 * (DocumentReference, CollectionReference, or chained Query). Used
 * to gate the synthesized `.onSnapshot` shim so the method only
 * appears on values where a chainable `.onSnapshot` actually makes
 * sense.
 *
 * - `DocumentReference` exposes `path` publicly.
 * - `CollectionReference` exposes `path` publicly.
 * - Chained `Query` (the result of `.where()/.orderBy()/.limit()`)
 *   keeps `collectionPath` as a TypeScript-protected field on the
 *   underlying `QueryImpl`. Protected is a TS-only restriction; at
 *   runtime the field is readable, so the lookup matches.
 *
 * Snapshots, batches, transactions, and the Firestore handle itself
 * carry neither, so the shim correctly skips them.
 */
function isRefLike(obj: object): boolean {
  const o = obj as { path?: unknown; collectionPath?: unknown };
  return (typeof o.path === 'string' && o.path.length > 0)
      || (typeof o.collectionPath === 'string' && o.collectionPath.length > 0);
}

/**
 * Pull a list of denial reasons out of a compat-error message. Two
 * formats produced by the underlying SDK are handled:
 *
 *   1. Stitched-multi  — `"get denied: Rule #0 → deny; Simulated: DENY"`.
 *      Produced by the `throwFromDenial` fallback path when the
 *      simulator didn't attach a typed `error` (rare today; reserved
 *      for future use). Split after the first `": "` and on `"; "`.
 *
 *   2. Plain typed     — `"get tickets/T-1 denied by rules"`. Produced
 *      when the simulator returns a typed `error` (`makeError(...)`).
 *      No structured sub-reasons; surface the whole message as a
 *      single-element list so callers get something machine-readable.
 *
 * The list is never empty for a non-empty error message, so callers
 * don't need to special-case "no reasons available."
 */
function recoverReasons(message: string): string[] {
  const trimmed = message.trim();
  if (!trimmed) return [];
  const firstColon = trimmed.indexOf(': ');
  if (firstColon !== -1) {
    const tail = trimmed.slice(firstColon + 2).trim();
    const parts = tail.split('; ').map(s => s.trim()).filter(s => s.length > 0);
    if (parts.length > 0) return parts;
  }
  return [trimmed];
}

/**
 * Convert a compat error into a `SandboxError` with attached
 * `denialContext`. Non-compat errors fall through unchanged so callers
 * still see (e.g.) a TypeError thrown from user code.
 */
export function toSandboxError(err: unknown, ctx: SandboxContext): unknown {
  if (!(err instanceof FirestoreCompatError)) return err;

  const code = err.code as SandboxErrorCode;
  if (code !== 'permission-denied') {
    return new SandboxError(code, err.message);
  }

  const denialContext: DenialContext = {
    auth: ctx.auth,
    reasons: recoverReasons(err.message),
  };
  const sim = err.simError;
  if (sim?.request) {
    const r = sim.request;
    denialContext.request = {
      method: r.method,
      path: r.path,
      ...(r.resourceData ? { resourceData: r.resourceData } : {}),
    };
  }
  if (sim?.resource) {
    denialContext.resource = { data: sim.resource.data, exists: sim.resource.exists };
  }
  return new SandboxError(code, err.message, denialContext);
}

/**
 * Wrap an object so that every function call on it (and on its
 * function-call returns) gets `try/catch` and `Promise.catch`
 * translation through {@link toSandboxError}.
 *
 * Property reads that aren't functions pass through. Function returns
 * that aren't objects pass through. Object returns are recursively
 * wrapped — this is what makes `db.doc('x').get()` translate even
 * though the wrapper only directly intercepts `db`'s own methods.
 *
 * Method-chaining identity (`b.set(x).update(y)`) is preserved through
 * a per-call fresh proxy: each chain step returns a wrapped view of
 * the underlying impl's `this`, which has the same delegate behavior.
 *
 * Every wrapped object also exposes `[CONTEXT_SYMBOL]` returning the
 * owning {@link SandboxContext}; `onSnapshot` reads this to recover
 * the right auth at registration regardless of how many contexts
 * share the underlying sandbox.
 */
export function wrapWithErrorTranslation<T extends object>(
  target: T,
  ctx: SandboxContext,
  bypassRules = false,
): T {
  return new Proxy(target, {
    get(t, prop, receiver) {
      // Hidden context recovery — must come before any other property
      // resolution. Symbol-keyed so it can't collide with real props.
      if (prop === CONTEXT_SYMBOL) return ctx;
      if (prop === BYPASS_RULES_SYMBOL) return bypassRules;

      // Synthesize a chainable `.onSnapshot(...)` method on every
      // ref-shaped wrapped value. The underlying compat ref doesn't
      // define this method (the package's canonical surface is the
      // free `onSnapshot(ref, ...)` function); the shim is here so
      // `db.collection(path).where(...).onSnapshot(cb)` style chains
      // work too. Both forms route through the same listener.
      //
      // Gate: only when (a) the impl is registered, (b) the underlying
      // doesn't already define `onSnapshot`, and (c) the underlying is
      // ref-like — so we don't accidentally attach the method to
      // snapshots, batches, transactions, the Firestore handle, etc.
      if (
        prop === 'onSnapshot' &&
        onSnapshotImpl !== null &&
        !(prop in t) &&
        isRefLike(t)
      ) {
        // Pass `receiver` (the Proxy) rather than `t` so the free
        // `onSnapshot` reads CONTEXT_SYMBOL through the wrapper.
        return (...args: unknown[]) => onSnapshotImpl!(receiver, ...args);
      }

      const value = Reflect.get(t, prop, receiver);
      if (typeof value !== 'function') return value;

      // Bind to the original `t` so internal `this` references inside
      // the delegate stay coherent.
      return function (this: unknown, ...args: unknown[]): unknown {
        let result: unknown;
        try {
          const invoke = () => (value as (...a: unknown[]) => unknown).apply(t, args);
          result = ctx.sandbox.runWithProvenance?.(
            provenanceForOperationContext(ctx.operationContext),
            invoke,
          ) ?? invoke();
        } catch (e) {
          throw toSandboxError(e, ctx);
        }
        if (result instanceof Promise) {
          return result
            .then((v) => (v && typeof v === 'object'
              ? wrapWithErrorTranslation(v as object, ctx, bypassRules)
              : v))
            .catch((e) => { throw toSandboxError(e, ctx); });
        }
        if (result && typeof result === 'object') {
          return wrapWithErrorTranslation(result as object, ctx, bypassRules);
        }
        return result;
      };
    },
  });
}
