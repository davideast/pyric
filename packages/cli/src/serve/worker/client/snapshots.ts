/**
 * Firestore snapshot machinery for the worker client — wire-form document
 * results rehydrated into the modular SDK's snapshot shapes. Shared by the
 * read, listener, and transaction families.
 */
import type {
  FilterConstraintDescriptor,
  SerializedDocData,
  TargetDescriptor,
} from '../protocol.js';
import { deserializeDocData } from '../protocol.js';
import type { ClientPort, DocRefHandle } from './handles.js';
import { createDocumentReference } from './firestore-reference.js';
import { FirebaseError } from 'pyric/app';
import { decodeDocValue } from 'pyric/firestore/internal/value-codec';
import {
  encodeDocumentSnapshotJson,
  encodeQuerySnapshotJson,
  type BundledFilterSpec,
  type BundledQuerySourceSpec,
  type BundledWhereOp,
} from 'pyric/firestore/internal';
import type {
  DocumentData,
  FirestoreDataConverter,
  QueryDocumentSnapshot,
  SnapshotMetadata,
  SnapshotOptions,
} from 'pyric/firestore';
import {
  computeDocumentChanges,
  createDocChanges,
  forEachDocument,
  getSnapshotField,
  type DocChangesOptions,
  type DocumentChange,
  type SnapshotFieldPath,
} from 'pyric/sandbox/internal';

// ─── Rehydration (class instance restoration) ─────────────────────────────

/** Restore SDK scalar values and references bound to this snapshot's client port. */
function rehydrateDocData(serialized: SerializedDocData, port: ClientPort): Record<string, unknown> {
  const references = { create: (path: string) => createDocumentReference(port, path) };
  return deserializeDocData(serialized, references) as Record<string, unknown>;
}

// ─── Snapshot deserialization helpers ────────────────────────────────────

export interface RawDocResult {
  id: string;
  path?: string;
  exists: boolean;
  data?: SerializedDocData;
  /** Query listener frames only: this document's own `metadata.hasPendingWrites`. */
  hasPendingWrites?: boolean;
  fromCache?: boolean;
  serverTimestampVariants?: {
    readonly none: SerializedDocData;
    readonly previous: SerializedDocData;
  };
}

const SETTLED_METADATA: SnapshotMetadata = Object.freeze({ fromCache: false, hasPendingWrites: false });

function frameMetadata(raw: { hasPendingWrites?: unknown; fromCache?: unknown }): SnapshotMetadata {
  const fromCache = raw.fromCache === true;
  const hasPendingWrites = raw.hasPendingWrites === true;
  if (!fromCache && !hasPendingWrites) return SETTLED_METADATA;
  return Object.freeze({ fromCache, hasPendingWrites });
}

export interface RawCursorSnapshot {
  readonly id: string;
  readonly path: string;
  readonly exists: boolean;
  readonly data: Record<string, unknown> | undefined;
}

const rawCursorSnapshots = new WeakMap<object, RawCursorSnapshot>();

/** Converter-free raw document state recorded on worker client snapshots for cursor bounds. */
export function rawClientSnapshotForCursor(snapshot: object): RawCursorSnapshot | undefined {
  return rawCursorSnapshots.get(snapshot);
}

function mapDescriptorFilter(port: ClientPort, f: FilterConstraintDescriptor): BundledFilterSpec {
  if (f.kind === 'where') {
    const references = { create: (path: string) => createDocumentReference(port, path) };
    return {
      kind: 'where',
      fieldPath: f.field,
      op: f.op as BundledWhereOp,
      value: decodeDocValue(f.value, references, f.valueEncoding),
    };
  }
  return { kind: f.kind, filters: f.filters.map((sub) => mapDescriptorFilter(port, sub)) };
}

function descriptorToQuerySourceSpec(port: ClientPort, desc?: TargetDescriptor): BundledQuerySourceSpec {
  if (desc === undefined) return { collectionPath: '', isCollectionGroup: false, filters: [], orders: [] };
  if (desc.__ref === 'collection') return { collectionPath: desc.path, isCollectionGroup: false, filters: [], orders: [] };
  if (desc.__ref === 'group') return { collectionPath: desc.collectionId, isCollectionGroup: true, filters: [], orders: [] };
  if (desc.__ref === 'doc') return { collectionPath: desc.path, isCollectionGroup: false, filters: [], orders: [] };
  let collectionPath = '';
  let isCollectionGroup = false;
  if (desc.source.__ref === 'group') {
    collectionPath = desc.source.collectionId;
    isCollectionGroup = true;
  } else {
    collectionPath = desc.source.path;
  }
  const filters: BundledFilterSpec[] = [];
  const orders: Array<{ fieldPath: string; direction: 'asc' | 'desc' }> = [];
  let limitCount: number | undefined;
  let limitType: 'FIRST' | 'LAST' | undefined;
  for (const c of desc.constraints) {
    if (c.kind === 'where' || c.kind === 'and' || c.kind === 'or') filters.push(mapDescriptorFilter(port, c));
    else if (c.kind === 'orderBy') orders.push({ fieldPath: c.field, direction: c.direction ?? 'asc' });
    else if (c.kind === 'limit') { limitCount = c.n; limitType = 'FIRST'; }
    else if (c.kind === 'limitToLast') { limitCount = c.n; limitType = 'LAST'; }
  }
  return { collectionPath, isCollectionGroup, filters, orders, limitCount, limitType };
}

