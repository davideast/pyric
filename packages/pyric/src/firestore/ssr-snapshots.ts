/**
 * `pyric/firestore` -- SSR snapshot `toJSON()`, `documentSnapshotFromJSON`,
 * and `querySnapshotFromJSON` matching `firebase/firestore@12.19.0`.
 */
import type { DocumentData } from 'pyric/sandbox/admin-firestore';
import { FirebaseError } from '../sandbox/internal/firebase-error.js';
import { assertBundleMatchesDatabase, buildModularQuery, expectedProjectIdOfTarget } from './bundles.js';
import { clientStateFor } from './client-state.js';
import { normalizeQueryOrders } from './internal/implicit-order.js';
import type { ReferenceDecoder } from './internal/value-codec.js';
import { validateFirestoreJson, type JsonObjectSchema } from './json-schema.js';
import { doc } from './refs.js';
import { getSnapshotField, type SnapshotFieldPath } from './sandbox/admin-compat/field-path.js';
import {
  decodeBundleBytes,
  type BundledCursorSpec,
  type BundledFilterSpec,
  type BundledQueryOrderSpec,
  type BundledQuerySourceSpec,
  type BundledWhereOp,
} from './sandbox/bundle-wire.js';
import { forEachDocument } from './sandbox/for-each-document.js';
import { normalizeFirestoreDatabaseId } from './sandbox/named-databases.js';
import { executeQuery, type QueryCursor, type QueryFilter, type QueryScope } from './sandbox/query-execution.js';
import { computeDocumentChanges, createDocChanges, type QueryConstraintPlan } from './sandbox/snapshot-listeners.js';
import {
  encodeDocumentSnapshotJson,
  encodeQuerySnapshotJson,
  type SerializedSnapshotEnvelope,
} from './sandbox/ssr-bundle-encoder.js';
import { fieldPathKeySegments } from './sandbox/update-fields.js';
import { createSnapshotMetadata, type SnapshotMetadataInstance } from './snapshot-metadata.js';
import { validateResumeSnapshotEnvelope } from './snapshot-resume.js';
import {
  applyConverterToDocSnap,
  createSnapshotReferenceDecoder,
  rawDocumentSnapshotForCursor,
  recordQuerySnapshot,
  tagSnapshotRefs,
} from './snapshots.js';
import { finalizeSandboxData, finalizeSandboxValue, tag, targetOf, underlyingOf, type Target } from './state.js';
import {
  Firestore,
  type DocumentReference,
  type DocumentSnapshot,
  type Firestore as FirestoreHandle,
  type FirestoreDataConverter,
  type Query,
  type QueryDocumentSnapshot,
  type QuerySnapshot,
} from './types.js';

export interface SnapshotOptions {
  readonly serverTimestamps?: 'estimate' | 'previous' | 'none';
}
export type ListenSource = 'default' | 'cache';

const INEQUALITY_FILTER_OPS = new Set<string>(['<', '<=', '>', '>=', '!=', 'not-in']);
const CLIENT_BUNDLE_NOT_SUPPORTED = 'NOT SUPPORTED';
const HYDRATED_METADATA: SnapshotMetadataInstance = createSnapshotMetadata(false, false);

function collectInequalityFields(filters: readonly QueryFilter[], out: Set<string>): void {
  for (const f of filters) {
    if (f.kind === 'where') {
      if (INEQUALITY_FILTER_OPS.has(f.op)) out.add(f.field);
    } else {
      collectInequalityFields(f.filters, out);
    }
  }
}

const DOCUMENT_SNAPSHOT_JSON_SCHEMA: JsonObjectSchema = {
  type: { typeString: 'string', expectedValue: 'firestore/documentSnapshot/1.0' },
  bundleSource: { typeString: 'string', expectedValue: 'DocumentSnapshot' },
  bundleName: { typeString: 'string' },
  bundle: { typeString: 'string' },
};

const QUERY_SNAPSHOT_JSON_SCHEMA: JsonObjectSchema = {
  type: { typeString: 'string', expectedValue: 'firestore/querySnapshot/1.0' },
  bundleSource: { typeString: 'string', expectedValue: 'QuerySnapshot' },
  bundleName: { typeString: 'string' },
  bundle: { typeString: 'string' },
};

function projectIdOfTarget(target: Target): string {
  return expectedProjectIdOfTarget(target) ?? 'pyric';
}

