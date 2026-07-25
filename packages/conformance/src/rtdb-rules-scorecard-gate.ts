#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  computeRtdbRulesScorecard,
  type RtdbConstructScore,
  type RtdbRulesScorecard,
} from './rtdb-rules-scorecard.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
export const RTDB_SCORECARD_BASELINE_PATH = join(
  HERE,
  '..',
  'baselines',
  'rtdb-rules-scorecard.json',
);

export interface RtdbScorecardBaseline {
  schema: 'pyric.conformance.rtdb-rules-scorecard-baseline.v1';
  generatedNote: string;
  universe: RtdbRulesScorecard['universe'];
  score: RtdbRulesScorecard['score'];
  axes: RtdbRulesScorecard['axes'];
  counts: RtdbRulesScorecard['counts'];
  constructs: Readonly<Record<string, Pick<
    RtdbConstructScore,
    'productionAcceptance' | 'localAcceptance' |
    'localCapability' | 'productionEvidence' |
    'classification' | 'verifiedBy' | 'verifiedByRows' | 'divergedByRows'
  >>>;
}

export function rtdbScorecardBaseline(
  scorecard: RtdbRulesScorecard,
): RtdbScorecardBaseline {
  return {
    schema: 'pyric.conformance.rtdb-rules-scorecard-baseline.v1',
    generatedNote:
      'Exact Realtime Database Rules conformance ratchet. Update only with reviewed evidence or implementation changes.',
    universe: scorecard.universe,
    score: scorecard.score,
    axes: scorecard.axes,
    counts: scorecard.counts,
    constructs: Object.fromEntries(scorecard.constructs.map((construct) => [construct.id, {
      productionAcceptance: construct.productionAcceptance,
      localAcceptance: construct.localAcceptance,
      localCapability: construct.localCapability,
      productionEvidence: construct.productionEvidence,
      classification: construct.classification,
      verifiedBy: construct.verifiedBy,
      verifiedByRows: construct.verifiedByRows,
      divergedByRows: construct.divergedByRows,
    }])),
  };
}

export interface ScorecardBaselineComparison {
  universeChanges: string[];
  factChanges: string[];
  aggregateChanges: string[];
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

export function compareRtdbScorecardBaseline(
  baseline: RtdbScorecardBaseline,
  current: RtdbRulesScorecard,
): ScorecardBaselineComparison {
  const universeChanges: string[] = [];
  const factChanges: string[] = [];
  const aggregateChanges: string[] = [];
  const baselineIds = baseline.universe.constructIds;
  const currentIds = current.universe.constructIds;
  const baselineSet = new Set(baselineIds);
  const currentSet = new Set(currentIds);
  const added = currentIds.filter((id) => !baselineSet.has(id));
  const removed = baselineIds.filter((id) => !currentSet.has(id));
  if (added.length > 0) universeChanges.push(`constructs added: ${added.join(', ')}`);
  if (removed.length > 0) universeChanges.push(`constructs removed: ${removed.join(', ')}`);
  if (baseline.universe.denominator !== current.universe.denominator) {
    universeChanges.push(`denominator ${baseline.universe.denominator} -> ${current.universe.denominator}`);
  }
  if (baseline.universe.hash !== current.universe.hash) {
    universeChanges.push(`ordered-universe hash ${baseline.universe.hash} -> ${current.universe.hash}`);
  }

  const currentById = new Map(current.constructs.map((construct) => [construct.id, construct]));
  const baselineFactIds = Object.keys(baseline.constructs);
  const baselineFactSet = new Set(baselineFactIds);
  const currentFactSet = new Set(currentById.keys());
  for (const id of baselineIds) {
    if (!baselineFactSet.has(id)) factChanges.push(`${id}: baseline construct facts missing`);
    if (!currentFactSet.has(id)) factChanges.push(`${id}: current construct facts missing`);
  }
  for (const id of baselineFactIds.filter((id) => !baselineSet.has(id)).sort()) {
    factChanges.push(`${id}: baseline construct facts outside universe`);
  }
  for (const id of [...currentFactSet].filter((id) => !currentSet.has(id)).sort()) {
    factChanges.push(`${id}: current construct facts outside universe`);
  }
  for (const id of [...new Set([...baselineIds, ...currentIds])].sort()) {
    const before = baseline.constructs[id];
    const after = currentById.get(id);
    if (!before || !after) continue;
    for (const field of [
      'productionAcceptance',
      'localAcceptance',
      'localCapability',
      'productionEvidence',
      'classification',
    ] as const) {
      if (before[field] !== after[field]) {
        factChanges.push(`${id}: ${field} ${before[field]} -> ${after[field]}`);
      }
    }
    for (const field of ['verifiedBy', 'verifiedByRows', 'divergedByRows'] as const) {
      if (json(before[field]) !== json(after[field])) {
        factChanges.push(`${id}: ${field} ${json(before[field])} -> ${json(after[field])}`);
      }
    }
  }

  if (json(baseline.score) !== json(current.score)) {
    aggregateChanges.push(
      `score ${baseline.score.numerator}/${baseline.score.denominator} (${baseline.score.percent}%) -> ` +
      `${current.score.numerator}/${current.score.denominator} (${current.score.percent}%)`,
    );
  }
  if (json(baseline.axes) !== json(current.axes)) aggregateChanges.push('per-axis counts changed');
  if (json(baseline.counts) !== json(current.counts)) aggregateChanges.push('classification counts changed');
  return { universeChanges, factChanges, aggregateChanges };
}

async function main(): Promise<void> {
  const scorecard = await computeRtdbRulesScorecard();
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(scorecard, null, 2));
    return;
  }
  if (process.argv.includes('--update')) {
    writeFileSync(
      RTDB_SCORECARD_BASELINE_PATH,
      JSON.stringify(rtdbScorecardBaseline(scorecard), null, 2) + '\n',
      'utf8',
    );
    console.log(
      `Updated RTDB Rules scorecard baseline: ${scorecard.score.numerator}/${scorecard.score.denominator} ` +
      `(${scorecard.score.percent}%), universe ${scorecard.universe.hash}`,
    );
    return;
  }
  if (!existsSync(RTDB_SCORECARD_BASELINE_PATH)) {
    console.error('RTDB Rules scorecard baseline is missing; run compat:rules-score -- --update after review.');
    process.exitCode = 1;
    return;
  }
  const baseline = JSON.parse(readFileSync(RTDB_SCORECARD_BASELINE_PATH, 'utf8')) as RtdbScorecardBaseline;
  const comparison = compareRtdbScorecardBaseline(baseline, scorecard);
  const changes = [
    ...comparison.universeChanges,
    ...comparison.factChanges,
    ...comparison.aggregateChanges,
  ];
  console.log(
    `RTDB Rules conformance:      ${scorecard.score.numerator}/${scorecard.score.denominator} ` +
    `(${scorecard.score.percent}%) — ${scorecard.counts.diverged} diverged, ` +
    `${scorecard.counts.unknown} unknown, ` +
    `${scorecard.counts['local-unsupported']} local-unsupported, ${scorecard.counts['local-error']} local-error, ` +
    `${scorecard.counts.unprobeable} unprobeable.`,
  );
  if (changes.length === 0) {
    console.log('✓ Score, denominator, and per-construct facts match the committed baseline.');
    return;
  }
  console.error(`✗ RTDB Rules scorecard changed in ${changes.length} way(s):`);
  for (const change of changes) console.error(`  - ${change}`);
  process.exitCode = 1;
}

if (import.meta.main) await main();
