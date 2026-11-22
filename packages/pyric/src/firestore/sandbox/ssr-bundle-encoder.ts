/**
 * `pyric/firestore` -- SSR snapshot `toJSON()` envelope encoder producing
 * `firebase/firestore@12.19.0`-compatible `firestore/documentSnapshot/1.0` and
 * `firestore/querySnapshot/1.0` bundle envelopes.
 */
import { Bytes, GeoPoint, Timestamp } from '../field-values.js';
import { refToTarget } from '../state.js';
import { extractDuckReferenceDatabaseId } from './admin-reference-database.js';
import {
  encodeBundleElements,
  type BundledFilterSpec,
  type BundledQuerySourceSpec,
  type BundledWhereOp,
} from './bundle-wire.js';
import { DEFAULT_FIRESTORE_DATABASE, normalizeFirestoreDatabaseId } from './named-databases.js';

export interface SerializedSnapshotEnvelope {
  readonly type: 'firestore/documentSnapshot/1.0' | 'firestore/querySnapshot/1.0';
  readonly bundle: string;
  readonly bundleSource: 'DocumentSnapshot' | 'QuerySnapshot';
  readonly bundleName: string;
}

const WHERE_OP_TO_REST: Record<BundledWhereOp, string> = {
  '==': 'EQUAL', '!=': 'NOT_EQUAL', '<': 'LESS_THAN', '<=': 'LESS_THAN_OR_EQUAL',
  '>': 'GREATER_THAN', '>=': 'GREATER_THAN_OR_EQUAL', 'array-contains': 'ARRAY_CONTAINS',
  in: 'IN', 'array-contains-any': 'ARRAY_CONTAINS_ANY', 'not-in': 'NOT_IN',
};

const SNAPSHOT_BUNDLE_TS = '2026-01-15T12:00:00.000000000Z';
let bundleCounter = 0;

function nextBundleId(): string {
  bundleCounter += 1;
  return `pyricBundle${String(bundleCounter).padStart(9, '0')}`;
}

function encodeRestValue(
  val: unknown,
  projectId = 'pyric',
  databaseId: string = DEFAULT_FIRESTORE_DATABASE,
): Record<string, unknown> {
  if (val === null || val === undefined) return { nullValue: null };
  if (typeof val === 'boolean') return { booleanValue: val };
  if (typeof val === 'string') return { stringValue: val };
  if (typeof val === 'number') {
    if (Number.isInteger(val) && Number.isSafeInteger(val)) return { integerValue: String(val) };
    return { doubleValue: val };
  }
  if (val instanceof Timestamp) return { timestampValue: val.toDate().toISOString() };
  if (val instanceof Bytes) return { bytesValue: val.toBase64() };
  if (val instanceof GeoPoint) return { geoPointValue: { latitude: val.latitude, longitude: val.longitude } };
  if (Array.isArray(val)) {
    return {
      arrayValue: {
        values: val.map((item) => encodeRestValue(item, projectId, databaseId)),
      },
    };
  }
  if (typeof val === 'object') {
    const rec = val as Record<string, unknown>;
    if (typeof rec.path === 'string' && typeof rec.id === 'string') {
      const targetDb = refToTarget.get(val)?.databaseId;
      const duckDb = extractDuckReferenceDatabaseId(rec);
      const refDb = normalizeFirestoreDatabaseId(targetDb ?? duckDb ?? databaseId);
      return { referenceValue: `projects/${projectId}/databases/${refDb}/documents/${rec.path}` };
    }
    const fields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rec)) {
      if (v !== undefined) fields[k] = encodeRestValue(v, projectId, databaseId);
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(val) };
}

function encodeRestFields(
  data: Record<string, unknown>,
  projectId: string,
  databaseId: string,
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [k, v] of Object.entries(data)) {
    if (v !== undefined) out[k] = encodeRestValue(v, projectId, databaseId);
  }
  return out;
}

function encodeStructuredFilter(
  filter: BundledFilterSpec,
  projectId: string,
  databaseId: string,
): Record<string, unknown> {
  if (filter.kind === 'where') {
    return {
      fieldFilter: {
        field: { fieldPath: filter.fieldPath },
        op: WHERE_OP_TO_REST[filter.op] ?? 'EQUAL',
        value: encodeRestValue(filter.value, projectId, databaseId),
      },
    };
  }
  let op = 'AND';
  if (filter.kind === 'or') op = 'OR';
  return {
    compositeFilter: {
      op,
      filters: filter.filters.map((child) => encodeStructuredFilter(child, projectId, databaseId)),
    },
  };
}

