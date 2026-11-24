/**
 * `pyric/firestore` -- shared sandbox snapshot rehydration.
 *
 * Read-path snapshot helpers used by `reads` (`getDoc` / `getDocs`),
 * `listeners` (`onSnapshot`), and `ssr-snapshots`: value finalization wrappers,
 * ref tagging, `.exists` property-to-method normalization, and equality state.
 */

import type { AdminDocumentSnapshot as ChainDocSnap, DocumentData, SnapshotFieldPath } from 'pyric/sandbox/admin-firestore';
import { FirebaseError } from 'pyric/app';
import { getSnapshotField } from './sandbox/admin-compat/field-path.js';
import {
  tag,
  TARGET_SYMBOL,
  sandboxDb,
  sandboxLiveRebuild,
  refToUnderlying,
  finalizeSandboxData,
  finalizeSandboxValue,
  converterOf,
  underlyingOf,
  type Target,
} from './state.js';
import { doc } from './refs.js';
import { decorateUntypedSnapshotRef } from './converter-method.js';
import {
  attachDocSnapshotToJson,
  attachQuerySnapshotToJson,
  buildDocSnapshotToJson,
  type SnapshotOptions,
} from './ssr-snapshots.js';
import type { ReferenceDecoder } from './internal/value-codec.js';
import { firestoreValuesEqual } from './sandbox/value-equality.js';
import { registerReferenceQueryValue } from './sandbox/query-value-registry.js';
import { clientStateFor } from './client-state.js';
import { createSnapshotMetadata, type SnapshotMetadataInstance } from './snapshot-metadata.js';
import {
  captureQueryOperand,
  capturedQueryOperandsEqual,
  type CapturedQueryOperand,
} from './sandbox/query-operand-equality.js';
import type { DocumentSnapshot, QueryDocumentSnapshot, FirestoreDataConverter } from './types.js';

interface DocumentSnapshotEqualityState {
  readonly target: Target;
  readonly path: string;
  readonly kind: 'document' | 'query-child';
  readonly converter: FirestoreDataConverter<unknown> | null;
  readonly raw: ChainDocSnap;
}

const documentSnapshotEquality = new WeakMap<object, DocumentSnapshotEqualityState>();
const wireSnapshotDataReaders = new WeakMap<object, (options?: SnapshotOptions) => DocumentData | undefined>();

export function readWireSnapshotData(
  snap: { data(options?: SnapshotOptions): DocumentData | undefined },
  options?: SnapshotOptions,
): DocumentData | undefined {
  const reader = wireSnapshotDataReaders.get(snap);
  if (reader !== undefined) return reader(options);
  return snap.data(options);
}

/** Return the converter-free snapshot state captured at read time. */
export function rawDocumentSnapshotForCursor(snapshot: object): ChainDocSnap {
  const recorded = documentSnapshotEquality.get(snapshot);
  if (recorded !== undefined) return recorded.raw;
  return snapshot as unknown as ChainDocSnap;
}

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
  readonly readPhase?: 'initial' | 'settled';
  readonly metadata: { readonly fromCache: boolean; readonly hasPendingWrites: boolean };
  readonly docs: readonly QuerySnapshotDocEqualityState[];
  readonly changes: readonly QuerySnapshotChangeEqualityState[];
}

const querySnapshotEquality = new WeakMap<object, QuerySnapshotEqualityState>();
interface ReadQueryState {
  readonly query: WeakRef<object>;
  docs: readonly QuerySnapshotDocEqualityState[];
  metadata: { readonly fromCache: boolean; readonly hasPendingWrites: boolean };
}
const readQueriesByTarget = new WeakMap<object, ReadQueryState[]>();

function recordDocumentSnapshot(
  snapshot: object,
  raw: ChainDocSnap,
  target: Target,
  converter: FirestoreDataConverter<unknown> | null,
  kind: 'document' | 'query-child',
): void {
  documentSnapshotEquality.set(snapshot, { target, path: raw.ref.path, kind, converter, raw });
}

function snapshotExists(snapshot: ChainDocSnap): boolean {
  if (typeof snapshot.exists === 'function') {
    return (snapshot.exists as () => boolean)();
  }
  return snapshot.exists === true;
}

