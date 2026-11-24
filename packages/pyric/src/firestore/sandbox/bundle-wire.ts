/**
 * `pyric/firestore` -- length-prefixed JSON bundle wire decoder and shared
 * bundle AST types consumed by `loadBundle`, `namedQuery`, and SSR hydration.
 */
import { Reference as RulesReference } from 'pyric/rules/internal';
import { FirebaseError } from '../../sandbox/internal/firebase-error.js';
import { Bytes, GeoPoint, Timestamp } from '../field-values.js';
import { isValidTimestampComponents } from '../timestamp.js';
import { VectorValue } from '../vector-value.js';

export type BundledWhereOp =
  | '=='
  | '!='
  | '<'
  | '<='
  | '>'
  | '>='
  | 'array-contains'
  | 'in'
  | 'array-contains-any'
  | 'not-in';

export type BundledFilterSpec =
  | {
      readonly kind: 'where';
      readonly fieldPath: string;
      readonly fieldSegments?: readonly string[];
      readonly op: BundledWhereOp;
      readonly value: unknown;
    }
  | { readonly kind: 'and' | 'or'; readonly filters: readonly BundledFilterSpec[] };

export interface BundledCursorSpec {
  readonly inclusive: boolean;
  readonly values: readonly unknown[];
}

export interface BundledQueryOrderSpec {
  readonly fieldPath: string;
  readonly fieldSegments?: readonly string[];
  readonly direction: 'asc' | 'desc';
}

export interface BundledQuerySourceSpec {
  readonly collectionPath: string;
  readonly isCollectionGroup: boolean;
  readonly filters: readonly BundledFilterSpec[];
  readonly orders: readonly BundledQueryOrderSpec[];
  readonly limitCount?: number;
  readonly limitType?: 'FIRST' | 'LAST';
  readonly startAt?: BundledCursorSpec;
  readonly endAt?: BundledCursorSpec;
}

interface BundledNamedQueryEntry extends BundledQuerySourceSpec {
  readonly name: string;
  readonly databaseId?: string;
  readonly readTime?: Timestamp;
}

interface BundledDocumentEntry {
  readonly docPath: string;
  readonly projectId?: string;
  readonly databaseId?: string;
  readonly exists: boolean;
  readonly data?: Record<string, unknown>;
  readonly queries: readonly string[];
  readonly bytesLoadedAfterDoc: number;
  readonly readTime?: Timestamp;
  readonly updateTime?: Timestamp;
}

export interface ParsedBundle {
  readonly id: string;
  readonly createTime?: Timestamp;
  readonly totalDocuments: number;
  readonly totalBytes: number;
  readonly namedQueries: readonly BundledNamedQueryEntry[];
  readonly documents: readonly BundledDocumentEntry[];
}

const REST_TO_WHERE_OP: Record<string, BundledWhereOp> = {
  EQUAL: '==',
  NOT_EQUAL: '!=',
  LESS_THAN: '<',
  LESS_THAN_OR_EQUAL: '<=',
  GREATER_THAN: '>',
  GREATER_THAN_OR_EQUAL: '>=',
  ARRAY_CONTAINS: 'array-contains',
  IN: 'in',
  ARRAY_CONTAINS_ANY: 'array-contains-any',
  NOT_IN: 'not-in',
};

const ISO_FRACTION_PATTERN = /\.(\d{1,9})(?=(?:Z|[+-]\d{2}:\d{2})$)/;

export function encodeBundleElements(elements: readonly unknown[]): string {
  const enc = new TextEncoder();
  let out = '';
  for (const el of elements) {
    const json = JSON.stringify(el);
    out += `${enc.encode(json).byteLength}${json}`;
  }
  return out;
}

function relativeDocPath(resourceName: string): string {
  const marker = '/documents/';
  const idx = resourceName.indexOf(marker);
  if (idx === -1) return resourceName.replace(/^\/+/, '');
  return resourceName.slice(idx + marker.length);
}

const RESOURCE_DB_PATTERN = /^projects\/([^/]+)\/databases\/([^/]+)\/documents(?:\/|$)/;

function parseResourceIds(resourceName: string): { projectId?: string; databaseId?: string } {
  const match = RESOURCE_DB_PATTERN.exec(resourceName);
  if (match === null) return {};
  return { projectId: match[1], databaseId: match[2] };
}

