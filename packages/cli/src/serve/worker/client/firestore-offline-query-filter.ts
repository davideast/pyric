/**
 * Evaluates `QueryDescriptor` filter, ordering, cursor, and limit constraints
 * against candidate offline/warmed `RawDocResult` entries on the worker/hosted
 * client plane using the shared `executeQuery` engine.
 */
import {
  executeQuery,
  type QueryCursor,
  type QueryExecutionSpec,
  type QueryFilter,
  type QueryOrderClause,
  type QueryWhereFilterOp,
} from 'pyric/firestore/internal';
import { normalizeQueryOrders } from 'pyric/firestore/internal/implicit-order';
import { fieldPathKey } from 'pyric/firestore/internal/update-fields';
import {
  DOC_VALUE_ENCODING,
  decodeDocValue,
  type DocValueEncoding,
  type ReferenceDecoder,
} from 'pyric/firestore/internal/value-codec';
import type {
  CollRef,
  DocRef,
  FilterConstraintDescriptor,
  GroupRef,
  QueryConstraintDescriptor,
  QueryDescriptor,
  TargetDescriptor,
} from '../protocol.js';
import type { RawDocResult } from './snapshots.js';

const KEY_FIELD = '__name__';
const INEQUALITY_OPS = new Set(['<', '<=', '>', '>=', '!=', 'not-in']);

class OfflineQueryReference {
  readonly path: string;
  constructor(path: string) {
    this.path = path;
  }
}

export const OFFLINE_REF_DECODER: ReferenceDecoder = {
  create: (path: string) => new OfflineQueryReference(path),
};

function canonicalFieldKey(item: {
  readonly field: string;
  readonly fieldSegments?: readonly string[];
}): string {
  if (item.fieldSegments !== undefined) {
    return fieldPathKey(item.fieldSegments);
  }
  return fieldPathKey(item.field.split('.'));
}

function resolveFilterDescriptor(desc: FilterConstraintDescriptor): QueryFilter {
  if (desc.kind === 'where') {
    let encoding: DocValueEncoding = DOC_VALUE_ENCODING;
    if (desc.valueEncoding !== undefined) {
      encoding = desc.valueEncoding;
    }
    return {
      kind: 'where',
      field: canonicalFieldKey(desc),
      op: desc.op as QueryWhereFilterOp,
      value: decodeDocValue(desc.value, OFFLINE_REF_DECODER, encoding),
    };
  }
  return {
    kind: desc.kind,
    filters: desc.filters.map(resolveFilterDescriptor),
  };
}

function collectInequalityFields(filter: QueryFilter, out: string[]): void {
  if (filter.kind === 'where') {
    if (INEQUALITY_OPS.has(filter.op)) {
      out.push(filter.field);
    }
    return;
  }
  for (const child of filter.filters) {
    collectInequalityFields(child, out);
  }
}

function unwrapBaseSource(source: DocRef | CollRef | GroupRef | QueryDescriptor): DocRef | CollRef | GroupRef {
  if (source.__ref === 'query') {
    return unwrapBaseSource(source.source);
  }
  return source;
}

function flattenConstraints(target: TargetDescriptor, out: QueryConstraintDescriptor[]): void {
  if (target.__ref !== 'query') return;
  flattenConstraints(target.source, out);
  for (const c of target.constraints) {
    out.push(c);
  }
}

function normalizeCursorValues(
  rawValues: readonly unknown[],
  encoding: DocValueEncoding | undefined,
  normalizedOrders: readonly QueryOrderClause[],
  baseSource: DocRef | CollRef | GroupRef,
): unknown[] {
  let effectiveEncoding: DocValueEncoding = DOC_VALUE_ENCODING;
  if (encoding !== undefined) {
    effectiveEncoding = encoding;
  }
  return rawValues.map((rawVal, idx) => {
    const decoded = decodeDocValue(rawVal, OFFLINE_REF_DECODER, effectiveEncoding);
    const clause = normalizedOrders[idx];
    if (clause?.field !== KEY_FIELD) {
      return decoded;
    }
    if (decoded instanceof OfflineQueryReference) {
      return decoded;
    }
    if (typeof decoded === 'string') {
      if (decoded.includes('/')) {
        return new OfflineQueryReference(decoded);
      }
      if (baseSource.__ref === 'collection') {
        return new OfflineQueryReference(`${baseSource.path}/${decoded}`);
      }
      return new OfflineQueryReference(decoded);
    }
    return decoded;
  });
}