/** Compare tagged snapshots without invoking consumer converters. */
export function taggedSnapshotsEqual(left: object, right: object): boolean {
  if (left === right) return true;
  const a = documentSnapshotEquality.get(left);
  const b = documentSnapshotEquality.get(right);
  if (!a || !b) return querySnapshotsEqual(left, right);
  if (a.target !== b.target || a.path !== b.path || a.kind !== b.kind || a.converter !== b.converter) {
    return false;
  }
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
  if (a.source !== b.source) return false;
  if (!queryObjectsEqual(a.query, b.query)) return false;
  if (a.source === 'read' && a.readPhase !== b.readPhase) return false;
  if (a.metadata.fromCache !== b.metadata.fromCache || a.metadata.hasPendingWrites !== b.metadata.hasPendingWrites) {
    return false;
  }
  if (!querySnapshotDocsEqual(a.docs, b.docs) || a.changes.length !== b.changes.length) return false;
  return a.changes.every((change, index) => {
    const other = b.changes[index];
    if (other === undefined) return false;
    return (
      change.type === other.type &&
      change.oldIndex === other.oldIndex &&
      change.newIndex === other.newIndex &&
      change.path === other.path &&
      capturedQueryOperandsEqual(change.data, other.data)
    );
  });
}

function queryObjectsEqual(left: object, right: object): boolean {
  const leftQuery = underlyingOf(left) as { isStructurallyEqual?: (other: unknown) => boolean };
  const rightQuery = underlyingOf(right);
  if (typeof leftQuery.isStructurallyEqual === 'function') {
    return leftQuery.isStructurallyEqual(rightQuery);
  }
  return leftQuery === rightQuery;
}

function readPhase(
  target: Target,
  query: object,
  docs: readonly QuerySnapshotDocEqualityState[],
  metadata: { readonly fromCache: boolean; readonly hasPendingWrites: boolean },
): 'initial' | 'settled' {
  const targetKey = target as object;
  const seen = (readQueriesByTarget.get(targetKey) ?? []).filter((c) => c.query.deref() !== undefined);
  const state = seen.find((c) => {
    const q = c.query.deref();
    return q !== undefined && queryObjectsEqual(q, query);
  });
  if (state !== undefined) {
    const same =
      querySnapshotDocsEqual(state.docs, docs) &&
      state.metadata.fromCache === metadata.fromCache &&
      state.metadata.hasPendingWrites === metadata.hasPendingWrites;
    state.docs = docs;
    state.metadata = metadata;
    if (same) return 'settled';
    return 'initial';
  }
  seen.push({ query: new WeakRef(query), docs, metadata });
  readQueriesByTarget.set(targetKey, seen);
  return 'initial';
}

function querySnapshotDocsEqual(
  left: readonly QuerySnapshotDocEqualityState[],
  right: readonly QuerySnapshotDocEqualityState[],
): boolean {
  return (
    left.length === right.length &&
    left.every((docItem, index) => {
      const other = right[index];
      if (other === undefined) return false;
      return docItem.path === other.path && capturedQueryOperandsEqual(docItem.data, other.data);
    })
  );
}

/** Record the immutable equality state Firebase associates with a query snapshot. */
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
  const captureDoc = (docItem: { ref?: { path?: string }; data?: () => unknown }) => {
    const rawDoc = rawDocumentSnapshotForCursor(docItem as object);
    let rawPath = '';
    if (typeof rawDoc.ref?.path === 'string') rawPath = rawDoc.ref.path;
    else if (typeof docItem.ref?.path === 'string') rawPath = docItem.ref.path;
    let rawValue = docItem.data?.();
    if (typeof rawDoc.data === 'function') rawValue = rawDoc.data();
    return { path: rawPath, data: captureQueryOperand(finalizeSandboxValue(rawValue)) };
  };
  const docs = Object.freeze((raw.docs ?? []).map(captureDoc));
  const changes = Object.freeze(
    (raw.docChanges?.() ?? []).map((change) => ({
      ...captureDoc(change.doc ?? {}),
      type: change.type ?? '',
      oldIndex: change.oldIndex ?? -1,
      newIndex: change.newIndex ?? -1,
    })),
  );
  const metadata = Object.freeze({
    fromCache: raw.metadata?.fromCache === true,
    hasPendingWrites: raw.metadata?.hasPendingWrites === true,
  });
  const stateEntry: {
    target: Target;
    query: object;
    converter: FirestoreDataConverter<unknown> | null;
    source: 'read' | 'listener';
    readPhase?: 'initial' | 'settled';
    metadata: { readonly fromCache: boolean; readonly hasPendingWrites: boolean };
    docs: readonly QuerySnapshotDocEqualityState[];
    changes: readonly QuerySnapshotChangeEqualityState[];
  } = { target, query, converter: converterOf(query) ?? null, source, metadata, docs, changes };
  if (source === 'read') stateEntry.readPhase = readPhase(target, query, docs, metadata);
  querySnapshotEquality.set(snapshot, stateEntry);
  if (typeof (snapshot as { toJSON?: unknown }).toJSON !== 'function') {
    attachQuerySnapshotToJson(snapshot, target, query);
  }
}

