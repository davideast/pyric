import { Reference } from '@pyric/rules/internal';

interface DuckReferenceOwner {
  readonly databaseId?: unknown;
  readonly formattedName?: unknown;
  readonly firestore?: unknown;
  readonly _firestore?: unknown;
}

/**
 * Extract an explicit databaseId from a duck-typed client or Admin SDK
 * `DocumentReference` handle, or return `undefined` when none is declared.
 */
export function extractDuckReferenceDatabaseId(candidate: DuckReferenceOwner): string | undefined {
  if (typeof candidate.databaseId === 'string' && candidate.databaseId.length > 0) {
    return candidate.databaseId;
  }
  if (typeof candidate.formattedName === 'string' && candidate.formattedName.length > 0) {
    return new Reference(candidate.formattedName).databaseId;
  }
  const fsOwner = (candidate.firestore ?? candidate._firestore) as
    | { databaseId?: unknown; _databaseId?: { database?: unknown } }
    | null
    | undefined;
  if (fsOwner && typeof fsOwner === 'object') {
    if (typeof fsOwner.databaseId === 'string' && fsOwner.databaseId.length > 0) {
      return fsOwner.databaseId;
    }
    const inner = fsOwner._databaseId;
    if (inner && typeof inner === 'object' && typeof inner.database === 'string' && inner.database.length > 0) {
      return inner.database;
    }
  }
  return undefined;
}