function parseNumericField(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string' && raw.length > 0) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export function parseBundleTimestamp(raw: unknown): Timestamp | undefined {
  if (typeof raw === 'string') {
    if (raw.length === 0) return undefined;
    let nanos = 0;
    const fractionMatch = ISO_FRACTION_PATTERN.exec(raw);
    let wholeIso = raw;
    if (fractionMatch !== null && fractionMatch[1] !== undefined) {
      const padded = `${fractionMatch[1]}000000000`.slice(0, 9);
      nanos = Number(padded);
      wholeIso = raw.replace(ISO_FRACTION_PATTERN, '');
    }
    const parsedMs = Date.parse(wholeIso);
    if (Number.isNaN(parsedMs)) return undefined;
    const seconds = Math.floor(parsedMs / 1000);
    if (!isValidTimestampComponents(seconds, nanos)) return undefined;
    return new Timestamp(seconds, nanos);
  }
  if (raw !== null && typeof raw === 'object') {
    const rec = raw as { seconds?: unknown; nanos?: unknown };
    let seconds = 0;
    if (rec.seconds !== undefined) {
      const parsedSeconds = parseNumericField(rec.seconds);
      if (parsedSeconds === undefined) return undefined;
      seconds = Math.trunc(parsedSeconds);
    }
    let nanos = 0;
    if (rec.nanos !== undefined) {
      const parsedNanos = parseNumericField(rec.nanos);
      if (parsedNanos === undefined) return undefined;
      nanos = Math.trunc(parsedNanos);
    }
    if (!isValidTimestampComponents(seconds, nanos)) return undefined;
    return new Timestamp(seconds, nanos);
  }
  return undefined;
}

export function parseServerFieldPathSegments(path: string): readonly string[] {
  if (path.length === 0) return [];
  const segments: string[] = [];
  let current = '';
  let index = 0;
  let inBackticks = false;
  while (index < path.length) {
    const ch = path[index];
    if (ch === '\\') {
      if (index + 1 >= path.length) {
        throw new FirebaseError('invalid-argument', `Path has trailing escape character: ${path}`);
      }
      const next = path[index + 1];
      if (next !== '\\' && next !== '.' && next !== '`') {
        throw new FirebaseError('invalid-argument', `Path has invalid escape sequence: ${path}`);
      }
      current += next;
      index += 2;
    } else if (ch === '`') {
      inBackticks = !inBackticks;
      index += 1;
    } else if (ch === '.' && !inBackticks) {
      if (current.length === 0) {
        throw new FirebaseError('invalid-argument', `Invalid field path (${path}).`);
      }
      segments.push(current);
      current = '';
      index += 1;
    } else {
      current += ch;
      index += 1;
    }
  }
  if (inBackticks || current.length === 0) {
    throw new FirebaseError('invalid-argument', `Invalid field path (${path}).`);
  }
  segments.push(current);
  return segments;
}

function decodeDoubleValue(rawDouble: unknown): number {
  if (rawDouble === '-0') return -0;
  if (rawDouble === 'NaN') return Number.NaN;
  if (rawDouble === 'Infinity') return Infinity;
  if (rawDouble === '-Infinity') return -Infinity;
  return Number(rawDouble);
}

function tryDecodeVectorMap(fields: Record<string, Record<string, unknown>>): VectorValue | null {
  const marker = fields.__type__;
  if (marker === undefined || marker.stringValue !== '__vector__') return null;
  const valueEntry = fields.value;
  if (valueEntry === undefined || valueEntry.arrayValue === null || typeof valueEntry.arrayValue !== 'object') {
    return null;
  }
  const rawValues = (valueEntry.arrayValue as { values?: Array<Record<string, unknown>> }).values ?? [];
  const numbers: number[] = [];
  for (const item of rawValues) {
    const decoded = decodeRestValue(item);
    if (typeof decoded !== 'number') return null;
    numbers.push(decoded);
  }
  return VectorValue.create(numbers);
}

