/**
 * `pyric/firestore` -- SSR snapshot `toJSON()` envelope encoder producing
 * `firebase/firestore@12.19.0`-compatible `firestore/documentSnapshot/1.0` and
 * `firestore/querySnapshot/1.0` bundle envelopes.
 */
import { Bytes, GeoPoint, Timestamp } from '../field-values.js';
import { refToTarget } from '../state.js';
import { VectorValue } from '../vector-value.js';
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
  '==': 'EQUAL',
  '!=': 'NOT_EQUAL',
  '<': 'LESS_THAN',
  '<=': 'LESS_THAN_OR_EQUAL',
  '>': 'GREATER_THAN',
  '>=': 'GREATER_THAN_OR_EQUAL',
  'array-contains': 'ARRAY_CONTAINS',
  in: 'IN',
  'array-contains-any': 'ARRAY_CONTAINS_ANY',
  'not-in': 'NOT_IN',
};

const SIMPLE_FIELD_SEGMENT_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

let bundleCounter = 0;
let lastTimestampSeconds = 0;
let lastTimestampNanos = 0;

function nextBundleId(): string {
  bundleCounter += 1;
  return `pyricBundle${String(bundleCounter).padStart(9, '0')}`;
}

function formatProtoTimestampIso(seconds: number, nanoseconds: number): string {
  const jsIso = new Date(seconds * 1000).toISOString();
  const prefix = jsIso.replace(/\.\d*Z$/, '');
  const nanoStr = String(nanoseconds).padStart(9, '0');
  return `${prefix}.${nanoStr}Z`;
}

function nextBundleTimestampIso(): string {
  const nowMs = Date.now();
  let seconds = Math.floor(nowMs / 1000);
  let nanos = (nowMs - seconds * 1000) * 1_000_000;
  if (seconds < lastTimestampSeconds || (seconds === lastTimestampSeconds && nanos <= lastTimestampNanos)) {
    seconds = lastTimestampSeconds;
    nanos = lastTimestampNanos + 1;
    if (nanos >= 1_000_000_000) {
      seconds += 1;
      nanos = 0;
    }
  }
  lastTimestampSeconds = seconds;
  lastTimestampNanos = nanos;
  return formatProtoTimestampIso(seconds, nanos);
}

