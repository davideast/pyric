export interface QueryableFeatureSupport {
  feature: string;
  surface: string;
  importPaths?: readonly string[];
}

export type CanIUseMatch = 'exact' | 'ambiguous' | 'suggestions' | 'none';

export interface CanIUseResult<T extends QueryableFeatureSupport> {
  query: string;
  match: CanIUseMatch;
  supports: readonly T[];
}

export interface CanIUseOptions {
  /** Restrict the answer to features exposed through this published import. */
  importPath?: string;
}

export interface QueryableImportEvidence {
  importPath: string;
}

/** Resolve the canonical compatibility-page association for a published
 * import. An exact lookup prevents docs generators from maintaining a second
 * import-to-evidence map. */
export function resolveImportEvidence<T extends QueryableImportEvidence>(
  evidence: readonly T[],
  importPath: string,
): T | undefined {
  return evidence.find((entry) => entry.importPath === importPath);
}

export function normalizeFeature(value: string): string {
  return value.trim().replace(/\(.*\)$/, '').replace(/[\s_-]+/g, '').toLowerCase();
}

export function featureIdentity(value: string): string {
  return value;
}

function normalizeSurface(value: string): string {
  return value.trim().replace(/[\s_-]+/g, '-').toLowerCase();
}

function distance(left: string, right: string): number {
  const row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    let diagonal = row[0]!;
    row[0] = i;
    for (let j = 1; j <= right.length; j++) {
      const prior = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, diagonal + (left[i - 1] === right[j - 1] ? 0 : 1));
      diagonal = prior;
    }
  }
  return row[right.length]!;
}

/** The one authored feature-query implementation. Canonical model consumers
 * call it directly; the CLI build copies this source into its ignored data
 * projection so the published package has no private workspace dependency. */
export function resolveCanIUse<T extends QueryableFeatureSupport>(
  supports: readonly T[],
  query: string,
  options: CanIUseOptions = {},
): CanIUseResult<T> {
  const importPath = options.importPath;
  const scopedSupports = importPath !== undefined
    ? supports.filter((support) => support.importPaths?.includes(importPath))
    : supports;
  const slash = query.indexOf('/');
  const colon = query.indexOf(':');
  const separator = slash > 0 ? slash : colon > 0 ? colon : -1;
  const delimiter = separator > 0 ? query[separator] : undefined;
  const requestedSurfaceIdentity = separator > 0 ? query.slice(0, separator) : undefined;
  const requestedSurface = requestedSurfaceIdentity ? normalizeSurface(requestedSurfaceIdentity) : undefined;
  const requestedFeature = separator > 0 ? query.slice(separator + 1) : query;
  const normalized = normalizeFeature(requestedFeature);
  if (!normalized) return { query, match: 'none', supports: [] };
  const candidates = scopedSupports.filter((support) =>
    (!requestedSurface || normalizeSurface(support.surface) === requestedSurface) && normalizeFeature(support.feature) === normalized,
  );
  const exactCandidates = candidates.filter((support) =>
    featureIdentity(support.feature) === featureIdentity(requestedFeature)
    && (!requestedSurfaceIdentity || (delimiter === '/' && support.surface === requestedSurfaceIdentity)),
  );
  if (exactCandidates.length > 0) {
    return { query, match: exactCandidates.length === 1 ? 'exact' : 'ambiguous', supports: exactCandidates };
  }
  if (candidates.length > 0) {
    return { query, match: 'suggestions', supports: candidates };
  }

  const suggestions = scopedSupports
    .filter((support) => !requestedSurface || normalizeSurface(support.surface) === requestedSurface)
    .map((support) => {
      const name = normalizeFeature(support.feature);
      const score = name.startsWith(normalized) ? 0 : name.includes(normalized) ? 1 : 2 + distance(normalized, name);
      return { support, score };
    })
    .filter(({ score }) => score <= Math.max(4, Math.ceil(normalized.length / 3) + 2))
    .sort((a, b) => a.score - b.score || a.support.feature.localeCompare(b.support.feature) || a.support.surface.localeCompare(b.support.surface))
    .slice(0, 8)
    .map(({ support }) => support);
  return { query, match: suggestions.length > 0 ? 'suggestions' : 'none', supports: suggestions };
}