function decodeRestValue(raw: Record<string, unknown>): unknown {
  if ('nullValue' in raw) return null;
  if (typeof raw.booleanValue === 'boolean') return raw.booleanValue;
  if (typeof raw.stringValue === 'string') return raw.stringValue;
  if (typeof raw.integerValue === 'string' || typeof raw.integerValue === 'number') {
    return Number(raw.integerValue);
  }
  if (typeof raw.doubleValue === 'number' || typeof raw.doubleValue === 'string') {
    return decodeDoubleValue(raw.doubleValue);
  }
  if ('timestampValue' in raw && raw.timestampValue !== undefined) {
    const parsedTs = parseBundleTimestamp(raw.timestampValue);
    if (parsedTs !== undefined) return parsedTs;
  }
  if (typeof raw.bytesValue === 'string') return Bytes.fromBase64String(raw.bytesValue);
  if (typeof raw.referenceValue === 'string') {
    const relPath = relativeDocPath(raw.referenceValue);
    const refDb = parseResourceIds(raw.referenceValue).databaseId;
    return new RulesReference(relPath, refDb);
  }
  if (raw.geoPointValue && typeof raw.geoPointValue === 'object') {
    const gp = raw.geoPointValue as { latitude?: number; longitude?: number };
    const lat = gp.latitude ?? 0;
    const lng = gp.longitude ?? 0;
    return new GeoPoint(Number(lat), Number(lng));
  }
  if (raw.arrayValue && typeof raw.arrayValue === 'object') {
    const items = (raw.arrayValue as { values?: Array<Record<string, unknown>> }).values ?? [];
    return items.map(decodeRestValue);
  }
  if (raw.mapValue && typeof raw.mapValue === 'object') {
    const mapFields = (raw.mapValue as { fields?: Record<string, Record<string, unknown>> }).fields ?? {};
    const vectorVal = tryDecodeVectorMap(mapFields);
    if (vectorVal !== null) return vectorVal;
    return decodeRestFields(mapFields);
  }
  return null;
}

