/**
 * `pyric/firestore` — target-aware equality helpers.
 *
 * `refEqual` / `queryEqual` / `snapshotEqual`: structural equality that
 * routes to `firebase/firestore`'s native comparators for prod handles and
 * to path/identity comparison for sandbox handles.
 */
import * as fb from 'firebase/firestore';

import {
  targetOf,
  isSandboxKind,
  underlyingOf,
  asFbDoc,
  asFbQuery,
  type Target,
} from './state.js';
import type {
  DocumentReference,
  Query,
  DocumentSnapshot,
  QuerySnapshot,
} from './types.js';

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
