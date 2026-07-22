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
  converterOf,
  underlyingOf,
  type Target,
} from './state.js';
import { firestoreValuesEqual } from './sandbox/value-equality.js';
import { registerReferenceQueryValue } from './sandbox/query-value-registry.js';
import {
  captureQueryOperand,
  capturedQueryOperandsEqual,
  type CapturedQueryOperand,
} from './sandbox/query-operand-equality.js';
import type {
  DocumentSnapshot,
  QueryDocumentSnapshot,
  FirestoreDataConverter,
} from './types.js';

interface DocumentSnapshotEqualityState {
  readonly target: Target;
  readonly path: string;
  readonly kind: 'document' | 'query-child';
  readonly converter: FirestoreDataConverter<unknown> | null;
  readonly raw: ChainDocSnap;
}

const documentSnapshotEquality = new WeakMap<object, DocumentSnapshotEqualityState>();

interface QuerySnapshotDocEqualityState {
  readonly path: string;
  readonly data: CapturedQueryOperand;
}

interface QuerySnapshotChangeEqualityState extends QuerySnapshotDocEqualityState {
  readonly type: string;
  readonly oldIndex: number;
  readonly newIndex: number;
}

interface QuerySnapshotEqualityState {
  readonly target: Target;
  readonly query: object;
  readonly converter: FirestoreDataConverter<unknown> | null;
  readonly source: 'read' | 'listener';
  readonly readIdentity?: object;
  readonly metadata: { readonly fromCache: boolean; readonly hasPendingWrites: boolean };
  readonly docs: readonly QuerySnapshotDocEqualityState[];
  readonly changes: readonly QuerySnapshotChangeEqualityState[];
}

const querySnapshotEquality = new WeakMap<object, QuerySnapshotEqualityState>();

function recordDocumentSnapshot(
  snapshot: object,
  raw: ChainDocSnap,
  target: Target,
  converter: FirestoreDataConverter<unknown> | null,
  kind: 'document' | 'query-child',
): void {
  documentSnapshotEquality.set(snapshot, {
    target,
    path: raw.ref.path,
    kind,
    converter,
    raw,
  });
}

function snapshotExists(snapshot: ChainDocSnap): boolean {
  return typeof snapshot.exists === 'function'
    ? (snapshot.exists as () => boolean)()
    : snapshot.exists === true;
}

/** Compare tagged snapshots without invoking consumer converters. */
export function taggedSnapshotsEqual(left: object, right: object): boolean {
  if (left === right) return true;
  const a = documentSnapshotEquality.get(left);
  const b = documentSnapshotEquality.get(right);
  if (!a || !b) return querySnapshotsEqual(left, right);
  if (a.target !== b.target
    || a.path !== b.path
    || a.kind !== b.kind
    || a.converter !== b.converter) return false;
  const aExists = snapshotExists(a.raw);
  const bExists = snapshotExists(b.raw);
  if (aExists !== bExists) return false;
  if (!aExists) return true;
  return firestoreValuesEqual(a.raw.data(), b.raw.data());
}

function querySnapshotsEqual(left: object, right: object): boolean {
  const a = querySnapshotEquality.get(left);
  const b = querySnapshotEquality.get(right);
  if (!a || !b || a.target !== b.target || a.converter !== b.converter) return false;
  // Separate one-shot reads carry distinct internal view snapshots in
  // Firebase even when their documents match. Listener deliveries, however,
  // are compared structurally.
  if (a.source !== b.source) return false;
  if (a.source === 'read') return a.readIdentity === b.readIdentity;
  const leftQuery = underlyingOf(a.query) as { isStructurallyEqual?: (other: unknown) => boolean };
  const rightQuery = underlyingOf(b.query);
  if (!(leftQuery.isStructurallyEqual?.(rightQuery) ?? leftQuery === rightQuery)) return false;
  if (a.metadata.fromCache !== b.metadata.fromCache
    || a.metadata.hasPendingWrites !== b.metadata.hasPendingWrites) return false;
  if (!querySnapshotDocsEqual(a.docs, b.docs) || a.changes.length !== b.changes.length) return false;
  return a.changes.every((change, index) => {
    const other = b.changes[index]!;
    return change.type === other.type
      && change.oldIndex === other.oldIndex
      && change.newIndex === other.newIndex
      && change.path === other.path
      && capturedQueryOperandsEqual(change.data, other.data);
  });
}

