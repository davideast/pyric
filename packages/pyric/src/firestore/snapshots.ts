/**
 * `pyric/firestore` — shared sandbox snapshot rehydration.
 *
 * The read-path snapshot helpers used by BOTH `reads` (`getDoc` /
 * `getDocs`) and `listeners` (`onSnapshot`): value finalization wrappers,
 * ref tagging, and the `.exists` property→method normalization that makes
 * sandbox snapshots match Firebase's modular-SDK shape.
 *
 * Package-internal — the barrel re-exports none of these; the public
 * snapshot TYPES live in `types.ts`.
 */

import type { AdminDocumentSnapshot as ChainDocSnap, DocumentData } from 'pyric/sandbox/admin-firestore';

import {
  tag,
  sandboxDb,
  sandboxLiveRebuild,
  refToUnderlying,
  finalizeSandboxData,
  type Target,
} from './state.js';
import type {
  DocumentSnapshot,
  QueryDocumentSnapshot,
  FirestoreDataConverter,
} from './types.js';

/**
 * Wrap a raw sandbox `DocumentSnapshot` so `.data()` runs the final
 * value translation (rules wrappers → `firebase/firestore` types).
 * Other surface (id / ref / exists) passes through unchanged so
 * `tagSnapshotRefs` still operates on the original snap object.
 */
export function wrapSandboxDocSnap<T>(snap: object): DocumentSnapshot<T> {
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
export function applyConverterToDocSnap<AppModel>(
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
export function tagSnapshotRefs(snap: unknown, target: Target): unknown {
  if (!snap || typeof snap !== 'object') return snap;
  // Equality helpers receive the snapshot object itself, not only its refs.
  // Brand the snapshot with the same owner so `snapshotEqual` can validate
  // sandbox snapshots without mistaking them for foreign SDK values.
  tag(snap, target);
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
 * ref the chainable adapter exposes its op methods on. No-op for refs that
 * already have a registered underlying.
 */
export function wireSnapshotRefToUnderlying(
  snapRef: { path?: string },
  target: Target,
): void {
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
export function normalizeExists(obj: {
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
