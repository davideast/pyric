/**
 * `pyric/firestore` -- length-prefixed JSON bundle wire decoder and shared
 * bundle AST types consumed by `loadBundle`, `namedQuery`, and SSR hydration.
 */
import { Reference as RulesReference } from 'pyric/rules/internal';
import { Bytes, GeoPoint, Timestamp } from '../field-values.js';

export type BundledWhereOp = '==' | '!=' | '<' | '<=' | '>' | '>=' | 'array-contains' | 'in' | 'array-contains-any' | 'not-in';

export type BundledFilterSpec =
  | { readonly kind: 'where'; readonly fieldPath: string; readonly op: BundledWhereOp; readonly value: unknown }
  | { readonly kind: 'and' | 'or'; readonly filters: readonly BundledFilterSpec[] };

export interface BundledQuerySourceSpec {
  readonly collectionPath: string;
  readonly isCollectionGroup: boolean;
  readonly filters: readonly BundledFilterSpec[];
  readonly orders: ReadonlyArray<{ readonly fieldPath: string; readonly direction: 'asc' | 'desc' }>;
  readonly limitCount?: number;
  readonly limitType?: 'FIRST' | 'LAST';
}
interface BundledNamedQueryEntry extends BundledQuerySourceSpec {
  readonly name: string;
  readonly databaseId?: string;
}
interface BundledDocumentEntry {
  readonly docPath: string;
  readonly databaseId?: string;
  readonly exists: boolean;
  readonly data?: Record<string, unknown>;
  readonly queries: readonly string[];
  readonly bytesLoadedAfterDoc: number;
}
export interface ParsedBundle {
  readonly id: string;
  readonly totalDocuments: number;
  readonly totalBytes: number;
  readonly namedQueries: readonly BundledNamedQueryEntry[];
  readonly documents: readonly BundledDocumentEntry[];
}

const REST_TO_WHERE_OP: Record<string, BundledWhereOp> = {
  EQUAL: '==', NOT_EQUAL: '!=', LESS_THAN: '<', LESS_THAN_OR_EQUAL: '<=',
  GREATER_THAN: '>', GREATER_THAN_OR_EQUAL: '>=', ARRAY_CONTAINS: 'array-contains',
  IN: 'in', ARRAY_CONTAINS_ANY: 'array-contains-any', NOT_IN: 'not-in',
};

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

function resourceDatabaseId(resourceName: string): string | undefined {
  const match = RESOURCE_DB_PATTERN.exec(resourceName);
  if (match === null) return undefined;
  return match[2];
}

function decodeRestValue(raw: Record<string, unknown>): unknown {
  if ('nullValue' in raw) return null;
  if (typeof raw.booleanValue === 'boolean') return raw.booleanValue;
  if (typeof raw.stringValue === 'string') return raw.stringValue;
  if (typeof raw.integerValue === 'string' || typeof raw.integerValue === 'number') return Number(raw.integerValue);
  if (typeof raw.doubleValue === 'number' || typeof raw.doubleValue === 'string') return Number(raw.doubleValue);
  if (typeof raw.timestampValue === 'string') return Timestamp.fromDate(new Date(raw.timestampValue));
  if (typeof raw.bytesValue === 'string') return Bytes.fromBase64String(raw.bytesValue);
  if (typeof raw.referenceValue === 'string') {
    const relPath = relativeDocPath(raw.referenceValue);
    const refDb = resourceDatabaseId(raw.referenceValue);
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
    return decodeRestFields(mapFields);
  }
  return null;
}

function decodeRestFields(fields: Record<string, Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) out[k] = decodeRestValue(v);
  return out;
}

