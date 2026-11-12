/**
 * The form a request path takes before a match block is resolved against it.
 *
 * Rules match blocks hang off `match /databases/{database}/documents`, so a
 * path is matched from the first segment after that root: `orders/o2`. The
 * console, the SDK's `doc()` reference, and every error message Firestore
 * itself prints use the full resource name instead, `/databases/(default)/
 * documents/orders/o2`, and a caller that copies one of those in has always
 * been answered with a confident DENY and the note that no block matched,
 * which reads as a verdict rather than as a path that never reached the
 * ruleset.
 *
 * Both forms mean the same request, so both are accepted here and the full
 * form is reduced to the document-relative one before anything else looks at
 * it. Only the exact `databases/<name>/documents` prefix is stripped, so a
 * top-level collection that happens to be called `databases` still resolves as
 * itself.
 */

/** The form a path takes, for a message that has to name it. */
export const DOCUMENT_PATH_FORM =
  'Paths are document-relative, from the first segment after /databases/<database>/documents, such as orders/o2.';

/** The segment count the full resource-name prefix occupies. */
const PREFIX_SEGMENTS = 3;

/**
 * The document-relative form of one request path. A path already in that form
 * is returned with any leading separator removed and nothing else changed.
 */
export function documentRelativePath(path: string): string {
  const segments = path.split('/').filter(Boolean);
  const hasResourcePrefix =
    segments.length > PREFIX_SEGMENTS &&
    segments[0] === 'databases' &&
    segments[2] === 'documents';
  if (hasResourcePrefix) return segments.slice(PREFIX_SEGMENTS).join('/');
  return segments.join('/');
}