export function makeDocSnapshot<T = DocumentData>(
  raw: RawDocResult,
  port: ClientPort,
  reference?: DocRefHandle<T>,
  metadata: SnapshotMetadata = SETTLED_METADATA,
): ClientDocSnapshot<T> {
  const isMalformed = !isDocumentResult(raw);
  if (isMalformed) throw new FirebaseError('invalid-argument', 'The sandbox sent a malformed document result.');
  const serialized = raw.data;
  // Production builds a new object on every read, so a caller that mutates
  // one result never changes the next (FP-13). The copy kept here is for
  // cursor bounds only and is never handed out.
  const freshData = (): Record<string, unknown> | undefined => {
    const hasData = raw.exists && serialized !== undefined;
    if (hasData) return rehydrateDocData(serialized, port);
    return undefined;
  };
  const freshVariantData = (options?: SnapshotOptions): Record<string, unknown> | undefined => {
    const hasData = raw.exists && serialized !== undefined;
    if (!hasData) return undefined;
    const variants = raw.serverTimestampVariants;
    if (variants !== undefined && metadata.hasPendingWrites) {
      if (options?.serverTimestamps === 'estimate') return rehydrateDocData(serialized, port);
      if (options?.serverTimestamps === 'previous') return rehydrateDocData(variants.previous, port);
      return rehydrateDocData(variants.none, port);
    }
    return rehydrateDocData(serialized, port);
  };
  const data = freshData();
  const path = raw.path ?? raw.id;
  const ref = reference ?? createDocumentReference<T>(port, path);
  const read = (options?: SnapshotOptions): T | undefined => {
    const document = freshVariantData(options);
    const isMissing = document === undefined;
    if (isMissing) return undefined;
    const converter = ref.converter;
    const hasConverter = converter !== null;
    if (hasConverter) {
      const snapshot: QueryDocumentSnapshot = {
        id: raw.id,
        ref: createDocumentReference(port, path),
        exists: () => true,
        metadata,
        data: (innerOptions?: SnapshotOptions) => freshVariantData(innerOptions) as DocumentData,
        get: (fieldPath, innerOptions?: SnapshotOptions) =>
          readField(freshVariantData(innerOptions), fieldPath),
        toJSON: () => encodeDocumentSnapshotJson('pyric', path, true, document),
      };
      const resolvedOptions: SnapshotOptions = options ?? {};
      return (converter as FirestoreDataConverter<T>).fromFirestore(snapshot, resolvedOptions);
    }
    return document as T;
  };
  const docSnapshot: ClientDocSnapshot<T> = {
    id: raw.id,
    path,
    ref,
    exists: () => raw.exists,
    metadata,
    data: read,
    // Production reads the stored field without the converter, as the in-page snapshot does.
    get: (fieldPath, options) => readField(freshVariantData(options), fieldPath),
    toJSON: () => encodeDocumentSnapshotJson('pyric', path, raw.exists, freshData()),
  };
  rawCursorSnapshots.set(docSnapshot, { id: raw.id, path, exists: raw.exists, data });
  return docSnapshot;
}

/**
 * `DocumentSnapshot.get` of the client SDK: an invalid field path is a
 * `FirebaseError` with code `invalid-argument`, not a plain `Error`.
 */
function readField(data: Record<string, unknown> | undefined, fieldPath: SnapshotFieldPath): unknown {
  try {
    return getSnapshotField(data, fieldPath);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new FirebaseError('invalid-argument', `Function DocumentSnapshot.get() called with invalid data. ${reason}`);
  }
}

export interface RawQueryResult {
  docs: RawDocResult[];
  /** Listener frames only: the sandbox snapshot's `metadata.hasPendingWrites`. */
  hasPendingWrites?: boolean;
  fromCache?: boolean;
}