function decodeStructuredFilter(whereNode: Record<string, unknown>): BundledFilterSpec | null {
  if (whereNode.fieldFilter && typeof whereNode.fieldFilter === 'object') {
    const ff = whereNode.fieldFilter as { field?: { fieldPath?: string }; op?: string; value?: Record<string, unknown> };
    const opKey = ff.op ?? '';
    const valNode = ff.value ?? {};
    return { kind: 'where', fieldPath: ff.field?.fieldPath ?? '', op: REST_TO_WHERE_OP[opKey] ?? '==', value: decodeRestValue(valNode) };
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

function parseNamedQueryElement(nq: { name?: string; bundledQuery?: Record<string, unknown> }): BundledNamedQueryEntry {
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
  const orders = rawOrders.map((o) => {
    let direction: 'asc' | 'desc' = 'asc';
    if (o.direction === 'DESCENDING') direction = 'desc';
    return { fieldPath: o.field?.fieldPath ?? '__name__', direction };
  });
  let limitCount: number | undefined;
  if (typeof sq.limit === 'number') limitCount = sq.limit;
  else if (sq.limit && typeof (sq.limit as { value?: unknown }).value === 'number') limitCount = (sq.limit as { value: number }).value;
  let limitType: 'FIRST' | 'LAST' = 'FIRST';
  if (bq.limitType === 'LAST') limitType = 'LAST';
  let queryName = '';
  if (typeof nq.name === 'string') queryName = nq.name;
  const databaseId = resourceDatabaseId(rawParent);
  const entry: {
    name: string;
    databaseId?: string;
    collectionPath: string;
    isCollectionGroup: boolean;
    filters: BundledFilterSpec[];
    orders: Array<{ fieldPath: string; direction: 'asc' | 'desc' }>;
    limitCount?: number;
    limitType: 'FIRST' | 'LAST';
  } = {
    name: queryName,
    collectionPath,
    isCollectionGroup: from0.allDescendants === true,
    filters,
    orders,
    limitCount,
    limitType,
  };
  if (databaseId !== undefined) {
    entry.databaseId = databaseId;
  }
  return entry;
}
export function decodeBundleBytes(bytes: Uint8Array): ParsedBundle {
  if (bytes.byteLength === 0) throw new Error('Bundle payload is empty.');
  const dec = new TextDecoder('utf-8', { fatal: false });
  const rawElements: Array<{ value: Record<string, unknown>; endOffset: number }> = [];
  let offset = 0;
  while (offset < bytes.byteLength) {
    let digitEnd = offset;
    while (digitEnd < bytes.byteLength && (bytes[digitEnd] ?? 0) >= 48 && (bytes[digitEnd] ?? 0) <= 57) digitEnd += 1;
    if (digitEnd === offset) throw new Error('Malformed bundle length prefix.');
    const len = Number(dec.decode(bytes.subarray(offset, digitEnd)));
    if (!Number.isSafeInteger(len) || len <= 0 || digitEnd + len > bytes.byteLength) throw new Error('Malformed bundle element length.');
    const parsed = JSON.parse(dec.decode(bytes.subarray(digitEnd, digitEnd + len))) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Malformed bundle JSON element.');
    offset = digitEnd + len;
    rawElements.push({ value: parsed as Record<string, unknown>, endOffset: offset });
  }
  const first = rawElements[0];
  if (first === undefined || !first.value.metadata || typeof first.value.metadata !== 'object') {
    throw new Error('Bundle is missing leading metadata element.');
  }
  const meta = first.value.metadata as { id?: unknown; totalDocuments?: unknown; totalBytes?: unknown };
  const headerBytes = first.endOffset;
  const namedQueries: BundledNamedQueryEntry[] = [];
  const documents: BundledDocumentEntry[] = [];
  let idx = 1;
  while (idx < rawElements.length) {
    const current = rawElements[idx];
    if (current === undefined) break;
    if (current.value.namedQuery && typeof current.value.namedQuery === 'object') {
      namedQueries.push(parseNamedQueryElement(current.value.namedQuery as { name?: string; bundledQuery?: Record<string, unknown> }));
      idx += 1;
    } else if (current.value.documentMetadata && typeof current.value.documentMetadata === 'object') {
      const dm = current.value.documentMetadata as { name?: string; exists?: boolean; queries?: string[] };
      let rawDocName = '';
      if (typeof dm.name === 'string') rawDocName = dm.name;
      const docPath = relativeDocPath(rawDocName);
      let databaseId = resourceDatabaseId(rawDocName);
      let queries: string[] = [];
      if (Array.isArray(dm.queries)) queries = dm.queries.map(String);
      if (dm.exists === true) {
        const next = rawElements[idx + 1];
        if (next === undefined || !next.value.document || typeof next.value.document !== 'object') throw new Error(`Missing document payload for ${docPath}.`);
        const rawDoc = next.value.document as { name?: string; fields?: Record<string, Record<string, unknown>> };
        if (databaseId === undefined && typeof rawDoc.name === 'string') {
          databaseId = resourceDatabaseId(rawDoc.name);
        }
        const docFields = rawDoc.fields ?? {};
        const docEntry: {
          docPath: string;
          databaseId?: string;
          exists: true;
          data: Record<string, unknown>;
          queries: string[];
          bytesLoadedAfterDoc: number;
        } = {
          docPath,
          exists: true,
          data: decodeRestFields(docFields),
          queries,
          bytesLoadedAfterDoc: next.endOffset - headerBytes,
        };
        if (databaseId !== undefined) {
          docEntry.databaseId = databaseId;
        }
        documents.push(docEntry);
        idx += 2;
      } else {
        const docEntry: {
          docPath: string;
          databaseId?: string;
          exists: false;
          queries: string[];
          bytesLoadedAfterDoc: number;
        } = {
          docPath,
          exists: false,
          queries,
          bytesLoadedAfterDoc: current.endOffset - headerBytes,
        };
        if (databaseId !== undefined) {
          docEntry.databaseId = databaseId;
        }
        documents.push(docEntry);
        idx += 1;
      }
    } else {
      throw new Error('Unexpected bundle element.');
    }
  }
  let id = 'bundle'; if (typeof meta.id === 'string') id = meta.id;
  let totalDocuments = documents.length; if (typeof meta.totalDocuments === 'number') totalDocuments = meta.totalDocuments;
  let totalBytes = offset - headerBytes; if (typeof meta.totalBytes === 'number') totalBytes = meta.totalBytes;
  return { id, totalDocuments, totalBytes, namedQueries, documents };
}