function readSnapshotField(
  data: DocumentData | undefined,
  fieldPath: SnapshotFieldPath,
  references?: ReferenceDecoder,
): unknown {
  try {
    return finalizeSandboxValue(getSnapshotField(data, fieldPath), references);
  } catch (error) {
    let reason = String(error);
    if (error instanceof Error) reason = error.message;
    throw new FirebaseError(
      'invalid-argument',
      `Function DocumentSnapshot.get() called with invalid data. ${reason}`,
    );
  }
}

function mergedSnapshotMetadata(snap: object, target: Target, path: string): SnapshotMetadataInstance {
  const clientMeta = clientStateFor(target).snapshotMetadata(path);
  const existingMeta = (snap as { metadata?: { fromCache?: boolean; hasPendingWrites?: boolean } }).metadata;
  if (!existingMeta) return clientMeta;
  return createSnapshotMetadata(
    Boolean(existingMeta.fromCache || clientMeta.fromCache),
    Boolean(existingMeta.hasPendingWrites || clientMeta.hasPendingWrites),
  );
}

function normalizeSnapshotDatabaseId(raw: string | undefined): string | undefined {
  if (typeof raw === 'string' && raw.length > 0 && raw !== '(default)') return raw;
  return undefined;
}

export function createSnapshotReferenceDecoder(target: Target): ReferenceDecoder {
  return {
    create: (path, databaseId) => {
      const normalizedDbId = normalizeSnapshotDatabaseId(databaseId);
      const currentDbId = normalizeSnapshotDatabaseId(target.databaseId);
      if (normalizedDbId === currentDbId) {
        return doc({ [TARGET_SYMBOL]: target, type: 'firestore' }, path);
      }
      const rebasedTarget: Target = { ...target, databaseId: normalizedDbId };
      return doc({ [TARGET_SYMBOL]: rebasedTarget, type: 'firestore' }, path);
    },
  };
}

export function wrapSandboxDocSnap<T>(snap: object, target?: Target): DocumentSnapshot<T> & { exists(): boolean } {
  const s = snap as {
    data: (options?: SnapshotOptions) => DocumentData | undefined;
    get?: (fieldPath: SnapshotFieldPath, options?: SnapshotOptions) => unknown;
    ref?: { path?: string };
    exists?: boolean | (() => boolean);
  };
  normalizeExists(s);
  const original = s.data.bind(snap);
  const hasTarget = target !== undefined;
  let references: ReferenceDecoder | undefined;
  if (hasTarget) references = createSnapshotReferenceDecoder(target);
  wireSnapshotDataReaders.set(snap, (options?: SnapshotOptions) =>
    finalizeSandboxData(original(options), references, true),
  );
  Object.defineProperty(s, 'data', {
    value: (options?: SnapshotOptions) => finalizeSandboxData(original(options), references),
    configurable: true,
    writable: true,
  });
  Object.defineProperty(s, 'get', {
    value: (fieldPath: SnapshotFieldPath, options?: SnapshotOptions) =>
      readSnapshotField(original(options), fieldPath, references),
    configurable: true,
    writable: true,
  });
  if (hasTarget) {
    const path = s.ref?.path;
    if (path !== undefined && path.length > 0) {
      Object.defineProperty(s, 'metadata', {
        value: mergedSnapshotMetadata(s, target, path),
        configurable: true,
      });
    }
  }
  return snap as DocumentSnapshot<T> & { exists(): boolean };
}

