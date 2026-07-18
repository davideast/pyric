import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { loadCensusPairs } from '../surfaces/load.ts';
import { buildSurfaceCensus, type SurfaceCensus } from './surface-census.ts';

export const SURFACE_CENSUS_CACHE_ENV = 'PYRIC_SURFACE_CENSUS_PATH';

function invalid(message: string): never {
  throw new Error(`Invalid surface census cache: ${message}`);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function hasCompleteCensusData(row: Partial<SurfaceCensus>): boolean {
  const runtime = row.runtime as Partial<SurfaceCensus['runtime']> | undefined;
  const types = row.types as Partial<SurfaceCensus['types']> | undefined;
  const raw = row.rawRuntime as Partial<SurfaceCensus['rawRuntime']> | undefined;
  return runtime !== undefined
    && isCount(runtime.upstreamCount)
    && isCount(runtime.mirrorCount)
    && isStringArray(runtime.mapped)
    && Array.isArray(runtime.dispositioned)
    && isStringArray(runtime.unmapped)
    && isStringArray(runtime.privateUpstream)
    && isStringArray(runtime.stalePrivateUpstream)
    && isStringArray(runtime.extra)
    && isStringArray(runtime.staleDispositions)
    && isStringArray(runtime.redundantDispositions)
    && types !== undefined
    && isCount(types.upstreamCount)
    && isCount(types.mirrorCount)
    && isStringArray(types.mapped)
    && isStringArray(types.unmapped)
    && isStringArray(types.extra)
    && raw !== undefined
    && isCount(raw.upstreamCount)
    && isCount(raw.mirrorCount)
    && isCount(raw.mappedCount);
}

function parseCache(path: string): SurfaceCensus[] {
  const value = JSON.parse(readFileSync(path, 'utf8')) as { surfaces?: unknown };
  if (!Array.isArray(value.surfaces)) invalid('missing surfaces array');
  const expected = new Map(loadCensusPairs().map((pair) => [pair.surface, pair]));
  const seen = new Set<string>();
  for (const candidate of value.surfaces) {
    if (typeof candidate !== 'object' || candidate === null) invalid('surface row is not an object');
    const row = candidate as Partial<SurfaceCensus>;
    if (!row.surface || !expected.has(row.surface)) invalid(`unknown surface '${String(row.surface)}'`);
    if (seen.has(row.surface)) invalid(`duplicate surface '${row.surface}'`);
    const pair = expected.get(row.surface)!;
    if (row.upstream !== pair.upstream || JSON.stringify(row.mirrors) !== JSON.stringify(pair.mirrors)) {
      invalid(`surface '${row.surface}' has the wrong upstream or mirrors`);
    }
    if (!hasCompleteCensusData(row)) invalid(`surface '${row.surface}' has incomplete census data`);
    seen.add(row.surface);
  }
  const missing = [...expected.keys()].filter((surface) => !seen.has(surface));
  if (missing.length) invalid(`missing surfaces: ${missing.join(', ')}`);
  return value.surfaces as SurfaceCensus[];
}

export async function loadOrBuildSurfaceCensus(
  build: () => Promise<SurfaceCensus[]> = buildSurfaceCensus,
): Promise<SurfaceCensus[]> {
  const path = process.env[SURFACE_CENSUS_CACHE_ENV];
  if (!path) return build();
  if (existsSync(path)) return parseCache(path);
  const surfaces = await build();
  writeFileSync(path, `${JSON.stringify({ surfaces })}\n`);
  return surfaces;
}
