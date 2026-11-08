import type { AggregateField, DocumentData } from './types.js';

export function resolveAggregateSegments(
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
export function aggregateFieldValue(
  data: DocumentData,
  fieldPath: string | { _internalPath?: { segments?: readonly string[] } },
  pathSegments?: readonly string[],
): unknown {
  const segments = resolveAggregateSegments(fieldPath, pathSegments);
  if (segments.length === 0) return undefined;
  if (segments.length === 1) {
    const key = segments[0]!;
    return Object.hasOwn(data, key) ? data[key] : undefined;
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
    }
  }
  if (field.kind === 'sum') return sum;
  if (count === 0) return null;
  return sum / count;
}
