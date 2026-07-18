import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCensusPairs } from '../surfaces/load.ts';
import { loadOrBuildSurfaceCensus, SURFACE_CENSUS_CACHE_ENV } from '../src/surface-census-cache.ts';
import type { SurfaceCensus } from '../src/surface-census.ts';

const original = process.env[SURFACE_CENSUS_CACHE_ENV];
const temporary: string[] = [];
const rows = loadCensusPairs().map((pair): SurfaceCensus => ({
  ...pair,
  runtime: {
    upstreamCount: 0,
    mirrorCount: 0,
    mapped: [],
    dispositioned: [],
    unmapped: [],
    privateUpstream: [],
    stalePrivateUpstream: [],
    extra: [],
    staleDispositions: [],
    redundantDispositions: [],
  },
  types: { upstreamCount: 0, mirrorCount: 0, mapped: [], unmapped: [], extra: [] },
  rawRuntime: { upstreamCount: 0, mirrorCount: 0, mappedCount: 0 },
}));

afterEach(() => {
  if (original === undefined) delete process.env[SURFACE_CENSUS_CACHE_ENV];
  else process.env[SURFACE_CENSUS_CACHE_ENV] = original;
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function useCache(value: unknown): void {
  const directory = mkdtempSync(join(tmpdir(), 'pyric-census-cache-'));
  temporary.push(directory);
  const path = join(directory, 'census.json');
  writeFileSync(path, JSON.stringify(value));
  process.env[SURFACE_CENSUS_CACHE_ENV] = path;
}

function useEmptyCachePath(): void {
  const directory = mkdtempSync(join(tmpdir(), 'pyric-census-cache-'));
  temporary.push(directory);
  process.env[SURFACE_CENSUS_CACHE_ENV] = join(directory, 'census.json');
}

describe('job-local surface census', () => {
  test('uses the validated cache instead of rebuilding', async () => {
    useCache({ surfaces: rows });
    let builds = 0;
    expect(await loadOrBuildSurfaceCensus(async () => { builds++; return []; })).toEqual(rows);
    expect(builds).toBe(0);
  });

  test('populates an empty job-local cache once', async () => {
    useEmptyCachePath();
    let builds = 0;
    const build = async () => { builds++; return rows; };
    expect(await loadOrBuildSurfaceCensus(build)).toEqual(rows);
    expect(await loadOrBuildSurfaceCensus(build)).toEqual(rows);
    expect(builds).toBe(1);
  });

  test('fails closed for missing, duplicate, or unknown surfaces', async () => {
    for (const surfaces of [rows.slice(1), [...rows, rows[0]], [{ surface: 'unknown' }]]) {
      useCache({ surfaces });
      await expect(loadOrBuildSurfaceCensus(async () => [])).rejects.toThrow('Invalid surface census cache');
    }
  });

  test('fails closed when a known surface row is incomplete', async () => {
    const incomplete = rows.map((row, index) => index === 0
      ? { surface: row.surface, upstream: row.upstream, mirrors: row.mirrors }
      : row);
    useCache({ surfaces: incomplete });
    await expect(loadOrBuildSurfaceCensus(async () => [])).rejects.toThrow('incomplete census data');
  });
});