/**
 * Per-listener state for `docChanges()` and re-establishment deduplication:
 * the previous query or document result the listener delivered, and whether it
 * subscribed with `includeMetadataChanges`. A listener passes the same state
 * to every {@link makeSnapshot} call, so each snapshot's changes are computed
 * against the one before it.
 */
export interface QueryChangeBaseline {
  readonly excludesMetadataChanges: boolean;
  previous?: RawDocResult[];
  previousDocument?: RawDocResult;
  previousHasPendingWrites?: boolean;
  previousFromCache?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSerializedData(value: unknown): boolean {
  return isRecord(value) && typeof value.json === 'string';
}

function isDocumentResult(value: unknown): value is RawDocResult {
  const isObject = isRecord(value);
  const isInvalidObject = !isObject;
  if (isInvalidObject) return false;
  const data = value.data;
  const hasValidData = data === undefined || isSerializedData(data);
  const variants = value.serverTimestampVariants;
  const hasValidVariants = variants === undefined
    || (isRecord(variants) && isSerializedData(variants.none) && isSerializedData(variants.previous));
  const hasValidPath = value.path === undefined || typeof value.path === 'string';
  return typeof value.id === 'string' && typeof value.exists === 'boolean' && hasValidPath && hasValidData
    && hasValidVariants && hasValidMetadataFlags(value);
}

function hasValidMetadataFlags(value: Record<string, unknown>): boolean {
  const validPending = value.hasPendingWrites === undefined || typeof value.hasPendingWrites === 'boolean';
  const validCache = value.fromCache === undefined || typeof value.fromCache === 'boolean';
  return validPending && validCache;
}

function isQueryResult(value: unknown): value is RawQueryResult {
  return isRecord(value) && Array.isArray(value.docs) && value.docs.every(isDocumentResult)
    && hasValidMetadataFlags(value);
}

/**
 * Decode a listener delivery before invoking application code.
 *
 * Returns `null` for a query frame that changes nothing the listener would
 * observe: no document changes, and either the same `hasPendingWrites` or a
 * listener that did not request metadata changes. The
 * host sends such a frame when it re-establishes a listener (an auth change,
 * a state replacement); the in-page sandbox re-evaluates in place and
 * delivers nothing in that case.
 */
function compareJsonKeys(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    for (let i = 0; i < left.length; i++) {
      if (!jsonValuesEqual(left[i], right[i])) return false;
    }
    return true;
  }
  const leftKeys = Object.keys(left as Record<string, unknown>).sort(compareJsonKeys);
  const rightKeys = Object.keys(right as Record<string, unknown>).sort(compareJsonKeys);
  if (leftKeys.length !== rightKeys.length) return false;
  for (let i = 0; i < leftKeys.length; i++) {
    const key = leftKeys[i];
    if (key === undefined || key !== rightKeys[i]) return false;
    if (!jsonValuesEqual((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key])) {
      return false;
    }
  }
  return true;
}

function serializedDocDataEqual(
  left: SerializedDocData | undefined,
  right: SerializedDocData | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  if (left.valueEncoding !== right.valueEncoding) return false;
  if (left.json === right.json) return true;
  try {
    return jsonValuesEqual(JSON.parse(left.json), JSON.parse(right.json));
  } catch {
    return false;
  }
}

export function makeSnapshot(
  raw: unknown,
  port: ClientPort,
  converter: FirestoreDataConverter<unknown> | null,
  baseline: QueryChangeBaseline,
): ClientDocSnapshot | ClientQuerySnapshot | null {
  const isQuery = isQueryResult(raw);
  if (isQuery) {
    const snapshot = makeQuerySnapshot(raw, port, converter, baseline);
    const sameMetadata = snapshot.metadata.hasPendingWrites === baseline.previousHasPendingWrites
      && snapshot.metadata.fromCache === baseline.previousFromCache;
    const isUnchanged = baseline.previous !== undefined
      && snapshot.docChanges().length === 0
      && (baseline.excludesMetadataChanges || sameMetadata);
    if (isUnchanged) return null;
    baseline.previous = raw.docs;
    baseline.previousHasPendingWrites = snapshot.metadata.hasPendingWrites;
    baseline.previousFromCache = snapshot.metadata.fromCache;
    return snapshot;
  }
  const isDocument = isDocumentResult(raw);
  if (isDocument) {
    const metadata = frameMetadata(raw as { hasPendingWrites?: unknown; fromCache?: unknown });
    const previous = baseline.previousDocument;
    const isSameDocument = previous !== undefined
      && previous.exists === raw.exists
      && (!raw.exists || serializedDocDataEqual(previous.data, raw.data));
    const sameMetadata = metadata.hasPendingWrites === baseline.previousHasPendingWrites
      && metadata.fromCache === baseline.previousFromCache;
    const isUnchanged = isSameDocument
      && (baseline.excludesMetadataChanges || sameMetadata);
    if (isUnchanged) return null;
    baseline.previousDocument = raw;
    baseline.previousHasPendingWrites = metadata.hasPendingWrites;
    baseline.previousFromCache = metadata.fromCache;
    return makeDocSnapshot(
      raw,
      port,
      createDocumentReference(port, raw.path ?? raw.id, converter),
      metadata,
    );
  }
  throw new FirebaseError('invalid-argument', 'The sandbox sent a malformed Firestore snapshot.');
}