export function filterWorkerOfflineQueryDocs(
  target: TargetDescriptor,
  candidateDocs: readonly RawDocResult[],
): RawDocResult[] {
  if (target.__ref !== 'query' || candidateDocs.length === 0) {
    return [...candidateDocs];
  }
  const constraints: QueryConstraintDescriptor[] = [];
  flattenConstraints(target, constraints);
  if (constraints.length === 0) {
    return [...candidateDocs];
  }

  const filters: QueryFilter[] = [];
  const orders: QueryOrderClause[] = [];
  let limitCount: number | undefined;
  let limitFromEnd = false;
  let startDesc: Extract<QueryConstraintDescriptor, { kind: 'startAt' | 'startAfter' }> | undefined;
  let endDesc: Extract<QueryConstraintDescriptor, { kind: 'endAt' | 'endBefore' }> | undefined;

  for (const c of constraints) {
    if (c.kind === 'where' || c.kind === 'and' || c.kind === 'or') {
      filters.push(resolveFilterDescriptor(c));
    } else if (c.kind === 'orderBy') {
      let direction: 'asc' | 'desc' = 'asc';
      if (c.direction === 'desc') {
        direction = 'desc';
      }
      orders.push({ field: canonicalFieldKey(c), direction });
    } else if (c.kind === 'limit') {
      limitCount = c.n;
      limitFromEnd = false;
    } else if (c.kind === 'limitToLast') {
      limitCount = c.n;
      limitFromEnd = true;
    } else if (c.kind === 'startAt' || c.kind === 'startAfter') {
      startDesc = c;
    } else if (c.kind === 'endAt' || c.kind === 'endBefore') {
      endDesc = c;
    }
  }

  const ineqFields: string[] = [];
  for (const f of filters) {
    collectInequalityFields(f, ineqFields);
  }
  const normalizedOrders = normalizeQueryOrders(orders, ineqFields);
  const baseSource = unwrapBaseSource(target.source);

  let start: QueryCursor | undefined;
  if (startDesc !== undefined) {
    start = {
      values: normalizeCursorValues(startDesc.values, startDesc.valueEncoding, normalizedOrders, baseSource),
      inclusive: startDesc.kind === 'startAt',
      fromSnapshot: startDesc.fromSnapshot === true,
    };
  }
  let end: QueryCursor | undefined;
  if (endDesc !== undefined) {
    end = {
      values: normalizeCursorValues(endDesc.values, endDesc.valueEncoding, normalizedOrders, baseSource),
      inclusive: endDesc.kind === 'endAt',
      fromSnapshot: endDesc.fromSnapshot === true,
    };
  }

  const spec: QueryExecutionSpec = {
    filters,
    orders,
    limitCount,
    limitFromEnd,
    start,
    end,
  };

  const docByPath = new Map<string, RawDocResult>();
  const rows: Array<{ path: string; data: Record<string, unknown> }> = [];
  for (const rawDoc of candidateDocs) {
    if (rawDoc.path === undefined || rawDoc.data === undefined) continue;
    const parsed = JSON.parse(rawDoc.data.json) as unknown;
    const decoded = decodeDocValue(parsed, OFFLINE_REF_DECODER, rawDoc.data.valueEncoding);
    if (decoded !== null && typeof decoded === 'object' && !Array.isArray(decoded)) {
      docByPath.set(rawDoc.path, rawDoc);
      rows.push({ path: rawDoc.path, data: decoded as Record<string, unknown> });
    }
  }

  const matchedRows = executeQuery(rows, spec);
  const out: RawDocResult[] = [];
  for (const row of matchedRows) {
    const matchedDoc = docByPath.get(row.path);
    if (matchedDoc !== undefined) {
      out.push(matchedDoc);
    }
  }
  return out;
}
