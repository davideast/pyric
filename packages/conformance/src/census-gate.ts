#!/usr/bin/env bun
/**
 * Ratchet over the public Firebase runtime and type export gaps.
 *
 * Known gaps are committed in `census-baseline.json`. A new public export that
 * Pyric does not mirror fails this gate on the correct axis. Private Firebase
 * runtime exports never enter either baseline. Stale and redundant public
 * dispositions are always fatal.
 */
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync } from 'node:fs';
import type { CensusSurface } from './surface-denylist.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const BASELINE_PATH = join(HERE, '..', 'baselines', 'census-baseline.json');
const CENSUS_SCRIPT = join(HERE, 'surface-census.ts');

interface CensusRow {
  surface: CensusSurface;
  runtime: {
    unmapped: string[];
    staleDispositions: string[];
    redundantDispositions: string[];
  };
  types: { unmapped: string[] };
}

interface CensusJson {
  surfaces: CensusRow[];
  totalRuntimeUnmapped: number;
  totalTypeUnmapped: number;
  totalStaleOrRedundant: number;
}

interface Baseline {
  _comment: string;
  generatedFrom: string;
  runtime: Record<string, string[]>;
  types: Record<string, string[]>;
}

function runCensus(): CensusJson {
  try {
    const output = execFileSync('bun', ['run', CENSUS_SCRIPT, '--json'], { encoding: 'utf8', cwd: REPO_ROOT });
    return JSON.parse(output) as CensusJson;
  } catch (error) {
    const output = (error as { stdout?: string }).stdout;
    if (!output) throw error;
    return JSON.parse(output) as CensusJson;
  }
}

function axisFrom(census: CensusJson, axis: 'runtime' | 'types'): Record<string, string[]> {
  return Object.fromEntries(census.surfaces.map((surface) => [surface.surface, [...surface[axis].unmapped].sort()]));
}

function gapCount(axis: Record<string, string[]>): number {
  return Object.values(axis).reduce((count, gaps) => count + gaps.length, 0);
}

const census = runCensus();

if (process.argv.includes('--update')) {
  const baseline: Baseline = {
    _comment:
      'Known unmapped PUBLIC Firebase exports tolerated by the census ratchet. Runtime and type namespaces are separate. Every entry remains in the public coverage denominator; the baseline prevents new gaps, it does not grant coverage credit. Regenerate with `bun run compat:census-gate --update`.',
    generatedFrom: 'bun run compat:census',
    runtime: axisFrom(census, 'runtime'),
    types: axisFrom(census, 'types'),
  };
  writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + '\n');
  console.log(`Baseline updated: ${gapCount(baseline.runtime)} runtime and ${gapCount(baseline.types)} type gap(s).`);
  process.exit(0);
}

console.log('# Public-surface census gate');
const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Baseline;
const problems: string[] = [];
let resolved = 0;

for (const surface of census.surfaces) {
  for (const axis of ['runtime', 'types'] as const) {
    const previous = baseline[axis][surface.surface] ?? [];
    const current = surface[axis].unmapped;
    const previousSet = new Set(previous);
    const introduced = current.filter((symbol) => !previousSet.has(symbol));
    const paid = previous.filter((symbol) => !current.includes(symbol));
    if (introduced.length > 0) {
      problems.push(`${surface.surface} ${axis}: ${introduced.length} new public gap(s): ${introduced.join(', ')}`);
    }
    if (paid.length > 0) {
      resolved += paid.length;
      console.log(`\n${surface.surface} ${axis}: ${paid.length} baseline gap(s) resolved; regenerate the baseline:`);
      for (const symbol of paid) console.log(`  - ${symbol}`);
    }
  }

  if (surface.runtime.staleDispositions.length > 0) {
    problems.push(`${surface.surface}: stale dispositions: ${surface.runtime.staleDispositions.join(', ')}`);
  }
  if (surface.runtime.redundantDispositions.length > 0) {
    problems.push(`${surface.surface}: redundant dispositions: ${surface.runtime.redundantDispositions.join(', ')}`);
  }
}

console.log(`\nCurrent public gaps: ${census.totalRuntimeUnmapped} runtime, ${census.totalTypeUnmapped} types.`);
console.log(`Baseline tolerates: ${gapCount(baseline.runtime)} runtime, ${gapCount(baseline.types)} types.`);

if (problems.length > 0) {
  console.error(`\n✗ ${problems.length} public-surface census problem(s):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(resolved > 0
  ? '\n✓ No new public gaps or disposition decay. Baseline has resolved entries to remove.'
  : '\n✓ No new public gaps or disposition decay.');
