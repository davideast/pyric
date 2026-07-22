import type { PathSegment } from './rules.js';

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
 * Match `segments` against the head of `remaining`. Returns the
 * leftover path (if any) and the accumulated params, or `null` on
 * failure. A wildcard segment must be the LAST entry in the block's
 * segments — it consumes everything that remains.
 */
export function matchSegments(
  segments: PathSegment[],
  remaining: string[],
  params: Record<string, string | string[]>,
): { left: string[]; params: Record<string, string | string[]> } | null {
  let i = 0;
  const next = { ...params };
  for (let s = 0; s < segments.length; s++) {
    const seg = segments[s];
    if (seg.kind === 'wildcard') {
      next[seg.name] = remaining.slice(i);
      return { left: [], params: next };
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
