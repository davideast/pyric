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
 * The fewest segments a recursive wildcard (`{name=**}`) matches under a
 * ruleset's `rules_version`. Version 1, the default when the source declares
 * none, needs one or more; version 2 takes zero or more. The Storage docs:
 * "In version 1, recursive wildcards match one or more filename elements,
 * not zero or more elements." Capture `rules-storage-h1-v1-recursive-wildcard`.
 */
export function recursiveWildcardMinimum(rulesVersion: string): number {
  return rulesVersion === '1' ? 1 : 0;
}

/**
 * Match `segments` against `remaining` under the ruleset's `rules_version`.
 * Returns the leftover path (if any) and the accumulated params, or `null` on
 * failure. A recursive wildcard segment (`{name=**}`) binds a `StoragePath`
 * and may be followed by trailing literal or single-segment wildcard segments
 * (`match /{path=**}/items/{id}`).
 */
export function matchSegments(
  segments: PathSegment[],
  remaining: string[],
  params: Record<string, PathParamValue>,
  rulesVersion: string,
): { left: string[]; params: Record<string, PathParamValue> } | null {
  let i = 0;
  const next: Record<string, PathParamValue> = { ...params };
  const minimum = recursiveWildcardMinimum(rulesVersion);
  for (let s = 0; s < segments.length; s++) {
    const seg = segments[s];
    if (seg.kind === 'wildcard') {
      const trailing = segments.length - 1 - s;
      const length = remaining.length - i - trailing;
      if (length < minimum) return null;
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
