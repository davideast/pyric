import { FirebaseError } from 'pyric/app';
import { FieldPath } from 'pyric/firestore';

const MAX_QUERY_LAYERS = 64;

const VALID_WHERE_OPS = new Set([
  '<',
  '<=',
  '==',
  '!=',
  '>=',
  '>',
  'array-contains',
  'in',
  'array-contains-any',
  'not-in',
]);

function isValidFieldReference(field: unknown): boolean {
  if (typeof field === 'string') return field.length > 0;
  if (field instanceof FieldPath) return true;
  if (field !== null && typeof field === 'object' && !Array.isArray(field)) {
    const internal = (field as { _internalPath?: unknown })._internalPath;
    if (internal !== null && typeof internal === 'object' && !Array.isArray(internal)) {
      const segments = (internal as { segments?: unknown }).segments;
      return Array.isArray(segments)
        && segments.length > 0
        && segments.every((segment) => typeof segment === 'string' && segment.length > 0);
    }
  }
  return false;
}

function invalidStructure(message = 'Invalid Firestore query structure.'): never {
  throw new FirebaseError('invalid-argument', message);
}

function assertRecord(value: unknown): asserts value is Record<string, unknown> {
  const isRecord = value !== null && typeof value === 'object' && !Array.isArray(value);
  const isInvalid = !isRecord;
  if (isInvalid) invalidStructure();
}

function assertChildren(value: unknown): asserts value is readonly unknown[] {
  const isInvalid = !Array.isArray(value);
  if (isInvalid) invalidStructure();
}

function assertNextLayer(depth: number): void {
  const exceedsDepth = depth >= MAX_QUERY_LAYERS;
  if (exceedsDepth) {
    throw new FirebaseError('invalid-argument', 'Firestore query nesting exceeds 64 layers.');
  }
}

/** Validate the wire tree before constructing SDK queries or decoding operands. */
export function assertQueryStructure(target: unknown, depth = 0): void {
  assertRecord(target);
  switch (target.__ref) {
    case 'doc':
    case 'collection': {
      const hasInvalidPath = typeof target.path !== 'string';
      if (hasInvalidPath) invalidStructure();
      return;
    }
    case 'group': {
      const hasInvalidCollectionId = typeof target.collectionId !== 'string';
      if (hasInvalidCollectionId) invalidStructure();
      return;
    }
    case 'query': {
      assertNextLayer(depth);
      assertChildren(target.constraints);
      const nextDepth = depth + 1;
      assertQueryStructure(target.source, nextDepth);
      for (const constraint of target.constraints) assertConstraintStructure(constraint, nextDepth);
      return;
    }
    default:
      throw new FirebaseError('invalid-argument', 'Unsupported Firestore target descriptor.');
  }
}

function assertConstraintStructure(constraint: unknown, depth: number, requiresFilter = false): void {
  assertRecord(constraint);
  const isComposite = constraint.kind === 'and' || constraint.kind === 'or';
  const isFilter = isComposite || constraint.kind === 'where';
  const hasNonFilterChild = requiresFilter && !isFilter;
  if (hasNonFilterChild) invalidStructure('A composite filter cannot contain a non-filter constraint.');
  if (isComposite) {
    assertNextLayer(depth);
    assertChildren(constraint.filters);
    const hasNoFilters = constraint.filters.length === 0;
    if (hasNoFilters) invalidStructure('A composite filter requires at least one filter.');
    for (const filter of constraint.filters) assertConstraintStructure(filter, depth + 1, true);
    return;
  }
  switch (constraint.kind) {
    case 'where': {
      const hasValidField = isValidFieldReference(constraint.field);
      const hasValidOp = typeof constraint.op === 'string' && VALID_WHERE_OPS.has(constraint.op);
      const hasValidValue = Object.hasOwn(constraint, 'value') && constraint.value !== undefined;
      if (!hasValidField || !hasValidOp || !hasValidValue) {
        invalidStructure('Invalid Firestore where constraint.');
      }
      return;
    }
    case 'orderBy': {
      const hasValidField = isValidFieldReference(constraint.field);
      const hasValidDirection = constraint.direction === undefined
        || constraint.direction === 'asc'
        || constraint.direction === 'desc';
      if (!hasValidField || !hasValidDirection) {
        invalidStructure('Invalid Firestore orderBy constraint.');
      }
      return;
    }
    case 'limit':
    case 'limitToLast': {
      const hasValidLimit = typeof constraint.n === 'number' && Number.isInteger(constraint.n) && constraint.n > 0;
      if (!hasValidLimit) {
        invalidStructure('Invalid Firestore limit constraint.');
      }
      return;
    }
    case 'startAt':
    case 'startAfter':
    case 'endAt':
    case 'endBefore':
      assertChildren(constraint.values);
      return;
    default:
      throw new FirebaseError('invalid-argument', 'Unsupported Firestore query constraint descriptor.');
  }
}
