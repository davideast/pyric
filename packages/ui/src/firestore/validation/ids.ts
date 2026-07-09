/**
 * Firestore collection/document id validation (create-collection /
 * create-document / JSON-import flows).
 *
 * Pure, dependency-free, and deliberately narrow: it mirrors the rules the
 * real backend enforces (see Firestore's "Rules and limits" docs), so a form
 * can reject an invalid id BEFORE the write round-trip rather than
 * surfacing a raw backend error string.
 *
 * Rules (both collection and document ids):
 *   - non-empty
 *   - no `/` (that's a path separator, not part of an id)
 *   - not solely `.` or `..`
 *   - doesn't match `__.*__` (reserved for internal use)
 *   - at most 1500 bytes (UTF-8) — Firestore caps BOTH collection ids and
 *     document ids at 1500 bytes ("Rules and limits": "Maximum size for a
 *     collection ID" / "Maximum size for a document ID", both 1,500 bytes).
 */

const RESERVED_DUNDER = /^__.*__$/;

/** Shared structural checks common to both collection and document ids. */
function structuralError(id: string): string | undefined {
  if (id.length === 0) return 'Cannot be empty';
  if (id.includes('/')) return 'Cannot contain "/"';
  if (id === '.' || id === '..') return 'Cannot be "." or ".."';
  if (RESERVED_DUNDER.test(id)) return 'Cannot match __.*__ (reserved)';
  if (utf8ByteLength(id) > 1500) return 'Cannot exceed 1500 bytes';
  return undefined;
}

/** Validate a collection id. Returns an error message, or `undefined` when valid. */
export function validateCollectionId(id: string): string | undefined {
  return structuralError(id);
}

/** UTF-8 byte length of a string (Firestore's 1500-byte id cap). */
function utf8ByteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** Validate a document id. Returns an error message, or `undefined` when valid. */
export function validateDocumentId(id: string): string | undefined {
  return structuralError(id);
}
