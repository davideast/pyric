import { FirebaseError } from 'pyric/app';

const MAX_QUERY_LAYERS = 64;

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
    case 'where':
    case 'orderBy':
    case 'limit':
    case 'limitToLast':
      return;
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
