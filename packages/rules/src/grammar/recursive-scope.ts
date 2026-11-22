import type { PathSegment } from './FirestoreAST.js';
import { recursiveWildcardMinimum } from './recursive-wildcard-minimum.js';

/**
 * What a match path that holds a recursive wildcard governs, from its full
 * path below the documents root. A recursive wildcard matches zero or more
 * segments. In the last position it governs every document under its prefix
 * (`subtree`). Followed by further segments, as in the collection-group shape
 * `/{path=**}/items/{id}`, it governs only the documents whose path ends in
 * those segments (`suffix`).
 */
export interface RecursiveScope {
  kind: 'subtree' | 'suffix';
  /** The full match path below the documents root, e.g. `/users/{uid}/{document=**}`. */
  fullPath: string;
  /** The documents it governs, e.g. `every document under /users/{uid}`. */
  description: string;
}

const FIRESTORE_ROOT_PREFIX: ReadonlyArray<string | null> = ['databases', '(default)', 'documents'];
const STORAGE_ROOT_PREFIX: ReadonlyArray<string | null> = ['b', null, 'o'];

export function renderPathSegments(segments: readonly PathSegment[]): string {
  return segments
    .map((segment) => {
      if (segment.type === 'literal') return `/${segment.value}`;
      if (segment.type === 'wildcard') return `/{${segment.name}}`;
      return `/{${segment.name}=**}`;
    })
    .join('');
}

function matchServicePrefix(
  segments: readonly PathSegment[],
  prefix: ReadonlyArray<string | null>,
  minimum: number,
): PathSegment[] | null {
  if (prefix.length === 0) {
    if (segments.length === 0) return null;
    return [...segments];
  }
  const head = segments[0];
  if (head === undefined) return null;
  const tail = segments.slice(1);
  if (head.type === 'literal') {
    const expected = prefix[0];
    if (expected !== undefined && expected !== null && head.value !== expected) {
      return null;
    }
    return matchServicePrefix(tail, prefix.slice(1), minimum);
  }
  if (head.type === 'wildcard') {
    return matchServicePrefix(tail, prefix.slice(1), minimum);
  }
  if (tail.length === 0) {
    return [head];
  }
  for (let count = minimum; count < prefix.length; count++) {
    const matched = matchServicePrefix(tail, prefix.slice(count), minimum);
    if (matched !== null) return matched;
  }
  return [head, ...tail];
}

/**
 * Resolve a full match-segment chain from the service block down to a match
 * block into its document-relative (or object-relative) segments, or `null`
 * when the path cannot match any document of `(default)` (or any Storage
 * object).
 */
export function resolveDocumentSegments(
  fullSegments: readonly PathSegment[],
  rulesVersion: string,
  isStorage = false,
): PathSegment[] | null {
  const prefix = isStorage ? STORAGE_ROOT_PREFIX : FIRESTORE_ROOT_PREFIX;
  return matchServicePrefix(fullSegments, prefix, recursiveWildcardMinimum(rulesVersion));
}

/** The scope of a full match path below the documents root, or null when it holds no recursive wildcard. */
export function recursiveScope(segments: readonly PathSegment[]): RecursiveScope | null {
  const index = segments.findIndex((segment) => segment.type === 'recursive');
  if (index === -1) return null;
  const fullPath = renderPathSegments(segments);
  const prefix = renderPathSegments(segments.slice(0, index));
  const trailing = segments.slice(index + 1);
  if (trailing.length === 0) {
    const description = prefix ? `every document under ${prefix}` : 'every document in the database';
    return {
      kind: 'subtree',
      fullPath,
      description,
    };
  }
  const under = prefix ? ` under ${prefix}` : '';
  const [collection, document] = trailing;
  let description = `every document whose path ends in ${renderPathSegments(trailing)}${under}`;
  if (trailing.length === 2 && collection?.type === 'literal' && document?.type === 'wildcard') {
    description = `every document in a collection named ${collection.value} at any depth${under}`;
  }
  return { kind: 'suffix', fullPath, description };
}