function mapQueryFilter(f: QueryFilter, references: ReferenceDecoder): BundledFilterSpec {
  if (f.kind === 'where') {
    return {
      kind: 'where',
      fieldPath: f.field,
      fieldSegments: fieldPathKeySegments(f.field),
      op: f.op as BundledWhereOp,
      value: finalizeSandboxValue(f.value, references),
    };
  }
  return {
    kind: f.kind,
    filters: f.filters.map((child) => mapQueryFilter(child, references)),
  };
}

function mapQueryCursor(cursor: QueryCursor | undefined, references: ReferenceDecoder): BundledCursorSpec | undefined {
  if (cursor === undefined) return undefined;
  return {
    inclusive: cursor.inclusive,
    values: cursor.values.map((v) => finalizeSandboxValue(v, references)),
  };
}

function extractQuerySourceSpec(queryObj: object, target: Target): BundledQuerySourceSpec {
  const references = createSnapshotReferenceDecoder(target);
  const under = underlyingOf(queryObj) as {
    path?: unknown;
    snapshotScope?: () => QueryScope;
    snapshotConstraints?: () => QueryConstraintPlan;
  };
  if (typeof under.snapshotScope === 'function' && typeof under.snapshotConstraints === 'function') {
    const scope = under.snapshotScope();
    const exec = under.snapshotConstraints().execution;
    let collectionPath = '';
    if (scope.kind === 'collection') collectionPath = scope.path;
    else collectionPath = scope.collectionId;
    let limitType: 'FIRST' | 'LAST' = 'FIRST';
    if (exec.limitFromEnd === true) limitType = 'LAST';
    const cursorNeedsNormalizedOrders =
      (exec.start !== undefined && exec.start.values.length > exec.orders.length) ||
      (exec.end !== undefined && exec.end.values.length > exec.orders.length);
    let sourceOrders = exec.orders;
    if (cursorNeedsNormalizedOrders) {
      const ineq = new Set<string>();
      collectInequalityFields(exec.filters, ineq);
      sourceOrders = normalizeQueryOrders(exec.orders, ineq);
    }
    const orders: BundledQueryOrderSpec[] = sourceOrders.map((o) => ({
      fieldPath: o.field,
      fieldSegments: fieldPathKeySegments(o.field),
      direction: o.direction,
    }));
    const startAtSpec = mapQueryCursor(exec.start, references);
    const endAtSpec = mapQueryCursor(exec.end, references);
    const spec: {
      collectionPath: string;
      isCollectionGroup: boolean;
      filters: BundledFilterSpec[];
      orders: BundledQueryOrderSpec[];
      limitCount?: number;
      limitType: 'FIRST' | 'LAST';
      startAt?: BundledCursorSpec;
      endAt?: BundledCursorSpec;
    } = {
      collectionPath,
      isCollectionGroup: scope.kind === 'collection-group',
      filters: exec.filters.map((f) => mapQueryFilter(f, references)),
      orders,
      limitCount: exec.limitCount,
      limitType,
    };
    if (startAtSpec !== undefined) spec.startAt = startAtSpec;
    if (endAtSpec !== undefined) spec.endAt = endAtSpec;
    return spec;
  }
  let rawPath = '';
  if (typeof under.path === 'string') rawPath = under.path;
  return { collectionPath: rawPath, isCollectionGroup: false, filters: [], orders: [] };
}

function snapshotHasPendingWrites(snapshot: object): boolean {
  const meta = (snapshot as { metadata?: { hasPendingWrites?: unknown } }).metadata;
  return Boolean(meta?.hasPendingWrites);
}

export function buildDocSnapshotToJson(
  target: Target,
  path: string,
  existsFn: () => boolean,
  readDataFn: () => Record<string, unknown> | undefined,
  hasPendingWritesFn?: () => boolean,
): () => SerializedSnapshotEnvelope {
  return () => {
    if (hasPendingWritesFn !== undefined && hasPendingWritesFn()) {
      throw new FirebaseError(
        'failed-precondition',
        'DocumentSnapshot.toJSON() attempted to serialize a document with pending writes. Await waitForPendingWrites() before invoking toJSON().',
      );
    }
    return encodeDocumentSnapshotJson(projectIdOfTarget(target), path, existsFn(), readDataFn(), target.databaseId);
  };
}

export function attachDocSnapshotToJson(
  snapshot: object,
  target: Target,
  path: string,
  existsFn: () => boolean,
  readDataFn: () => Record<string, unknown> | undefined,
): void {
  Object.defineProperty(snapshot, 'toJSON', {
    value: buildDocSnapshotToJson(target, path, existsFn, readDataFn, () => snapshotHasPendingWrites(snapshot)),
    configurable: true,
    writable: true,
  });
}

