import type { SurfaceCensus } from './surface-census.ts';

export interface CensusGapBaseline {
  runtime: Record<string, string[]>;
  types: Record<string, string[]>;
}

export function censusGapProblems(
  census: readonly Pick<SurfaceCensus, 'surface' | 'runtime' | 'types'>[],
  baseline: CensusGapBaseline,
): string[] {
  const problems: string[] = [];
  for (const entry of census) {
    for (const axis of ['runtime', 'types'] as const) {
      // Runtime gaps must always be reviewed into a disposition. Type breadth
      // predates this contract and remains a no-regression ratchet until the
      // type-surface classification project gives it an equivalent schema.
      const accepted = new Set(axis === 'types' ? baseline[axis][entry.surface] ?? [] : []);
      const introduced = entry[axis].unmapped.filter((symbol) => !accepted.has(symbol));
      if (introduced.length > 0) problems.push(`${entry.surface} ${axis}: ${introduced.join(', ')}`);
    }
  }
  return problems;
}

export function censusIntegrityProblems(
  census: readonly Pick<SurfaceCensus, 'surface' | 'runtime'>[],
): string[] {
  const problems: string[] = [];
  for (const entry of census) {
    if (entry.runtime.staleDispositions.length > 0) {
      problems.push(`${entry.surface} runtime: stale dispositions: ${entry.runtime.staleDispositions.join(', ')}`);
    }
    if (entry.runtime.redundantDispositions.length > 0) {
      problems.push(`${entry.surface} runtime: redundant dispositions: ${entry.runtime.redundantDispositions.join(', ')}`);
    }
    if (entry.runtime.stalePrivateUpstream.length > 0) {
      problems.push(`${entry.surface} runtime: stale private classifications: ${entry.runtime.stalePrivateUpstream.join(', ')}`);
    }
  }
  return problems;
}
