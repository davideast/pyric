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