function buildQuerySnapshotToJson(
  snapshot: {
    docs?: ReadonlyArray<{ ref?: { path?: string }; data?: () => unknown }>;
    metadata?: { hasPendingWrites?: unknown };
  },
  target: Target,
  queryObj: object,
): () => SerializedSnapshotEnvelope {
  return () => {
    if (Boolean(snapshot.metadata?.hasPendingWrites)) {
      throw new FirebaseError(
        'failed-precondition',
        'QuerySnapshot.toJSON() attempted to serialize a document with pending writes. Await waitForPendingWrites() before invoking toJSON().',
      );
    }
    const references = createSnapshotReferenceDecoder(target);
    const rawDocs = snapshot.docs ?? [];
    const docs = rawDocs.map((d) => {
      const rawSnap = rawDocumentSnapshotForCursor(d as object);
      let docPath = '';
      if (typeof rawSnap.ref?.path === 'string') docPath = rawSnap.ref.path;
      else if (typeof d.ref?.path === 'string') docPath = d.ref.path;
      let rawData: Record<string, unknown> | undefined;
      if (typeof rawSnap.data === 'function') {
        rawData = finalizeSandboxData(rawSnap.data() as DocumentData | undefined, references) as
          | Record<string, unknown>
          | undefined;
      } else if (typeof d.data === 'function') {
        rawData = d.data() as Record<string, unknown> | undefined;
      }
      return { path: docPath, data: rawData ?? {} };
    });
    return encodeQuerySnapshotJson(
      projectIdOfTarget(target),
      extractQuerySourceSpec(queryObj, target),
      docs,
      target.databaseId,
    );
  };
}

export function attachQuerySnapshotToJson(snapshot: object, target: Target, queryObj: object): void {
  Object.defineProperty(snapshot, 'toJSON', {
    value: buildQuerySnapshotToJson(
      snapshot as {
        docs?: ReadonlyArray<{ ref?: { path?: string }; data?: () => unknown }>;
        metadata?: { hasPendingWrites?: unknown };
      },
      target,
      queryObj,
    ),
    configurable: true,
    writable: true,
  });
}

export function parseValidatedSnapshotEnvelope(
  json: unknown,
  expectedKind: 'document' | 'query' | 'any',
): SerializedSnapshotEnvelope {
  if (expectedKind === 'any') {
    return validateResumeSnapshotEnvelope(json);
  }
  let schema = QUERY_SNAPSHOT_JSON_SCHEMA;
  if (expectedKind === 'document') {
    schema = DOCUMENT_SNAPSHOT_JSON_SCHEMA;
  }
  const validated = validateFirestoreJson(json, schema);
  if (validated.bundle === CLIENT_BUNDLE_NOT_SUPPORTED) {
    throw new FirebaseError(
      'invalid-argument',
      'The provided JSON object was created in a client environment, which is not supported.',
    );
  }
  return validated as unknown as SerializedSnapshotEnvelope;
}

function createHydratedReferenceDecoder(db: FirestoreHandle, target: Target): ReferenceDecoder {
  const projectId = projectIdOfTarget(target);
  const currentDb = normalizeFirestoreDatabaseId(target.databaseId);
  return {
    create(path: string, refDatabaseId?: string) {
      const normalizedRefDb = normalizeFirestoreDatabaseId(refDatabaseId);
      if (refDatabaseId !== undefined && normalizedRefDb !== currentDb) {
        // eslint-disable-next-line no-console
        console.warn(
          `@firebase/firestore: Firestore (12.19.0): A document reference to ${path} refers to a different database (${projectId}/${normalizedRefDb}), which is not supported. It will be treated as a reference in the current database (${projectId}/${currentDb}) instead.`,
        );
      }
      return doc(db, path);
    },
  };
}