export function applyConverterToDocSnap<AppModel>(
  snap: ChainDocSnap,
  conv: FirestoreDataConverter<AppModel>,
  target: Target,
  kind: 'document' | 'query-child',
): DocumentSnapshot<AppModel> & { exists(): boolean } {
  const rawReference = doc({ [TARGET_SYMBOL]: target, type: 'firestore' }, snap.ref.path);
  const reference = rawReference.withConverter(conv);
  const references = createSnapshotReferenceDecoder(target);
  const snapWithOptions = snap as { data: (options?: SnapshotOptions) => DocumentData | undefined };
  const readRawField = (fieldPath: SnapshotFieldPath, options?: SnapshotOptions): unknown => {
    let rawData: DocumentData | undefined;
    if (snapshotExists(snap)) rawData = snapWithOptions.data(options);
    return readSnapshotField(rawData, fieldPath, references);
  };
  const mergedMeta = mergedSnapshotMetadata(snap, target, snap.ref.path);
  const readRawDataObject = (options?: SnapshotOptions): Record<string, unknown> | undefined => {
    if (!snapshotExists(snap)) return undefined;
    return finalizeSandboxData(snapWithOptions.data(options), references) as Record<string, unknown>;
  };
  const wrapped = {
    id: snap.id,
    ref: reference,
    exists: () => snapshotExists(snap),
    metadata: mergedMeta,
    data: (options?: SnapshotOptions) => {
      if (!snapshotExists(snap) || snapWithOptions.data(options) === undefined) return undefined;
      const currentMeta = (wrapped as { metadata: SnapshotMetadataInstance }).metadata;
      const queryDocSnap: QueryDocumentSnapshot = {
        id: snap.id,
        ref: rawReference,
        exists: () => true,
        metadata: currentMeta,
        data: (innerOptions?: SnapshotOptions) =>
          finalizeSandboxData(snapWithOptions.data(innerOptions), references) as DocumentData,
        get: readRawField,
        toJSON: buildDocSnapshotToJson(target, snap.ref.path, () => true, () => readRawDataObject(), () =>
          Boolean(currentMeta.hasPendingWrites),
        ),
      };
      return conv.fromFirestore(queryDocSnap, options ?? {});
    },
    get: readRawField,
    toJSON: () => ({}),
  };
  attachDocSnapshotToJson(wrapped, target, snap.ref.path, () => snapshotExists(snap), () => readRawDataObject());
  tag(wrapped, target);
  tag(snap.ref as object, target);
  wireSnapshotRefToUnderlying(snap.ref, target);
  recordDocumentSnapshot(wrapped, snap, target, conv as FirestoreDataConverter<unknown>, kind);
  return wrapped;
}

export function applyConverterToDeliveredSnap(
  snapshot: object,
  conv: FirestoreDataConverter<unknown>,
  target: Target,
  kind: 'document' | 'query-child',
): void {
  const s = snapshot as {
    id: string;
    ref?: { path?: string };
    exists?: boolean | (() => boolean);
    data: (options?: SnapshotOptions) => DocumentData | undefined;
    get?: (fieldPath: SnapshotFieldPath, options?: SnapshotOptions) => unknown;
  };
  const path = s.ref?.path ?? '';
  const readRaw = s.data.bind(snapshot);
  const rawReference = doc({ [TARGET_SYMBOL]: target, type: 'firestore' }, path);
  const references = createSnapshotReferenceDecoder(target);
  let readRawField: (fieldPath: SnapshotFieldPath, options?: SnapshotOptions) => unknown;
  if (typeof s.get === 'function') {
    readRawField = s.get.bind(snapshot);
  } else {
    readRawField = (fieldPath: SnapshotFieldPath, options?: SnapshotOptions) =>
      readSnapshotField(readRaw(options), fieldPath, references);
  }
  const converted = rawReference.withConverter(conv as FirestoreDataConverter<unknown, DocumentData>);
  Object.defineProperty(s, 'ref', { value: converted, configurable: true, writable: true });
  Object.defineProperty(s, 'data', {
    value: (options?: SnapshotOptions) => {
      const raw = readRaw(options);
      if (raw === undefined) return undefined;
      const mergedMeta = mergedSnapshotMetadata(s, target, path);
      const queryDocSnap: QueryDocumentSnapshot = {
        id: s.id,
        ref: rawReference,
        exists: () => true,
        metadata: mergedMeta,
        data: (innerOptions?: SnapshotOptions) => readRaw(innerOptions) as DocumentData,
        get: readRawField,
        toJSON: buildDocSnapshotToJson(target, path, () => true, () => readRaw() as Record<string, unknown>, () =>
          Boolean(mergedMeta.hasPendingWrites),
        ),
      };
      return conv.fromFirestore(queryDocSnap, options ?? {});
    },
    configurable: true,
    writable: true,
  });
  attachDocSnapshotToJson(
    snapshot,
    target,
    path,
    () => snapshotExists(s as unknown as ChainDocSnap),
    () => readRaw() as Record<string, unknown> | undefined,
  );
  const rawView = { ref: { path }, exists: s.exists, data: readRaw } as unknown as ChainDocSnap;
  recordDocumentSnapshot(snapshot, rawView, target, conv, kind);
}

