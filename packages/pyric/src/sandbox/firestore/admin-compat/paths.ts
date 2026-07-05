/**
 * Path helpers for the Admin-SDK-compat Firestore wrapper.
 *
 * Ported verbatim from bench's `pilot/src/firestore-wrapper.ts`
 * (see the design rationale slice 2). Centralized
 * here so `doc-ref.ts`, `query.ts`, and `firestore.ts` share one
 * canonical segment-shape understanding — Admin SDK's even-segments-=-doc
 * /odd-segments-=-collection convention is enforced at the wrapper's
 * input boundary, before anything reaches `LocalEnvironment`.
 */

/**
 * Split a Firestore path into segments, dropping leading/trailing
 * slashes. Empty input yields `['']` (downstream callers treat that as
 * an invalid path via the *Path predicates).
 */
export function pathSegments(path: string): string[] {
  return path.replace(/^\/+|\/+$/g, '').split('/');
}

/**
 * True iff `path` has an even, non-zero segment count — Admin SDK's
 * shape rule for document paths (`collection/doc[/sub/doc]*`).
 */
export function isDocumentPath(path: string): boolean {
  return pathSegments(path).length % 2 === 0 && pathSegments(path).length > 0;
}

/**
 * True iff `path` has an odd segment count — Admin SDK's shape rule
 * for collection paths (`collection[/doc/sub]*`).
 */
export function isCollectionPath(path: string): boolean {
  return pathSegments(path).length % 2 === 1;
}

/**
 * Last segment of `path`. Used to derive `DocumentReference.id` /
 * `CollectionReference.id` from full paths.
 */
export function lastSegment(path: string): string {
  const segs = pathSegments(path);
  return segs[segs.length - 1] ?? '';
}

/**
 * Drop the trailing segment of a document path to get the collection
 * that contains it. Used by `DocumentReference.parent`.
 */
export function parentCollectionPath(docPath: string): string {
  const segs = pathSegments(docPath);
  return segs.slice(0, -1).join('/');
}