function cloneHydratedValue(val: unknown): unknown {
  if (val === null || typeof val !== 'object') return val;
  if (Array.isArray(val)) return val.map(cloneHydratedValue);
  const proto = Object.getPrototypeOf(val);
  if (proto !== Object.prototype && proto !== null) return val;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
    Object.defineProperty(out, k, {
      value: cloneHydratedValue(v),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

function buildHydratedDocSnapshot(
  db: FirestoreHandle,
  target: Target,
  docPath: string,
  data: Record<string, unknown>,
): QueryDocumentSnapshot & {
  readonly ref: DocumentReference & { toJSON(): object };
  readonly metadata: SnapshotMetadataInstance;
} {
  const ref = doc(db, docPath);
  const references = createHydratedReferenceDecoder(db, target);
  const readData = (): DocumentData =>
    finalizeSandboxData(cloneHydratedValue(data) as DocumentData, references) as DocumentData;
  const readField = (fieldPath: SnapshotFieldPath): unknown => {
    try {
      return finalizeSandboxValue(getSnapshotField(readData(), fieldPath), references);
    } catch (err) {
      let reason = String(err);
      if (err instanceof Error) reason = err.message;
      throw new FirebaseError('invalid-argument', `Function DocumentSnapshot.get() called with invalid data. ${reason}`);
    }
  };
  const snap = {
    id: ref.id,
    ref,
    exists: () => true,
    metadata: HYDRATED_METADATA,
    data: readData,
    get: readField,
    toJSON: () => ({}),
  };
  attachDocSnapshotToJson(snap, target, docPath, () => true, readData);
  tagSnapshotRefs(snap, target);
  return snap;
}

export function documentSnapshotFromJSON(
  db: FirestoreHandle,
  json: object,
): DocumentSnapshot & {
  readonly ref: DocumentReference & { toJSON(): object };
  readonly metadata: SnapshotMetadataInstance;
};
export function documentSnapshotFromJSON<AppModelType, DbModelType extends DocumentData = DocumentData>(
  db: FirestoreHandle,
  json: object,
  converter: FirestoreDataConverter<AppModelType, DbModelType>,
): DocumentSnapshot<AppModelType> & {
  readonly ref: DocumentReference<AppModelType> & { toJSON(): object };
  readonly metadata: SnapshotMetadataInstance;
};
export function documentSnapshotFromJSON<AppModelType = DocumentData>(
  db: FirestoreHandle,
  json: object,
  converter?: FirestoreDataConverter<AppModelType, DocumentData>,
): DocumentSnapshot<AppModelType> & {
  readonly ref: DocumentReference<AppModelType> & { toJSON(): object };
  readonly metadata: SnapshotMetadataInstance;
} {
  if (!(db instanceof Firestore)) {
    throw new FirebaseError(
      'invalid-argument',
      'Expected first argument to documentSnapshotFromJSON() to be a Firestore instance.',
    );
  }
  const target = targetOf(db);
  clientStateFor(target).markStarted();
  const env = parseValidatedSnapshotEnvelope(json, 'document');
  const parsed = decodeBundleBytes(new TextEncoder().encode(env.bundle));
  assertBundleMatchesDatabase(
    parsed,
    normalizeFirestoreDatabaseId(target.databaseId),
    expectedProjectIdOfTarget(target),
  );
  if (parsed.documents.length !== 1) {
    throw new FirebaseError(
      'invalid-argument',
      `Expected bundle data to contain 1 document, but it contains ${parsed.documents.length} documents.`,
    );
  }
  const first = parsed.documents[0];
  if (first === undefined || !first.exists || first.data === undefined) {
    throw new Error('Bundled document snapshot contains no existing document.');
  }
  let snapshotPath = first.docPath;
  if (env.bundleName.length > 0) snapshotPath = env.bundleName;
  const untypedSnap = buildHydratedDocSnapshot(db, target, snapshotPath, first.data);
  if (converter !== undefined) {
    const convertedSnap = applyConverterToDocSnap(
      untypedSnap as unknown as Parameters<typeof applyConverterToDocSnap>[0],
      converter,
      target,
      'document',
    );
    Object.defineProperty(convertedSnap, 'metadata', {
      value: HYDRATED_METADATA,
      configurable: true,
    });
    return convertedSnap as unknown as DocumentSnapshot<AppModelType> & {
      readonly ref: DocumentReference<AppModelType> & { toJSON(): object };
      readonly metadata: SnapshotMetadataInstance;
    };
  }
  return untypedSnap as unknown as DocumentSnapshot<AppModelType> & {
    readonly ref: DocumentReference<AppModelType> & { toJSON(): object };
    readonly metadata: SnapshotMetadataInstance;
  };
}

function sortBundledRowsForQuery(
  rows: ReadonlyArray<{ readonly path: string; readonly data: Record<string, unknown> }>,
  baseQuery: Query,
): Array<{ readonly path: string; readonly data: Record<string, unknown> }> {
  const under = underlyingOf(baseQuery) as { snapshotConstraints?: () => QueryConstraintPlan };
  if (typeof under.snapshotConstraints !== 'function') {
    return [...rows];
  }
  const exec = under.snapshotConstraints().execution;
  const ineq = new Set<string>();
  collectInequalityFields(exec.filters, ineq);
  const sortedOrders = normalizeQueryOrders(exec.orders, ineq);
  const mutableRows = rows.map((row) => ({ path: row.path, data: row.data }));
  return executeQuery(mutableRows, {
    filters: [],
    orders: sortedOrders,
    limitFromEnd: false,
  });
}

export function querySnapshotFromJSON(db: FirestoreHandle, json: object): QuerySnapshot;
export function querySnapshotFromJSON<AppModelType, DbModelType extends DocumentData = DocumentData>(
  db: FirestoreHandle,
  json: object,
  converter: FirestoreDataConverter<AppModelType, DbModelType>,
): QuerySnapshot<AppModelType>;
export function querySnapshotFromJSON<AppModelType = DocumentData>(
  db: FirestoreHandle,
  json: object,
  converter?: FirestoreDataConverter<AppModelType, DocumentData>,
): QuerySnapshot<AppModelType> {
  if (!(db instanceof Firestore)) {
    throw new FirebaseError(
      'invalid-argument',
      'Expected first argument to querySnapshotFromJSON() to be a Firestore instance.',
    );
  }
  const target = targetOf(db);
  clientStateFor(target).markStarted();
  const env = parseValidatedSnapshotEnvelope(json, 'query');
  const parsed = decodeBundleBytes(new TextEncoder().encode(env.bundle));
  assertBundleMatchesDatabase(
    parsed,
    normalizeFirestoreDatabaseId(target.databaseId),
    expectedProjectIdOfTarget(target),
  );
  if (parsed.namedQueries.length !== 1 || parsed.namedQueries[0] === undefined) {
    throw new FirebaseError(
      'invalid-argument',
      `Snapshot data expected 1 query but found ${parsed.namedQueries.length} queries.`,
    );
  }
  const firstNamedQuery = parsed.namedQueries[0];
  const baseQuery = buildModularQuery(db, firstNamedQuery);
  const existingRows = parsed.documents
    .filter((d): d is typeof d & { data: Record<string, unknown> } => d.exists && d.data !== undefined)
    .map((d) => ({ path: d.docPath, data: d.data }));
  const sortedRows = sortBundledRowsForQuery(existingRows, baseQuery);
  const rawDocs = sortedRows.map((row) => buildHydratedDocSnapshot(db, target, row.path, row.data));
  let docs = rawDocs as unknown as Array<
    QueryDocumentSnapshot<AppModelType> & {
      readonly ref: DocumentReference<AppModelType> & { toJSON(): object };
      readonly metadata: SnapshotMetadataInstance;
    }
  >;
  let hydratedQuery: Query<AppModelType>;
  if (converter !== undefined) {
    docs = rawDocs.map((d) => {
      const converted = applyConverterToDocSnap(
        d as unknown as Parameters<typeof applyConverterToDocSnap>[0],
        converter,
        target,
        'query-child',
      );
      Object.defineProperty(converted, 'metadata', {
        value: HYDRATED_METADATA,
        configurable: true,
      });
      return converted;
    }) as unknown as typeof docs;
    hydratedQuery = baseQuery.withConverter(converter);
  } else {
    hydratedQuery = baseQuery as Query<AppModelType>;
  }
  const changes = computeDocumentChanges(
    undefined,
    docs.map((d) => ({ path: d.ref.path })),
    docs,
    () => false,
    () => docs[0] as typeof docs[number],
  );
  const rawQSnap = {
    query: hydratedQuery,
    size: docs.length,
    empty: docs.length === 0,
    docs,
    metadata: HYDRATED_METADATA,
    forEach: forEachDocument(docs),
    docChanges: createDocChanges(changes, false),
    toJSON: () => ({}),
  };
  const qsnap: QuerySnapshot<AppModelType> = tag(rawQSnap, target);
  attachQuerySnapshotToJson(qsnap, target, hydratedQuery as object);
  const rawRecordView = { docs: rawDocs, metadata: HYDRATED_METADATA, docChanges: () => changes };
  recordQuerySnapshot(qsnap, rawRecordView, target, hydratedQuery as object, 'listener');
  return qsnap;
}