export function tagSnapshotRefs(snap: unknown, target: Target): unknown {
  if (!snap || typeof snap !== 'object') return snap;
  tag(snap, target);
  const s = snap as {
    ref?: { id?: string; path?: string };
    docs?: Array<{ ref?: { id?: string; path?: string }; exists?: boolean | (() => boolean); data?: () => Record<string, unknown> }>;
    docChanges?: () => Array<{
      type?: string;
      doc?: { ref?: { id?: string; path?: string }; exists?: boolean | (() => boolean); data?: () => Record<string, unknown> };
    }>;
    exists?: boolean | (() => boolean);
    data?: () => Record<string, unknown> | undefined;
    toJSON?: unknown;
  };
  if (s.ref) {
    tag(s.ref as object, target);
    wireSnapshotRefToUnderlying(s.ref, target);
  }
  normalizeExists(s);
  const tagChildDoc = (docItem?: {
    ref?: { id?: string; path?: string };
    exists?: boolean | (() => boolean);
    data?: () => Record<string, unknown>;
    toJSON?: unknown;
  }) => {
    if (!docItem) return;
    tag(docItem as object, target);
    recordDocumentSnapshot(docItem as object, docItem as unknown as ChainDocSnap, target, null, 'query-child');
    if (docItem.ref) {
      tag(docItem.ref as object, target);
      wireSnapshotRefToUnderlying(docItem.ref, target);
    }
    normalizeExists(docItem);
    if (typeof docItem.toJSON !== 'function' && typeof docItem.ref?.path === 'string') {
      attachDocSnapshotToJson(docItem as object, target, docItem.ref.path, () => snapshotExists(docItem as unknown as ChainDocSnap), () => docItem.data?.());
    }
  };
  if (Array.isArray(s.docs)) {
    for (const docItem of s.docs) tagChildDoc(docItem);
    if (typeof s.docChanges === 'function') {
      for (const change of s.docChanges()) {
        if (change.type === 'removed') tagChildDoc(change.doc);
      }
    }
  } else if (s.ref) {
    recordDocumentSnapshot(snap, snap as unknown as ChainDocSnap, target, null, 'document');
    if (typeof s.toJSON !== 'function' && typeof s.ref.path === 'string') {
      attachDocSnapshotToJson(snap, target, s.ref.path, () => snapshotExists(s as unknown as ChainDocSnap), () => s.data?.());
    }
  }
  return snap;
}

function wireSnapshotRefToUnderlying(snapRef: { path?: string }, target: Target): void {
  if (typeof snapRef.path !== 'string' || snapRef.path.length === 0) return;
  const path = snapRef.path;
  try {
    const existing = refToUnderlying.get(snapRef as object);
    const full = existing ?? (sandboxDb(target).doc(path) as unknown as object);
    if (existing === undefined) refToUnderlying.set(snapRef as object, full);
    registerReferenceQueryValue(snapRef as object, path, target, full);
    decorateUntypedSnapshotRef(snapRef, path, target);
    if (target.kind === 'sandbox-live') {
      sandboxLiveRebuild.set(full, (fresh) => fresh.doc(path) as unknown as object);
    }
  } catch (err) {
    void err;
  }
}

function normalizeExists(obj: { exists?: boolean | (() => boolean) }): void {
  const current = obj.exists;
  if (typeof current === 'function') return;
  const value = current === true;
  try {
    Object.defineProperty(obj, 'exists', { value: () => value, writable: true, configurable: true, enumerable: true });
  } catch (err) {
    void err;
  }
}