/**
 * Rehydrate a query result. A listener passes its {@link QueryChangeBaseline}
 * so `docChanges()` reports the difference from its previous snapshot; a
 * one-shot read passes none, and every document is `added`.
 */
export function makeQuerySnapshot(
  raw: RawQueryResult,
  port: ClientPort,
  converter: FirestoreDataConverter<unknown> | null = null,
  baseline: QueryChangeBaseline = { excludesMetadataChanges: false },
  sourceDescriptor?: TargetDescriptor,
  metadataOverride?: SnapshotMetadata,
): ClientQuerySnapshot {
  const isMalformed = !isQueryResult(raw);
  if (isMalformed) throw new FirebaseError('invalid-argument', 'The sandbox sent a malformed query result.');
  const metadata = metadataOverride ?? frameMetadata(raw);
  // Each document carries its own pending state: production marks only the
  // documents with a pending write, not every document in the snapshot (FP-5).
  const snapshotOf = (doc: RawDocResult) => makeDocSnapshot(
    doc,
    port,
    createDocumentReference(port, doc.path ?? doc.id, converter),
    Object.freeze({
      fromCache: doc.fromCache === true || metadata.fromCache,
      hasPendingWrites: doc.hasPendingWrites === true,
    }),
  );
  const docs = raw.docs.map(snapshotOf);
  const rows = raw.docs.map((doc) => ({ path: doc.path ?? doc.id, doc }));
  const previous = baseline.previous?.map((doc) => ({ path: doc.path ?? doc.id, doc }));
  const changes = computeDocumentChanges(
    previous,
    rows,
    docs,
    (before, after) => serializedDocDataEqual(before.doc.data, after.doc.data),
    (row) => snapshotOf(row.doc),
  );
  let changesWithMetadata: typeof changes | undefined;
  if (!baseline.excludesMetadataChanges) {
    changesWithMetadata = computeDocumentChanges(
      previous,
      rows,
      docs,
      (before, after) =>
        serializedDocDataEqual(before.doc.data, after.doc.data)
        && Boolean(before.doc.hasPendingWrites) === Boolean(after.doc.hasPendingWrites)
        && Boolean(before.doc.fromCache) === Boolean(after.doc.fromCache),
      (row) => snapshotOf(row.doc),
    );
  }
  return {
    metadata,
    size: docs.length,
    empty: docs.length === 0,
    docs,
    forEach: forEachDocument(docs),
    docChanges: createDocChanges(changes, baseline.excludesMetadataChanges, changesWithMetadata),
    toJSON: () =>
      encodeQuerySnapshotJson(
        'pyric',
        descriptorToQuerySourceSpec(port, sourceDescriptor),
        docs.map((d) => ({ path: d.ref.path, data: (d.data() as Record<string, unknown> | undefined) ?? {} })),
      ),
  };
}

// ─── Client snapshot types ────────────────────────────────────────────────

export interface ClientDocSnapshot<T = DocumentData> {
  readonly id: string;
  readonly path: string;
  /** Full port-carrying reference, usable by write APIs. */
  readonly ref: DocRefHandle<T>;
  readonly metadata: SnapshotMetadata;
  exists(): boolean;
  data(options?: SnapshotOptions): T | undefined;
  /** Production's `DocumentSnapshot.get`: the stored field at `fieldPath`, or `undefined`. */
  get(fieldPath: SnapshotFieldPath, options?: SnapshotOptions): unknown;
  toJSON(): object;
}

export interface ClientQuerySnapshot {
  readonly metadata: SnapshotMetadata;
  readonly size: number;
  readonly empty: boolean;
  readonly docs: ClientDocSnapshot[];
  /** Production's `QuerySnapshot.forEach`: calls `callback` once per document, in query order. */
  forEach(callback: (doc: ClientDocSnapshot) => void, thisArg?: unknown): void;
  /** Production's `QuerySnapshot.docChanges`: the changes since the
   * listener's previous snapshot, or every document `added` on the first. */
  docChanges(options?: DocChangesOptions): DocumentChange<ClientDocSnapshot>[];
  toJSON(): object;
}
