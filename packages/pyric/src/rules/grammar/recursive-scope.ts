import type { PathSegment } from './FirestoreAST.js';

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

export function renderPathSegments(segments: readonly PathSegment[]): string {
  return segments.map((segment) => {
    if (segment.type === 'literal') return `/${segment.value}`;
    if (segment.type === 'wildcard') return `/{${segment.name}}`;
    return `/{${segment.name}=**}`;
  }).join('');
}

/** The scope of a full match path, or null when it holds no recursive wildcard. */
export function recursiveScope(segments: readonly PathSegment[]): RecursiveScope | null {
  const index = segments.findIndex((segment) => segment.type === 'recursive');
  if (index === -1) return null;
  const fullPath = renderPathSegments(segments);
  const prefix = renderPathSegments(segments.slice(0, index));
  const trailing = segments.slice(index + 1);
  if (trailing.length === 0) {
    return {
      kind: 'subtree',
      fullPath,
      description: prefix ? `every document under ${prefix}` : 'every document in the database',
    };
  }
  const under = prefix ? ` under ${prefix}` : '';
  const [collection, document] = trailing;
  const description = trailing.length === 2 && collection?.type === 'literal' && document?.type === 'wildcard'
    ? `every document in a collection named ${collection.value} at any depth${under}`
    : `every document whose path ends in ${renderPathSegments(trailing)}${under}`;
  return { kind: 'suffix', fullPath, description };
}
