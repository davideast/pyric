/**
 * Zero-regex structural path parser and canonicalizer for Pyric sandbox paths.
 *
 * Centralizes cross-service path canonicalization in the shared sandbox foundation
 * per AGENTS.md Rule #4 (Foundation Reuse).
 */

/**
 * Split a raw path string into clean, non-empty path segments without regexes.
 * Collapses consecutive slashes ('//') and explicitly rejects relative traversal segments ('.' and '..').
 */
export function parsePathSegments(raw: string): readonly string[] {
  const segments: string[] = [];
  for (const part of raw.split('/')) {
    const trimmed = part.trim();
    if (trimmed.length > 0) {
      if (trimmed === '.' || trimmed === '..') {
        throw new Error(`Invalid relative path segment '${trimmed}' in path '${raw}'`);
      }
      segments.push(trimmed);
    }
  }
  return segments;
}

/**
 * Canonicalize any path string into 'segment/segment' form (or '' for root).
 */
export function canonicalizePath(raw: string): string {
  return parsePathSegments(raw).join('/');
}
