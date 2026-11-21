/**
 * Firestore v2 document path pattern parsing, validation, and capture matching
 * aligned with `firebase-functions` 7.2.5 (`PathPattern` + Eventarc path patterns).
 */

type FirestoreDocumentPatternSegment =
  | { readonly kind: 'literal'; readonly value: string }
  | { readonly kind: 'single-wildcard' }
  | { readonly kind: 'multi-wildcard' }
  | { readonly kind: 'single-capture'; readonly param: string }
  | { readonly kind: 'multi-capture'; readonly param: string };

export interface ParsedFirestoreDocumentPattern {
  readonly normalized: string;
  readonly segments: readonly FirestoreDocumentPatternSegment[];
  readonly hasWildcards: boolean;
  readonly hasMultiSegmentWildcard: boolean;
}

const VALID_PARAM_NAME = /^[A-Za-z0-9_]+$/;

/** Remove leading/trailing slashes and collapse repeated slashes. */
export function normalizeFirestoreDocumentPath(rawPath: string): string {
  if (!rawPath) return '';
  return rawPath.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\/{2,}/g, '/');
}

/** Split a Firestore path into normalized non-empty segments. */
export function firestoreDocumentPathParts(rawPath: string): string[] {
  const normalized = normalizeFirestoreDocumentPath(rawPath);
  if (normalized.length === 0) return [];
  return normalized.split('/');
}

function isReservedNavigationSegment(segment: string): boolean {
  return segment === '.' || segment === '..';
}

/** Whether `path` is a concrete Firestore document path (even segment count >= 2). */
export function isConcreteFirestoreDocumentPath(path: string): boolean {
  const parts = firestoreDocumentPathParts(path);
  const hasEvenDocumentDepth = parts.length >= 2 && parts.length % 2 === 0;
  if (!hasEvenDocumentDepth) return false;
  return parts.every((part) => part.length > 0 && !isReservedNavigationSegment(part));
}

function decodeSegmentValue(rawSegment: string): string {
  try {
    return decodeURIComponent(rawSegment);
  } catch {
    return rawSegment;
  }
}

function parseCaptureSegment(part: string): FirestoreDocumentPatternSegment | null {
  const inner = part.slice(1, -1);
  if (inner.length === 0 || inner.includes('{') || inner.includes('}') || inner.includes('/')) {
    return null;
  }
  const equalsIndex = inner.indexOf('=');
  if (equalsIndex === -1) {
    if (!VALID_PARAM_NAME.test(inner)) return null;
    return { kind: 'single-capture', param: inner };
  }
  const param = inner.slice(0, equalsIndex);
  const wildcardExpr = inner.slice(equalsIndex + 1);
  if (!VALID_PARAM_NAME.test(param)) return null;
  if (wildcardExpr === '*') {
    return { kind: 'single-capture', param };
  }
  if (wildcardExpr === '**') {
    return { kind: 'multi-capture', param };
  }
  return null;
}

function parseSinglePatternSegment(part: string): FirestoreDocumentPatternSegment | null {
  if (part.length === 0 || isReservedNavigationSegment(part)) return null;
  if (part === '**') return { kind: 'multi-wildcard' };
  if (part === '*') return { kind: 'single-wildcard' };
  const startsBrace = part.startsWith('{');
  const endsBrace = part.endsWith('}');
  if (startsBrace && endsBrace) {
    return parseCaptureSegment(part);
  }
  if (part.includes('{') || part.includes('}') || part.includes('*')) {
    return null;
  }
  return { kind: 'literal', value: part };
}

function isWildcardSegment(segment: FirestoreDocumentPatternSegment): boolean {
  return segment.kind !== 'literal';
}

function isMultiWildcardSegment(segment: FirestoreDocumentPatternSegment): boolean {
  return segment.kind === 'multi-wildcard' || segment.kind === 'multi-capture';
}

/**
 * Parse and validate a Firestore trigger document pattern.
 * Returns `null` when malformed, empty, containing duplicate capture names,
 * containing multiple `**` wildcards, or addressing a collection (odd segment
 * count without a multi-segment wildcard).
 */
export function parseFirestoreDocumentPattern(
  rawPattern: string,
): ParsedFirestoreDocumentPattern | null {
  if (typeof rawPattern !== 'string') return null;
  const normalized = normalizeFirestoreDocumentPath(rawPattern);
  if (normalized.length === 0) return null;
  const rawParts = normalized.split('/');
  const segments: FirestoreDocumentPatternSegment[] = [];
  const seenParams = new Set<string>();
  let multiWildcardCount = 0;

  for (const part of rawParts) {
    const parsed = parseSinglePatternSegment(part);
    if (parsed === null) return null;
    if (parsed.kind === 'single-capture' || parsed.kind === 'multi-capture') {
      if (seenParams.has(parsed.param)) return null;
      seenParams.add(parsed.param);
    }
    if (isMultiWildcardSegment(parsed)) {
      multiWildcardCount += 1;
      if (multiWildcardCount > 1) return null;
    }
    segments.push(parsed);
  }

  const hasMultiSegmentWildcard = multiWildcardCount === 1;
  const validFixedDepth = segments.length >= 2 && segments.length % 2 === 0;
  if (!hasMultiSegmentWildcard && !validFixedDepth) {
    return null;
  }

  return {
    normalized,
    segments,
    hasWildcards: segments.some(isWildcardSegment),
    hasMultiSegmentWildcard,
  };
}

/** Whether `pattern` is a valid Firestore v2 trigger document path/pattern. */
export function supportsFirestoreDocumentPattern(pattern: string): boolean {
  return parseFirestoreDocumentPattern(pattern) !== null;
}

/**
 * Match a concrete Firestore document path against a trigger document pattern
 * and extract `{param}` bindings matching `firebase-functions` `PathPattern.extractMatches`.
 */
export function matchFirestoreDocument(
  pattern: string,
  documentPath: string,
): Record<string, string> | null {
  const parsed = parseFirestoreDocumentPattern(pattern);
  if (parsed === null) return null;
  if (!isConcreteFirestoreDocumentPath(documentPath)) return null;

  const concrete = firestoreDocumentPathParts(documentPath);
  if (parsed.hasMultiSegmentWildcard) {
    if (concrete.length < parsed.segments.length) return null;
  } else if (concrete.length !== parsed.segments.length) {
    return null;
  }

  const params: Record<string, string> = {};
  let pathIndex = 0;
  for (let segIndex = 0; segIndex < parsed.segments.length; segIndex += 1) {
    const segment = parsed.segments[segIndex];
    if (segment === undefined) return null;
    const remainingPatternSegments = parsed.segments.length - 1 - segIndex;
    const nextPathIndex = concrete.length - remainingPatternSegments;

    if (segment.kind === 'literal') {
      const actual = concrete[pathIndex];
      if (actual !== segment.value) return null;
      pathIndex += 1;
    } else if (segment.kind === 'single-wildcard') {
      pathIndex += 1;
    } else if (segment.kind === 'single-capture') {
      const actual = concrete[pathIndex];
      if (actual === undefined) return null;
      params[segment.param] = decodeSegmentValue(actual);
      pathIndex += 1;
    } else if (segment.kind === 'multi-wildcard') {
      if (nextPathIndex <= pathIndex) return null;
      pathIndex = nextPathIndex;
    } else {
      if (nextPathIndex <= pathIndex) return null;
      const joined = concrete.slice(pathIndex, nextPathIndex).join('/');
      params[segment.param] = decodeSegmentValue(joined);
      pathIndex = nextPathIndex;
    }
  }

  if (pathIndex !== concrete.length) return null;
  return params;
}