function decodeRestFields(fields: Record<string, Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    Object.defineProperty(out, k, {
      value: decodeRestValue(v),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

function decodeUnaryFilter(uf: { field?: { fieldPath?: string }; op?: string }): BundledFilterSpec | null {
  const rawField = uf.field?.fieldPath ?? '';
  const fieldSegments = parseServerFieldPathSegments(rawField);
  if (uf.op === 'IS_NULL') {
    return { kind: 'where', fieldPath: rawField, fieldSegments, op: '==', value: null };
  }
  if (uf.op === 'IS_NOT_NULL') {
    return { kind: 'where', fieldPath: rawField, fieldSegments, op: '!=', value: null };
  }
  if (uf.op === 'IS_NAN') {
    return { kind: 'where', fieldPath: rawField, fieldSegments, op: '==', value: Number.NaN };
  }
  if (uf.op === 'IS_NOT_NAN') {
    return { kind: 'where', fieldPath: rawField, fieldSegments, op: '!=', value: Number.NaN };
  }
  return null;
}

function decodeStructuredFilter(whereNode: Record<string, unknown>): BundledFilterSpec | null {
  if (whereNode.unaryFilter && typeof whereNode.unaryFilter === 'object') {
    return decodeUnaryFilter(whereNode.unaryFilter as { field?: { fieldPath?: string }; op?: string });
  }
  if (whereNode.fieldFilter && typeof whereNode.fieldFilter === 'object') {
    const ff = whereNode.fieldFilter as {
      field?: { fieldPath?: string };
      op?: string;
      value?: Record<string, unknown>;
    };
    const rawField = ff.field?.fieldPath ?? '';
    const opKey = ff.op ?? '';
    const valNode = ff.value ?? {};
    return {
      kind: 'where',
      fieldPath: rawField,
      fieldSegments: parseServerFieldPathSegments(rawField),
      op: REST_TO_WHERE_OP[opKey] ?? '==',
      value: decodeRestValue(valNode),
    };
  }
  if (whereNode.compositeFilter && typeof whereNode.compositeFilter === 'object') {
    const cf = whereNode.compositeFilter as { op?: string; filters?: Array<Record<string, unknown>> };
    const rawList = cf.filters ?? [];
    const sub = rawList.map(decodeStructuredFilter).filter((x): x is BundledFilterSpec => x !== null);
    let kind: 'and' | 'or' = 'and';
    if (cf.op === 'OR') kind = 'or';
    return { kind, filters: sub };
  }
  return null;
}

function decodeStructuredCursor(
  cursorNode: unknown,
  isStart: boolean,
): BundledCursorSpec | undefined {
  if (cursorNode === null || typeof cursorNode !== 'object') return undefined;
  const rec = cursorNode as { before?: unknown; values?: Array<Record<string, unknown>> };
  const rawValues = Array.isArray(rec.values) ? rec.values : [];
  const beforeFlag = rec.before === true;
  let inclusive = !beforeFlag;
  if (isStart) inclusive = beforeFlag;
  return {
    inclusive,
    values: rawValues.map(decodeRestValue),
  };
}

function parseNamedQueryElement(nq: {
  name?: string;
  readTime?: unknown;
  bundledQuery?: Record<string, unknown>;
}): BundledNamedQueryEntry {
  const bq = nq.bundledQuery ?? {};
  const sq = (bq.structuredQuery as Record<string, unknown> | undefined) ?? {};
  const from0 = ((sq.from as Array<{ collectionId?: string; allDescendants?: boolean }> | undefined) ?? [])[0] ?? {};
  let rawParent = '';
  if (typeof bq.parent === 'string') rawParent = bq.parent;
  const parentRel = relativeDocPath(rawParent);
  let collId = '';
  if (typeof from0.collectionId === 'string') collId = from0.collectionId;
  let collectionPath = collId;
  if (parentRel.length > 0 && parentRel !== rawParent) collectionPath = `${parentRel}/${collId}`;
  const filters: BundledFilterSpec[] = [];
  if (sq.where && typeof sq.where === 'object') {
    const parsedFilter = decodeStructuredFilter(sq.where as Record<string, unknown>);
    if (parsedFilter !== null) filters.push(parsedFilter);
  }
  const rawOrders = (sq.orderBy as Array<{ field?: { fieldPath?: string }; direction?: string }> | undefined) ?? [];
  const orders: BundledQueryOrderSpec[] = rawOrders.map((o) => {
    let direction: 'asc' | 'desc' = 'asc';
    if (o.direction === 'DESCENDING') direction = 'desc';
    const rawField = o.field?.fieldPath ?? '__name__';
    return {
      fieldPath: rawField,
      fieldSegments: parseServerFieldPathSegments(rawField),
      direction,
    };
  });
  let limitCount: number | undefined;
  if (typeof sq.limit === 'number') {
    limitCount = sq.limit;
  } else if (sq.limit && typeof (sq.limit as { value?: unknown }).value === 'number') {
    limitCount = (sq.limit as { value: number }).value;
  }
  let limitType: 'FIRST' | 'LAST' = 'FIRST';
  if (bq.limitType === 'LAST') limitType = 'LAST';
  let queryName = '';
  if (typeof nq.name === 'string') queryName = nq.name;
  const databaseId = parseResourceIds(rawParent).databaseId;
  const readTime = parseBundleTimestamp(nq.readTime);
  const startAt = decodeStructuredCursor(sq.startAt, true);
  const endAt = decodeStructuredCursor(sq.endAt, false);
  const entry: {
    name: string;
    databaseId?: string;
    readTime?: Timestamp;
    collectionPath: string;
    isCollectionGroup: boolean;
    filters: BundledFilterSpec[];
    orders: BundledQueryOrderSpec[];
    limitCount?: number;
    limitType: 'FIRST' | 'LAST';
    startAt?: BundledCursorSpec;
    endAt?: BundledCursorSpec;
  } = {
    name: queryName,
    collectionPath,
    isCollectionGroup: from0.allDescendants === true,
    filters,
    orders,
    limitCount,
    limitType,
  };
  if (databaseId !== undefined) entry.databaseId = databaseId;
  if (readTime !== undefined) entry.readTime = readTime;
  if (startAt !== undefined) entry.startAt = startAt;
  if (endAt !== undefined) entry.endAt = endAt;
  return entry;
}

export function decodeBundleBytes(bytes: Uint8Array): ParsedBundle {
  if (bytes.byteLength === 0) throw new Error('Bundle payload is empty.');
  const dec = new TextDecoder('utf-8', { fatal: false });
  const rawElements: Array<{ value: Record<string, unknown>; endOffset: number }> = [];
  let offset = 0;
  while (offset < bytes.byteLength) {
    let digitEnd = offset;
    while (digitEnd < bytes.byteLength && (bytes[digitEnd] ?? 0) >= 48 && (bytes[digitEnd] ?? 0) <= 57) {
      digitEnd += 1;
    }
    if (digitEnd === offset) throw new Error('Malformed bundle length prefix.');
    const len = Number(dec.decode(bytes.subarray(offset, digitEnd)));
    if (!Number.isSafeInteger(len) || len <= 0 || digitEnd + len > bytes.byteLength) {
      throw new Error('Malformed bundle element length.');
    }
    const parsed = JSON.parse(dec.decode(bytes.subarray(digitEnd, digitEnd + len))) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Malformed bundle JSON element.');
    }
    offset = digitEnd + len;
    rawElements.push({ value: parsed as Record<string, unknown>, endOffset: offset });
  }
  const first = rawElements[0];
  if (first === undefined || !first.value.metadata || typeof first.value.metadata !== 'object') {
    throw new Error('Bundle is missing leading metadata element.');
  }
  const meta = first.value.metadata as {
    id?: unknown;
    createTime?: unknown;
    totalDocuments?: unknown;
    totalBytes?: unknown;
  };
  const headerBytes = first.endOffset;
  const namedQueries: BundledNamedQueryEntry[] = [];
  const documents: BundledDocumentEntry[] = [];
  let idx = 1;
  while (idx < rawElements.length) {
    const current = rawElements[idx];
    if (current === undefined) break;
    if (current.value.namedQuery && typeof current.value.namedQuery === 'object') {
      namedQueries.push(
        parseNamedQueryElement(
          current.value.namedQuery as { name?: string; readTime?: unknown; bundledQuery?: Record<string, unknown> },
        ),
      );
      idx += 1;
    } else if (current.value.documentMetadata && typeof current.value.documentMetadata === 'object') {
      const dm = current.value.documentMetadata as {
        name?: string;
        readTime?: unknown;
        exists?: boolean;
        queries?: string[];
      };
      let rawDocName = '';
      if (typeof dm.name === 'string') rawDocName = dm.name;
      const docPath = relativeDocPath(rawDocName);
      const metaIds = parseResourceIds(rawDocName);
      let projectId = metaIds.projectId;
      let databaseId = metaIds.databaseId;
      const metaReadTime = parseBundleTimestamp(dm.readTime);
      let queries: string[] = [];
      if (Array.isArray(dm.queries)) queries = dm.queries.map(String);
      if (dm.exists === true) {
        const next = rawElements[idx + 1];
        if (next === undefined || !next.value.document || typeof next.value.document !== 'object') {
          throw new Error(`Missing document payload for ${docPath}.`);
        }
        const rawDoc = next.value.document as {
          name?: string;
          updateTime?: unknown;
          fields?: Record<string, Record<string, unknown>>;
        };
        if (typeof rawDoc.name === 'string') {
          const docIds = parseResourceIds(rawDoc.name);
          if (projectId === undefined) projectId = docIds.projectId;
          if (databaseId === undefined) databaseId = docIds.databaseId;
        }
        const docFields = rawDoc.fields ?? {};
        const docUpdateTime = parseBundleTimestamp(rawDoc.updateTime);
        const docEntry: {
          docPath: string;
          projectId?: string;
          databaseId?: string;
          exists: true;
          data: Record<string, unknown>;
          queries: string[];
          bytesLoadedAfterDoc: number;
          readTime?: Timestamp;
          updateTime?: Timestamp;
        } = {
          docPath,
          exists: true,
          data: decodeRestFields(docFields),
          queries,
          bytesLoadedAfterDoc: next.endOffset - headerBytes,
        };
        if (projectId !== undefined) docEntry.projectId = projectId;
        if (databaseId !== undefined) docEntry.databaseId = databaseId;
        if (metaReadTime !== undefined) docEntry.readTime = metaReadTime;
        if (docUpdateTime !== undefined) docEntry.updateTime = docUpdateTime;
        documents.push(docEntry);
        idx += 2;
      } else {
        const docEntry: {
          docPath: string;
          projectId?: string;
          databaseId?: string;
          exists: false;
          queries: string[];
          bytesLoadedAfterDoc: number;
          readTime?: Timestamp;
        } = {
          docPath,
          exists: false,
          queries,
          bytesLoadedAfterDoc: current.endOffset - headerBytes,
        };
        if (projectId !== undefined) docEntry.projectId = projectId;
        if (databaseId !== undefined) docEntry.databaseId = databaseId;
        if (metaReadTime !== undefined) docEntry.readTime = metaReadTime;
        documents.push(docEntry);
        idx += 1;
      }
    } else {
      throw new Error('Unexpected bundle element.');
    }
  }
  let id = 'bundle';
  if (typeof meta.id === 'string') id = meta.id;
  const createTime = parseBundleTimestamp(meta.createTime);
  let totalDocuments = documents.length;
  const parsedTotalDocs = parseNumericField(meta.totalDocuments);
  if (parsedTotalDocs !== undefined) totalDocuments = parsedTotalDocs;
  let totalBytes = offset - headerBytes;
  const parsedTotalBytes = parseNumericField(meta.totalBytes);
  if (parsedTotalBytes !== undefined) totalBytes = parsedTotalBytes;
  const result: {
    id: string;
    createTime?: Timestamp;
    totalDocuments: number;
    totalBytes: number;
    namedQueries: BundledNamedQueryEntry[];
    documents: BundledDocumentEntry[];
  } = { id, totalDocuments, totalBytes, namedQueries, documents };
  if (createTime !== undefined) result.createTime = createTime;
  return result;
}
