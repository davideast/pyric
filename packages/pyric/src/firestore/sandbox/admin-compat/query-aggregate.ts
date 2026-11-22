import {
  FirestoreCompatError,
  type AggregateField,
  type AggregateQuerySnapshot,
  type AggregateSpec,
  type DocumentData,
} from './types.js';

const MIN_AGGREGATIONS = 1;
const MAX_AGGREGATIONS = 5;

export function assertValidAggregationCount(spec: unknown): asserts spec is AggregateSpec {
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new FirestoreCompatError({
      code: 'invalid-argument',
      message: 'StructuredAggregationQuery requires a plain object specification.',
    });
  }
  const count = Object.keys(spec).length;
  if (count < MIN_AGGREGATIONS) {
    throw new FirestoreCompatError({
      code: 'invalid-argument',
      message: 'StructuredAggregationQuery requires at least 1 aggregation, got 0.',
    });
  }
  if (count > MAX_AGGREGATIONS) {
    throw new FirestoreCompatError({
      code: 'invalid-argument',
      message: `StructuredAggregationQuery allows a maximum of ${MAX_AGGREGATIONS} aggregations per query, got ${count}.`,
    });
  }
}

function resolveAggregateSegments(
  fieldPath: string | { _internalPath?: { segments?: readonly string[] } },
  pathSegments?: readonly string[],
): readonly string[] {
  if (Array.isArray(pathSegments)) return pathSegments;
  if (typeof fieldPath === 'string') {
    if (fieldPath.includes('.')) return fieldPath.split('.');
    return [fieldPath];
  }
  return fieldPath?._internalPath?.segments ?? [];
}

/**
 * Read a (possibly nested or literal-dot) field path from a document for
 * `sum` and `average` aggregations.
 */
function aggregateFieldValue(
  data: DocumentData,
  fieldPath: string | { _internalPath?: { segments?: readonly string[] } },
  pathSegments?: readonly string[],
): unknown {
  const segments = resolveAggregateSegments(fieldPath, pathSegments);
  if (segments.length === 0) return undefined;
  if (segments.length === 1) {
    const key = segments[0];
    if (key === undefined) return undefined;
    if (Object.hasOwn(data, key)) return data[key];
    return undefined;
  }
  let cursor: unknown = data;
  for (const seg of segments) {
    if (typeof cursor !== 'object' || cursor === null || Array.isArray(cursor)) {
      return undefined;
    }
    if (!Object.hasOwn(cursor, seg)) return undefined;
    cursor = (cursor as DocumentData)[seg];
  }
  return cursor;
}

/**
 * Compute one aggregate over rule-filtered query rows. Non-numeric values are
 * skipped; empty inputs yield `0` for count/sum and `null` for average.
 */
export function computeAggregate(
  field: AggregateField,
  rows: readonly { data: DocumentData }[],
): number | null {
  if (field.kind === 'count') return rows.length;
  let sum = 0;
  let count = 0;
  for (const row of rows) {
    const value = aggregateFieldValue(row.data, field.field, field.path);
    if (typeof value === 'number') {
      sum += value;
      count++;
    } else if (typeof value === 'bigint') {
      sum += Number(value);
      count++;
    }
  }
  if (field.kind === 'sum') return sum;
  if (count === 0) return null;
  return sum / count;
}

export function executeAggregateSpec(
  spec: AggregateSpec,
  rows: readonly { path: string; data: DocumentData }[],
): AggregateQuerySnapshot {
  const valueFields = Object.values(spec).filter(
    (f): f is Extract<AggregateField, { kind: 'sum' | 'average' }> =>
      f.kind === 'sum' || f.kind === 'average',
  );
  const distinctFieldKeys = new Set(
    valueFields.map((f) => resolveAggregateSegments(f.field, f.path).join('\0')),
  );
  let scopedRows = rows;
  if (distinctFieldKeys.size === 1) {
    const primary = valueFields[0];
    if (primary !== undefined) {
      scopedRows = rows.filter(
        (row) => aggregateFieldValue(row.data, primary.field, primary.path) !== undefined,
      );
    }
  }
  const data: Record<string, number | null> = {};
  for (const alias of Object.keys(spec)) {
    const entry = spec[alias];
    if (entry !== undefined) {
      data[alias] = computeAggregate(entry, scopedRows);
    }
  }
  return { data: () => data };
}
