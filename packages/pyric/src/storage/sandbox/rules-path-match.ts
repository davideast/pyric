import type { PathSegment } from './rules.js';
import { StoragePath } from './rules-path.js';

export type PathParamValue = string | string[] | StoragePath;

// ═══════════════════════════════════════════════════════════════
// Evaluation helpers
// ═══════════════════════════════════════════════════════════════

export function splitPath(path: string): string[] {
  return path.split('/').filter((s) => s.length > 0);
}

export function formatPath(segments: PathSegment[]): string {
  return (
    '/' +
    segments
      .map((s) => {
        if (s.kind === 'literal') return s.value;
        if (s.kind === 'param') return `{${s.name}}`;
        return `{${s.name}=**}`;
      })
      .join('/')
  );
}

/**
 * Match `segments` against `remaining`. Returns the leftover path (if any) and
 * the accumulated params, or `null` on failure. A recursive wildcard segment
 * (`{name=**}`) binds a `StoragePath` and may be followed by trailing literal
 * or single-segment wildcard segments (`match /{path=**}/items/{id}`).
 */
export function matchSegments(
  segments: PathSegment[],
  remaining: string[],
  params: Record<string, PathParamValue>,
): { left: string[]; params: Record<string, PathParamValue> } | null {
  let i = 0;
  const next: Record<string, PathParamValue> = { ...params };
  for (let s = 0; s < segments.length; s++) {
    const seg = segments[s];
    if (seg.kind === 'wildcard') {
      const trailing = segments.length - 1 - s;
      const length = remaining.length - i - trailing;
      if (length < 0) return null;
      const captured = remaining.slice(i, i + length);
      next[seg.name] = new StoragePath('/' + captured.join('/'));
      i += length;
      continue;
    }
    if (i >= remaining.length) return null;
    if (seg.kind === 'literal') {
      if (remaining[i] !== seg.value) return null;
      i++;
    } else {
      // param
      next[seg.name] = remaining[i];
      i++;
    }
  }
  return { left: remaining.slice(i), params: next };
}