function encodeServerFieldSegment(segment: string): string {
  if (segment === '__name__' || SIMPLE_FIELD_SEGMENT_PATTERN.test(segment)) {
    return segment;
  }
  const escaped = segment.replace(/\\/g, '\\\\').replace(/`/g, '\\`');
  return `\`${escaped}\``;
}

function encodeServerFieldPath(fieldPath: string, fieldSegments?: readonly string[]): string {
  if (fieldSegments !== undefined && fieldSegments.length > 0) {
    return fieldSegments.map(encodeServerFieldSegment).join('.');
  }
  return fieldPath;
}

function encodeDoubleProto(val: number): Record<string, unknown> {
  if (Number.isNaN(val)) return { doubleValue: 'NaN' };
  if (val === Infinity) return { doubleValue: 'Infinity' };
  if (val === -Infinity) return { doubleValue: '-Infinity' };
  if (Object.is(val, -0)) return { doubleValue: '-0' };
  return { doubleValue: val };
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
    if (!Object.is(val, -0) && Number.isSafeInteger(val)) {
      return { integerValue: String(val) };
    }
    return encodeDoubleProto(val);
  }
  if (val instanceof Timestamp) {
    return { timestampValue: formatProtoTimestampIso(val.seconds, val.nanoseconds) };
  }
  if (val instanceof Bytes) return { bytesValue: val.toBase64() };
  if (val instanceof GeoPoint) {
    return { geoPointValue: { latitude: val.latitude, longitude: val.longitude } };
  }
  if (val instanceof VectorValue) {
    return {
      mapValue: {
        fields: {
          __type__: { stringValue: '__vector__' },
          value: {
            arrayValue: {
              values: val.toArray().map((entry) => encodeDoubleProto(entry)),
            },
          },
        },
      },
    };
  }
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
      let rawDb = databaseId;
      if (targetDb !== undefined) {
        rawDb = targetDb;
      } else if (duckDb !== undefined) {
        rawDb = duckDb;
      }
      const refDb = normalizeFirestoreDatabaseId(rawDb);
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
    const serverField = encodeServerFieldPath(filter.fieldPath, filter.fieldSegments);
    if (filter.op === '==') {
      if (filter.value === null) {
        return { unaryFilter: { field: { fieldPath: serverField }, op: 'IS_NULL' } };
      }
      if (typeof filter.value === 'number' && Number.isNaN(filter.value)) {
        return { unaryFilter: { field: { fieldPath: serverField }, op: 'IS_NAN' } };
      }
    } else if (filter.op === '!=') {
      if (filter.value === null) {
        return { unaryFilter: { field: { fieldPath: serverField }, op: 'IS_NOT_NULL' } };
      }
      if (typeof filter.value === 'number' && Number.isNaN(filter.value)) {
        return { unaryFilter: { field: { fieldPath: serverField }, op: 'IS_NOT_NAN' } };
      }
    }
    return {
      fieldFilter: {
        field: { fieldPath: serverField },
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
      return {
        field: { fieldPath: encodeServerFieldPath(o.fieldPath, o.fieldSegments) },
        direction,
      };
    });
  }
  if (typeof spec.limitCount === 'number') sq.limit = spec.limitCount;
  if (spec.startAt !== undefined) {
    sq.startAt = {
      before: spec.startAt.inclusive,
      values: spec.startAt.values.map((v) => encodeRestValue(v, projectId, databaseId)),
    };
  }
  if (spec.endAt !== undefined) {
    sq.endAt = {
      before: !spec.endAt.inclusive,
      values: spec.endAt.values.map((v) => encodeRestValue(v, projectId, databaseId)),
    };
  }
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
    return {
      type: 'firestore/documentSnapshot/1.0',
      bundle: '',
      bundleSource: 'DocumentSnapshot',
      bundleName: path,
    };
  }
  const stamp = nextBundleTimestampIso();
  const normalizedDb = normalizeFirestoreDatabaseId(databaseId);
  const docName = `projects/${projectId}/databases/${normalizedDb}/documents/${path}`;
  const body = encodeBundleElements([
    { documentMetadata: { name: docName, readTime: stamp, exists: true } },
    {
      document: {
        name: docName,
        fields: encodeRestFields(data, projectId, normalizedDb),
        updateTime: stamp,
        createTime: stamp,
      },
    },
  ]);
  const totalBytes = new TextEncoder().encode(body).byteLength;
  const header = encodeBundleElements([
    { metadata: { id: nextBundleId(), createTime: stamp, version: 1, totalDocuments: 1, totalBytes } },
  ]);
  return {
    type: 'firestore/documentSnapshot/1.0',
    bundle: header + body,
    bundleSource: 'DocumentSnapshot',
    bundleName: path,
  };
}

export function encodeQuerySnapshotJson(
  projectId: string,
  spec: BundledQuerySourceSpec,
  docs: ReadonlyArray<{ readonly path: string; readonly data: Record<string, unknown> }>,
  databaseId?: string,
): SerializedSnapshotEnvelope {
  const bundleName = nextBundleId();
  const stamp = nextBundleTimestampIso();
  const normalizedDb = normalizeFirestoreDatabaseId(databaseId);
  const rootParent = `projects/${projectId}/databases/${normalizedDb}/documents`;
  const bodyElements: unknown[] = [
    {
      namedQuery: {
        name: bundleName,
        bundledQuery: encodeStructuredQuery(rootParent, spec, projectId, normalizedDb),
        readTime: stamp,
      },
    },
  ];
  for (const docEntry of docs) {
    const docName = `${rootParent}/${docEntry.path}`;
    bodyElements.push({
      documentMetadata: { name: docName, readTime: stamp, exists: true, queries: [bundleName] },
    });
    bodyElements.push({
      document: {
        name: docName,
        fields: encodeRestFields(docEntry.data, projectId, normalizedDb),
        updateTime: stamp,
        createTime: stamp,
      },
    });
  }
  const body = encodeBundleElements(bodyElements);
  const totalBytes = new TextEncoder().encode(body).byteLength;
  const header = encodeBundleElements([
    { metadata: { id: bundleName, createTime: stamp, version: 1, totalDocuments: docs.length, totalBytes } },
  ]);
  return {
    type: 'firestore/querySnapshot/1.0',
    bundle: header + body,
    bundleSource: 'QuerySnapshot',
    bundleName,
  };
}