function querySnapshotDocsEqual(
  left: readonly QuerySnapshotDocEqualityState[],
  right: readonly QuerySnapshotDocEqualityState[],
): boolean {
  return left.length === right.length && left.every((doc, index) => {
    const other = right[index]!;
    return doc.path === other.path && capturedQueryOperandsEqual(doc.data, other.data);
  });
}

/** Record the immutable equality state Firebase associates with a query
 * snapshot. `rawSnapshot` keeps converter callbacks out of equality. */
export function recordQuerySnapshot(
  snapshot: object,
  rawSnapshot: object,
  target: Target,
  query: object,
  source: 'read' | 'listener',
): void {
  const raw = rawSnapshot as {
    docs?: Array<{ ref?: { path?: string }; data?: () => unknown }>;
    metadata?: { fromCache?: boolean; hasPendingWrites?: boolean };
    docChanges?: () => Array<{
      type?: string;
      oldIndex?: number;
      newIndex?: number;
      doc?: { ref?: { path?: string }; data?: () => unknown };
    }>;
  };
  const captureDoc = (doc: { ref?: { path?: string }; data?: () => unknown }) => ({
    path: doc.ref?.path ?? '',
    data: captureQueryOperand(doc.data?.(), target),
  });
  const docs = Object.freeze((raw.docs ?? []).map(captureDoc));
  const changes = Object.freeze((raw.docChanges?.() ?? []).map((change) => ({
    ...captureDoc(change.doc ?? {}),
    type: change.type ?? '',
    oldIndex: change.oldIndex ?? -1,
    newIndex: change.newIndex ?? -1,
  })));
  querySnapshotEquality.set(snapshot, {
    target,
    query,
    converter: converterOf(query) ?? null,
    source,
    ...(source === 'read' ? { readIdentity: {} } : {}),
    metadata: Object.freeze({
      fromCache: raw.metadata?.fromCache === true,
      hasPendingWrites: raw.metadata?.hasPendingWrites === true,
    }),
    docs,
    changes,
  });
}

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
  target: Target,
  kind: 'document' | 'query-child',
): DocumentSnapshot<AppModel> {
  const wrapped = {
    id: snap.id,
    ref: snap.ref,
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
  tag(wrapped, target);
  tag(snap.ref as object, target);
  wireSnapshotRefToUnderlying(snap.ref, target);
  recordDocumentSnapshot(
    wrapped,
    snap,
    target,
    conv as FirestoreDataConverter<unknown>,
    kind,
  );
  return wrapped;
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
      if (doc) {
        tag(doc as object, target);
        recordDocumentSnapshot(
          doc as object,
          doc as unknown as ChainDocSnap,
          target,
          null,
          'query-child',
        );
      }
      if (doc?.ref) {
        tag(doc.ref as object, target);
        wireSnapshotRefToUnderlying(doc.ref, target);
      }
      if (doc) normalizeExists(doc);
    }
  } else if (s.ref) {
    recordDocumentSnapshot(snap, snap as unknown as ChainDocSnap, target, null, 'document');
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
  const path = snapRef.path;
  try {
    // Build a concrete chainable doc to back the snap-ref via
    // `refToUnderlying`. For sandbox-live, also record a rebuild
    // closure so subsequent ops on the snap ref re-resolve against
    // the *current* `sandbox.currentUser` (rather than re-using the
    // listener-time auth that was frozen into the chainable).
    const existing = refToUnderlying.get(snapRef as object);
    const full = existing ?? sandboxDb(target).doc(path) as unknown as object;
    if (existing === undefined) refToUnderlying.set(snapRef as object, full);
    registerReferenceQueryValue(snapRef as object, path, target, full);
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
