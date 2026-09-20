import { requireRecord, requireShape, requireString, requireOptionalString } from './fields.js';

/** Check the wire query plan before the RTDB adapter constructs a query handle. */
export function assertRtdbQuery(value: unknown): void {
  const isAbsent = value === undefined;
  if (isAbsent) return;
  requireRecord(value, 'query');
  const order = value.orderBy;
  const hasOrder = order !== null;
  if (hasOrder) {
    requireRecord(order, 'query.orderBy');
    const isChildOrder = order.kind === 'child';
    const isKnownOrder = isChildOrder || order.kind === 'key' || order.kind === 'value' || order.kind === 'priority';
    requireShape(isKnownOrder, 'query.orderBy.kind');
    if (isChildOrder) requireString(order.path, 'query.orderBy.path');
  }
  const bounds = value.bounds;
  const hasBounds = Array.isArray(bounds);
  requireShape(hasBounds, 'query.bounds');
  for (const bound of bounds) {
    requireRecord(bound, 'query.bound');
    const isKnownBound = bound.kind === 'startAt' || bound.kind === 'startAfter' || bound.kind === 'endAt'
      || bound.kind === 'endBefore' || bound.kind === 'equalTo';
    requireShape(isKnownBound, 'query.bound.kind');
    const hasValue = bound.value !== undefined;
    requireShape(hasValue, 'query.bound.value');
    requireOptionalString(bound.key, 'query.bound.key');
  }
  const limit = value.limit;
  const hasLimit = limit !== null;
  if (hasLimit) {
    requireRecord(limit, 'query.limit');
    const isKnownLimit = limit.kind === 'limitToFirst' || limit.kind === 'limitToLast';
    requireShape(isKnownLimit, 'query.limit.kind');
    const hasNumber = typeof limit.n === 'number' && Number.isFinite(limit.n);
    requireShape(hasNumber, 'query.limit.n');
  }
}
