export function normalizeRtdbReference(reference: string): string {
  return reference.split('/').filter(Boolean).join('/');
}

export function rtdbReferenceParts(reference: string): string[] {
  const normalized = normalizeRtdbReference(reference);
  return normalized ? normalized.split('/') : [];
}

export function rtdbReferenceParamName(segment: string): string | null {
  return /^\{([A-Za-z0-9_]+)(?:=\*)?\}$/.exec(segment)?.[1] ?? null;
}

export function supportsRtdbReference(reference: string): boolean {
  return rtdbReferenceParts(reference).every((segment) =>
    rtdbReferenceParamName(segment) !== null || (
      !segment.includes('{') && !segment.includes('}') && !segment.includes('*')
    ),
  );
}

/**
 * Match a concrete path against a trigger's own reference pattern, the way a
 * synthesized event has to: a literal segment must equal the path's segment
 * at that position, and a captured segment binds the path's segment under its
 * param name. Returns null when the path has a different segment count or a
 * literal segment disagrees, which is a shape the pattern never matches.
 */
export function matchRtdbReference(
  reference: string,
  path: string,
): Record<string, string> | null {
  const pattern = rtdbReferenceParts(reference);
  const concrete = rtdbReferenceParts(path);
  if (pattern.length !== concrete.length) return null;
  const params: Record<string, string> = {};
  for (let index = 0; index < pattern.length; index += 1) {
    const capture = rtdbReferenceParamName(pattern[index]!);
    if (capture) {
      params[capture] = concrete[index]!;
      continue;
    }
    if (pattern[index] !== concrete[index]) return null;
  }
  return params;
}
