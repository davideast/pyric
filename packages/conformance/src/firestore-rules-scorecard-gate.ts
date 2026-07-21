#!/usr/bin/env bun
/**
 * Exact baseline gate for the Firestore Rules scorecard.
 *
 * Unlike a threshold gate, this requires every score movement to update a
 * reviewable committed baseline. The baseline carries the full ordered
 * universe and per-construct facts, so denominator changes and reclassification
 * cannot hide behind a rounded percentage.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  computeFirestoreRulesScorecard,
  type FirestoreConstructScore,
  type FirestoreRulesScorecard,
} from './firestore-rules-scorecard.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
export const FIRESTORE_SCORECARD_BASELINE_PATH = join(
  HERE,
  '..',
  'baselines',
  'firestore-rules-scorecard.json',
);

export interface FirestoreScorecardBaseline {
  schema: 'pyric.conformance.firestore-rules-scorecard-baseline.v1';
  generatedNote: string;
  universe: FirestoreRulesScorecard['universe'];
  score: FirestoreRulesScorecard['score'];
  axes: FirestoreRulesScorecard['axes'];
  counts: FirestoreRulesScorecard['counts'];
  constructs: Readonly<Record<string, Pick<
    FirestoreConstructScore,
    'productionAcceptance' | 'localAcceptance' | 'productionRejectionSignature' | 'localRejectionSignature' |
    'localCapability' | 'productionEvidence' | 'classification'
  >>>;
}

export function firestoreScorecardBaseline(
  scorecard: FirestoreRulesScorecard,
): FirestoreScorecardBaseline {
  return {
    schema: 'pyric.conformance.firestore-rules-scorecard-baseline.v1',
    generatedNote:
      'Exact Firestore Rules conformance ratchet. Update only with reviewed evidence or implementation changes. ' +
      'Every construct remains in the denominator; the ordered ids and per-axis facts make score movement auditable.',
    universe: scorecard.universe,
    score: scorecard.score,
    axes: scorecard.axes,
    counts: scorecard.counts,
    constructs: Object.fromEntries(scorecard.constructs.map((construct) => [construct.id, {
      productionAcceptance: construct.productionAcceptance,
      localAcceptance: construct.localAcceptance,
      ...(construct.productionRejectionSignature ? { productionRejectionSignature: construct.productionRejectionSignature } : {}),
      ...(construct.localRejectionSignature ? { localRejectionSignature: construct.localRejectionSignature } : {}),
      localCapability: construct.localCapability,
      productionEvidence: construct.productionEvidence,
      classification: construct.classification,
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

export function compareFirestoreScorecardBaseline(
  baseline: FirestoreScorecardBaseline,
  current: FirestoreRulesScorecard,
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
      'productionRejectionSignature',
      'localRejectionSignature',
      'localCapability',
      'productionEvidence',
      'classification',
    ] as const) {
      if (before[field] !== after[field]) {
        factChanges.push(`${id}: ${field} ${before[field]} -> ${after[field]}`);
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
  const scorecard = await computeFirestoreRulesScorecard();
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(scorecard, null, 2));
    return;
  }
  if (process.argv.includes('--update')) {
    writeFileSync(
      FIRESTORE_SCORECARD_BASELINE_PATH,
      JSON.stringify(firestoreScorecardBaseline(scorecard), null, 2) + '\n',
      'utf8',
    );
    console.log(
      `Updated Firestore Rules scorecard baseline: ${scorecard.score.numerator}/${scorecard.score.denominator} ` +
      `(${scorecard.score.percent}%), universe ${scorecard.universe.hash}`,
    );
    return;
  }
  if (!existsSync(FIRESTORE_SCORECARD_BASELINE_PATH)) {
    console.error('Firestore Rules scorecard baseline is missing; run compat:rules-score -- --update after review.');
    process.exitCode = 1;
    return;
  }
  const baseline = JSON.parse(readFileSync(FIRESTORE_SCORECARD_BASELINE_PATH, 'utf8')) as FirestoreScorecardBaseline;
  const comparison = compareFirestoreScorecardBaseline(baseline, scorecard);
  const changes = [
    ...comparison.universeChanges,
    ...comparison.factChanges,
    ...comparison.aggregateChanges,
  ];
  console.log(
    `Firestore Rules conformance: ${scorecard.score.numerator}/${scorecard.score.denominator} ` +
    `(${scorecard.score.percent}%) — ${scorecard.counts.diverged} diverged, ` +
    `${scorecard.counts.unknown} unknown, ${scorecard.counts['acceptance-mismatch']} acceptance-mismatch, ` +
    `${scorecard.counts['local-unsupported']} local-unsupported, ${scorecard.counts['local-error']} local-error, ` +
    `${scorecard.counts.unprobeable} unprobeable.`,
  );
  if (changes.length === 0) {
    console.log('✓ Score, denominator, and per-construct facts match the committed baseline.');
    return;
  }
  console.error(`✗ Firestore Rules scorecard changed in ${changes.length} way(s):`);
  for (const change of changes) console.error(`  - ${change}`);
  console.error('Review the evidence/implementation delta, then update the baseline explicitly.');
  process.exitCode = 1;
}

if (import.meta.main) await main();
