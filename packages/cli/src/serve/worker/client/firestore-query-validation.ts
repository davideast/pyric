/**
 * Synchronous query-constraint validation for the worker/hosted Firestore
 * client (`query()`), mirroring `pyric/firestore`'s `QueryImpl` and
 * `captureQueryOperand` construction-time invariants so invalid queries throw
 * `FirebaseError('invalid-argument')` synchronously before opening an RPC or
 * listener stream.
 */

import { FirebaseError } from 'pyric/app';
import type {
  FilterConstraintDescriptor,
  QueryConstraintDescriptor,
} from '../protocol.js';

const VALID_WHERE_OPERATORS = new Set<string>([
  '<',
  '<=',
  '==',
  '!=',
  '>=',
  '>',
  'in',
  'not-in',
  'array-contains',
  'array-contains-any',
]);

const ARRAY_OPERAND_OPERATORS = new Set<string>([
  'in',
  'not-in',
  'array-contains-any',
]);

function invalidQueryArgument(message: string): FirebaseError {
  return new FirebaseError('invalid-argument', message);
}

/**
 * Validates an already-encoded wire value (`encodeDocValue(...)`) as a query or
 * cursor operand. `encodeDocValue` leaves `undefined`, `bigint`, `function`,
 * `symbol`, `Uint8Array`, and unrecognized class instances untouched and
 * encodes supported SDK class instances into plain marker objects, so any
 * surviving non-JSON primitive, non-plain object prototype, or disallowed
 * nested array is rejected with `invalid-argument` matching `pyric/firestore`'s
 * `captureQueryOperand`.
 */
const ENCODED_REF_DB_RE = /^databases\/([^/]+)\/documents(?:\/|$)/;

function extractEncodedReferenceDatabaseId(encoded: Record<string, unknown>): string | undefined {
  if (encoded.__type !== 'reference' || typeof encoded.path !== 'string') {
    return undefined;
  }
  const match = ENCODED_REF_DB_RE.exec(encoded.path);
  if (match !== null && typeof match[1] === 'string' && match[1].length > 0) {
    return match[1];
  }
  return '(default)';
}

function assertEncodedQueryOperand(
  encoded: unknown,
  allowNestedArrays: boolean,
  parentIsArray = false,
  targetDatabaseId = '(default)',
): void {
  if (
    encoded === null
    || typeof encoded === 'string'
    || typeof encoded === 'boolean'
    || typeof encoded === 'number'
  ) {
    return;
  }
  if (
    encoded === undefined
    || typeof encoded === 'bigint'
    || typeof encoded === 'function'
    || typeof encoded === 'symbol'
  ) {
    throw invalidQueryArgument(`Unsupported Firestore query value: ${typeof encoded}.`);
  }
  if (typeof encoded !== 'object') {
    throw invalidQueryArgument('Unsupported Firestore query value.');
  }
  if (encoded instanceof Uint8Array) {
    return;
  }
  if (Array.isArray(encoded)) {
    if (parentIsArray && !allowNestedArrays) {
      throw invalidQueryArgument('Nested arrays are not supported.');
    }
    for (const item of encoded) {
      assertEncodedQueryOperand(item, allowNestedArrays, true, targetDatabaseId);
    }
    return;
  }
  const prototype = Object.getPrototypeOf(encoded);
  if (prototype !== Object.prototype && prototype !== null) {
    throw invalidQueryArgument('Firestore query maps must be plain objects.');
  }
  const refDb = extractEncodedReferenceDatabaseId(encoded as Record<string, unknown>);
  if (refDb !== undefined && refDb !== targetDatabaseId) {
    throw invalidQueryArgument('Document reference belongs to a different Firestore database.');
  }
  for (const child of Object.values(encoded as Record<string, unknown>)) {
    assertEncodedQueryOperand(child, allowNestedArrays, false, targetDatabaseId);
  }
}

function validateFilterConstraint(filter: FilterConstraintDescriptor, targetDatabaseId: string): void {
  if (filter.kind === 'where') {
    if (!VALID_WHERE_OPERATORS.has(filter.op)) {
      throw invalidQueryArgument('Unsupported Firestore filter operator.');
    }
    if (ARRAY_OPERAND_OPERATORS.has(filter.op) && !Array.isArray(filter.value)) {
      throw invalidQueryArgument(`Firestore ${filter.op} filter requires an array operand.`);
    }
    const allowsNestedArray = filter.op === 'in' || filter.op === 'not-in';
    assertEncodedQueryOperand(filter.value, allowsNestedArray, false, targetDatabaseId);
    return;
  }
  for (const nested of filter.filters) {
    validateFilterConstraint(nested, targetDatabaseId);
  }
}

export function validateResolvedQueryConstraint(
  constraint: QueryConstraintDescriptor,
  explicitOrderFields: readonly string[],
  targetDatabaseId = '(default)',
): void {
  if (constraint.kind === 'where' || constraint.kind === 'and' || constraint.kind === 'or') {
    validateFilterConstraint(constraint, targetDatabaseId);
    return;
  }
  if (constraint.kind === 'orderBy') {
    const dir = constraint.direction ?? 'asc';
    if (dir !== 'asc' && dir !== 'desc') {
      throw invalidQueryArgument("orderBy() direction must be 'asc' or 'desc'.");
    }
    return;
  }
  if (constraint.kind === 'limit' || constraint.kind === 'limitToLast') {
    if (!Number.isFinite(constraint.n)) {
      throw invalidQueryArgument('Query limit must be a finite number.');
    }
    return;
  }
  // Cursor constraint (`startAt`, `startAfter`, `endAt`, `endBefore`).
  constraint.values.forEach((encodedValue, index) => {
    if (constraint.fromSnapshot === true && encodedValue === undefined) {
      // Deferred to execution (`getDocs` / `onSnapshot` / `count` / `aggregate`)
      // via `assertExecutableQueryDescriptor` so `query()` construction with a
      // missing prototype-named field preserves existing handle construction
      // while refusing to silently coerce `undefined` to `null` over JSON wire.
      return;
    }
    assertEncodedQueryOperand(encodedValue, false, false, targetDatabaseId);
    if (constraint.fromSnapshot !== true && explicitOrderFields[index] === '__name__') {
      if (typeof encodedValue !== 'string') {
        throw invalidQueryArgument('Expected a string for a document ID cursor value.');
      }
    }
  });
}

export function assertExecutableQueryDescriptor(
  constraints: readonly QueryConstraintDescriptor[],
): void {
  for (const constraint of constraints) {
    if (
      constraint.kind === 'startAt'
      || constraint.kind === 'startAfter'
      || constraint.kind === 'endAt'
      || constraint.kind === 'endBefore'
    ) {
      for (const value of constraint.values) {
        if (value === undefined) {
          throw invalidQueryArgument(
            'Invalid query. Snapshot cursor document is missing an ordered field.',
          );
        }
      }
    }
  }
}
