#!/usr/bin/env bun
/**
 * Ratchet over the public Firebase runtime and type export gaps.
 *
 * Known gaps are committed in `census-baseline.json`. A new public export that
 * Pyric does not mirror fails this gate on the correct axis. Private Firebase
 * runtime exports never enter either baseline. Stale and redundant public
 * dispositions are always fatal.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync } from 'node:fs';
import { deriveConformanceModel, type ConformanceModel } from './conformance-model.ts';
import { censusGapProblems, censusIntegrityProblems } from './census-policy.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = join(HERE, '..', 'baselines', 'census-baseline.json');

interface Baseline {
  _comment: string;
  generatedFrom: string;
  runtime: Record<string, string[]>;
  types: Record<string, string[]>;
}

function axisFrom(census: ConformanceModel['census'], axis: 'runtime' | 'types'): Record<string, string[]> {
  return Object.fromEntries(census.map((surface) => [surface.surface, [...surface[axis].unmapped].sort()]));
}

function gapCount(axis: Record<string, string[]>): number {
  return Object.values(axis).reduce((count, gaps) => count + gaps.length, 0);
}

const { census } = await deriveConformanceModel({ enforceCensusPolicy: false });

if (process.argv.includes('--update')) {
  const baseline: Baseline = {
    _comment:
      'Known unmapped PUBLIC Firebase type exports tolerated by the census ratchet. Runtime gaps are never baseline-tolerated and must be classified in a surface contract. Every type entry remains in the public coverage denominator; the baseline prevents new gaps, it does not grant coverage credit. Regenerate with `bun run compat:census-gate --update`.',
    generatedFrom: 'deriveConformanceModel().census',
    runtime: {},
    types: axisFrom(census, 'types'),
  };
  writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + '\n');
  console.log(`Baseline updated: ${gapCount(baseline.runtime)} runtime and ${gapCount(baseline.types)} type gap(s).`);
  process.exit(0);
}

console.log('# Public-surface census gate');
const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Baseline;
const problems = [
  ...censusGapProblems(census, baseline),
  ...censusIntegrityProblems(census),
];
let resolved = 0;

for (const surface of census) {
  const previous = baseline.types[surface.surface] ?? [];
  const current = surface.types.unmapped;
  const paid = previous.filter((symbol) => !current.includes(symbol));
  if (paid.length > 0) {
    resolved += paid.length;
    console.log(`\n${surface.surface} types: ${paid.length} baseline gap(s) resolved; regenerate the baseline:`);
    for (const symbol of paid) console.log(`  - ${symbol}`);
  }
}

console.log(`\nCurrent public gaps: ${gapCount(axisFrom(census, 'runtime'))} runtime, ${gapCount(axisFrom(census, 'types'))} types.`);
console.log(`Baseline tolerates: ${gapCount(baseline.runtime)} runtime, ${gapCount(baseline.types)} types.`);

if (problems.length > 0) {
  console.error(`\n✗ ${problems.length} public-surface census problem(s):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(resolved > 0
  ? '\n✓ No new public gaps or disposition decay. Baseline has resolved entries to remove.'
  : '\n✓ No new public gaps or disposition decay.');