function encodeStructuredQuery(
  rootParent: string,
  spec: BundledQuerySourceSpec,
  projectId: string,
  databaseId: string,
): { parent: string; structuredQuery: Record<string, unknown>; limitType?: 'FIRST' | 'LAST' } {
  const segments = spec.collectionPath.split('/').filter((s) => s.length > 0);
  let collectionId = spec.collectionPath;
  let parent = rootParent;
  if (!spec.isCollectionGroup && segments.length > 1) {
    collectionId = segments[segments.length - 1] ?? spec.collectionPath;
    parent = `${rootParent}/${segments.slice(0, -1).join('/')}`;
  }
  const fromEntry: Record<string, unknown> = { collectionId };
  if (spec.isCollectionGroup) fromEntry.allDescendants = true;
  const sq: Record<string, unknown> = { from: [fromEntry] };
  if (spec.filters.length === 1 && spec.filters[0] !== undefined) {
    sq.where = encodeStructuredFilter(spec.filters[0], projectId, databaseId);
  } else if (spec.filters.length > 1) {
    sq.where = encodeStructuredFilter({ kind: 'and', filters: spec.filters }, projectId, databaseId);
  }
  if (spec.orders.length > 0) {
    sq.orderBy = spec.orders.map((o) => {
      let direction = 'ASCENDING';
      if (o.direction === 'desc') direction = 'DESCENDING';
      return { field: { fieldPath: o.fieldPath }, direction };
    });
  }
  if (typeof spec.limitCount === 'number') sq.limit = spec.limitCount;
  const result: { parent: string; structuredQuery: Record<string, unknown>; limitType?: 'FIRST' | 'LAST' } = {
    parent,
    structuredQuery: sq,
  };
  if (spec.limitType !== undefined) result.limitType = spec.limitType;
  return result;
}

export function encodeDocumentSnapshotJson(
  projectId: string,
  path: string,
  exists: boolean,
  data: Record<string, unknown> | undefined,
  databaseId?: string,
): SerializedSnapshotEnvelope {
  if (!exists || data === undefined) {
    return { type: 'firestore/documentSnapshot/1.0', bundle: '', bundleSource: 'DocumentSnapshot', bundleName: path };
  }
  const normalizedDb = normalizeFirestoreDatabaseId(databaseId);
  const docName = `projects/${projectId}/databases/${normalizedDb}/documents/${path}`;
  const body = encodeBundleElements([
    { documentMetadata: { name: docName, readTime: SNAPSHOT_BUNDLE_TS, exists: true } },
    { document: { name: docName, fields: encodeRestFields(data, projectId, normalizedDb), updateTime: SNAPSHOT_BUNDLE_TS, createTime: SNAPSHOT_BUNDLE_TS } },
  ]);
  const totalBytes = new TextEncoder().encode(body).byteLength;
  const header = encodeBundleElements([
    { metadata: { id: nextBundleId(), createTime: SNAPSHOT_BUNDLE_TS, version: 1, totalDocuments: 1, totalBytes } },
  ]);
  return { type: 'firestore/documentSnapshot/1.0', bundle: header + body, bundleSource: 'DocumentSnapshot', bundleName: path };
}

export function encodeQuerySnapshotJson(
  projectId: string,
  spec: BundledQuerySourceSpec,
  docs: ReadonlyArray<{ readonly path: string; readonly data: Record<string, unknown> }>,
  databaseId?: string,
): SerializedSnapshotEnvelope {
  const bundleName = nextBundleId();
  const normalizedDb = normalizeFirestoreDatabaseId(databaseId);
  const rootParent = `projects/${projectId}/databases/${normalizedDb}/documents`;
  const bodyElements: unknown[] = [
    { namedQuery: { name: bundleName, bundledQuery: encodeStructuredQuery(rootParent, spec, projectId, normalizedDb), readTime: SNAPSHOT_BUNDLE_TS } },
  ];
  for (const docEntry of docs) {
    const docName = `${rootParent}/${docEntry.path}`;
    bodyElements.push({ documentMetadata: { name: docName, readTime: SNAPSHOT_BUNDLE_TS, exists: true, queries: [bundleName] } });
    bodyElements.push({ document: { name: docName, fields: encodeRestFields(docEntry.data, projectId, normalizedDb), updateTime: SNAPSHOT_BUNDLE_TS, createTime: SNAPSHOT_BUNDLE_TS } });
  }
  const body = encodeBundleElements(bodyElements);
  const totalBytes = new TextEncoder().encode(body).byteLength;
  const header = encodeBundleElements([
    { metadata: { id: bundleName, createTime: SNAPSHOT_BUNDLE_TS, version: 1, totalDocuments: docs.length, totalBytes } },
  ]);
  return { type: 'firestore/querySnapshot/1.0', bundle: header + body, bundleSource: 'QuerySnapshot', bundleName };
}
