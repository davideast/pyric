#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import {
  computeFirestoreRulesScorecard,
} from './firestore-rules-scorecard.ts';
import {
  FIRESTORE_SCORECARD_BASELINE_PATH,
  firestoreScorecardBaseline,
  compareFirestoreScorecardBaseline,
  type FirestoreScorecardBaseline,
} from './firestore-rules-scorecard-gate.ts';
import {
  computeStorageRulesScorecard,
} from './storage-rules-scorecard.ts';
import {
  STORAGE_SCORECARD_BASELINE_PATH,
  storageScorecardBaseline,
  compareStorageScorecardBaseline,
  type StorageScorecardBaseline,
} from './storage-rules-scorecard-gate.ts';
import {
  computeRtdbRulesScorecard,
} from './rtdb-rules-scorecard.ts';
import {
  RTDB_SCORECARD_BASELINE_PATH,
  rtdbScorecardBaseline,
  compareRtdbScorecardBaseline,
  type RtdbScorecardBaseline,
} from './rtdb-rules-scorecard-gate.ts';

async function main(): Promise<void> {
  const [firestore, storage, rtdb] = await Promise.all([
    computeFirestoreRulesScorecard(),
    computeStorageRulesScorecard(),
    computeRtdbRulesScorecard(),
  ]);

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ firestore, storage, rtdb }, null, 2));
    return;
  }

  if (process.argv.includes('--update')) {
    writeFileSync(
      FIRESTORE_SCORECARD_BASELINE_PATH,
      JSON.stringify(firestoreScorecardBaseline(firestore), null, 2) + '\n',
      'utf8',
    );
    writeFileSync(
      STORAGE_SCORECARD_BASELINE_PATH,
      JSON.stringify(storageScorecardBaseline(storage), null, 2) + '\n',
      'utf8',
    );
    writeFileSync(
      RTDB_SCORECARD_BASELINE_PATH,
      JSON.stringify(rtdbScorecardBaseline(rtdb), null, 2) + '\n',
      'utf8',
    );
    console.log(
      `Updated Firestore Rules scorecard baseline: ${firestore.score.numerator}/${firestore.score.denominator} ` +
        `(${firestore.score.percent}%), universe ${firestore.universe.hash}`,
    );
    console.log(
      `Updated Storage Rules scorecard baseline:   ${storage.score.numerator}/${storage.score.denominator} ` +
        `(${storage.score.percent}%), universe ${storage.universe.hash}`,
    );
    console.log(
      `Updated RTDB Rules scorecard baseline:      ${rtdb.score.numerator}/${rtdb.score.denominator} ` +
        `(${rtdb.score.percent}%), universe ${rtdb.universe.hash}`,
    );
    return;
  }

  if (
    !existsSync(FIRESTORE_SCORECARD_BASELINE_PATH) ||
    !existsSync(STORAGE_SCORECARD_BASELINE_PATH) ||
    !existsSync(RTDB_SCORECARD_BASELINE_PATH)
  ) {
    console.error('One or more scorecard baselines are missing; run compat:rules-score -- --update after review.');
    process.exitCode = 1;
    return;
  }

  const baseFirestore = JSON.parse(readFileSync(FIRESTORE_SCORECARD_BASELINE_PATH, 'utf8')) as FirestoreScorecardBaseline;
  const baseStorage = JSON.parse(readFileSync(STORAGE_SCORECARD_BASELINE_PATH, 'utf8')) as StorageScorecardBaseline;
  const baseRtdb = JSON.parse(readFileSync(RTDB_SCORECARD_BASELINE_PATH, 'utf8')) as RtdbScorecardBaseline;

  const compFirestore = compareFirestoreScorecardBaseline(baseFirestore, firestore);
  const compStorage = compareStorageScorecardBaseline(baseStorage, storage);
  const compRtdb = compareRtdbScorecardBaseline(baseRtdb, rtdb);

  console.log('# Security Rules Construct Conformance Scorecards');
  console.log(
    `Firestore Rules conformance: ${firestore.score.numerator}/${firestore.score.denominator} ` +
      `(${firestore.score.percent}%) — ${firestore.counts.diverged} diverged, ` +
      `${firestore.counts.unknown} unknown, ${firestore.counts['acceptance-mismatch']} acceptance-mismatch, ` +
      `${firestore.counts['local-unsupported']} local-unsupported, ${firestore.counts['local-error']} local-error, ` +
      `${firestore.counts.unprobeable} unprobeable.`,
  );
  console.log(
    `Storage Rules conformance:   ${storage.score.numerator}/${storage.score.denominator} ` +
      `(${storage.score.percent}%) — ${storage.counts.diverged} diverged, ` +
      `${storage.counts.unknown} unknown, ${storage.counts['acceptance-mismatch']} acceptance-mismatch, ` +
      `${storage.counts['local-unsupported']} local-unsupported, ${storage.counts['local-error']} local-error, ` +
      `${storage.counts.unprobeable} unprobeable.`,
  );
  console.log(
    `RTDB Rules conformance:      ${rtdb.score.numerator}/${rtdb.score.denominator} ` +
      `(${rtdb.score.percent}%) — ${rtdb.counts.diverged} diverged, ` +
      `${rtdb.counts.unknown} unknown, ` +
      `${rtdb.counts['local-unsupported']} local-unsupported, ${rtdb.counts['local-error']} local-error, ` +
      `${rtdb.counts.unprobeable} unprobeable.`,
  );

  const showBreakdown = process.argv.includes('--breakdown') || process.argv.includes('--verbose');
  if (showBreakdown) {
    const logBreakdown = (
      title: string,
      sc: { constructs: ReadonlyArray<{ id: string; classification: string; localCapability?: string; divergedByRows?: readonly string[]; verifiedByRows?: readonly string[] }> },
    ) => {
      console.log(`\n--- ${title} Breakdown ---`);
      const nonConforming = sc.constructs.filter((c) => c.classification !== 'conformant');
      if (nonConforming.length === 0) {
        console.log('  All constructs conform cleanly.');
        return;
      }
      for (const c of nonConforming) {
        const divergedStr = c.divergedByRows && c.divergedByRows.length > 0 ? ` (diverged by: ${c.divergedByRows.join(', ')})` : '';
        const verifiedStr = c.verifiedByRows && c.verifiedByRows.length > 0 ? ` (verified by: ${c.verifiedByRows.join(', ')})` : '';
        console.log(`  [${c.classification}] ${c.id}${divergedStr}${verifiedStr}${c.localCapability === 'unsupported' ? ' [local: unsupported]' : ''}`);
      }
    };
    logBreakdown('Firestore Rules', firestore);
    logBreakdown('Storage Rules', storage);
    logBreakdown('RTDB Rules', rtdb);
  } else {
    console.log('Tip: Pass --breakdown (e.g. bun run compat:rules-score -- --breakdown) to inspect each non-conformant finding.');
  }


  const totalChanges =
    compFirestore.universeChanges.length +
    compFirestore.factChanges.length +
    compFirestore.aggregateChanges.length +
    compStorage.universeChanges.length +
    compStorage.factChanges.length +
    compStorage.aggregateChanges.length +
    compRtdb.universeChanges.length +
    compRtdb.factChanges.length +
    compRtdb.aggregateChanges.length;

  if (totalChanges === 0) {
    console.log('✓ Scores, denominators, and per-construct facts match committed baselines across all engines.');
    return;
  }

  console.error(`\n✗ Security Rules scorecards changed in ${totalChanges} way(s):`);
  const logEngineChanges = (name: string, comp: { universeChanges: string[]; factChanges: string[]; aggregateChanges: string[] }) => {
    const list = [...comp.universeChanges, ...comp.factChanges, ...comp.aggregateChanges];
    if (list.length > 0) {
      console.error(`  [${name}]:`);
      for (const item of list) console.error(`    - ${item}`);
    }
  };
  logEngineChanges('firestore', compFirestore);
  logEngineChanges('storage', compStorage);
  logEngineChanges('rtdb', compRtdb);

  process.exitCode = 1;
}

if (import.meta.main) await main();
