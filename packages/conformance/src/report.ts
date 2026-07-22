#!/usr/bin/env bun
import { buildCompatibilityLedger, highRiskUnverifiedRows, summarizeLedger } from './ledger.ts';
import { deriveConformanceModel } from './conformance-model.ts';

const model = await deriveConformanceModel();
const ledger = buildCompatibilityLedger(model);
const summary = summarizeLedger(ledger, model);
const highRiskUnverified = highRiskUnverifiedRows(ledger);
const firestoreRulesScorecard = model.rulesLanguage.firestoreScorecard;

// Climb section (cdd.md Step 7): per climb-marked surface, derived from
// registry row statuses ALONE. This informs; it never fails the run — the only
// climb-related exit-code behavior in the system is the lane's regression rule.
const CLIMB_STATUS_ORDER = ['unverified', 'diverged-documented', 'bug', 'unsupported', 'conforms'] as const;
const climbSurfaces = model.documentation.descriptors
  .filter((descriptor) => descriptor.climb)
  .map((descriptor) => {
    const rows = ledger.entries.filter((entry) => entry.surface === descriptor.surface);
    const total = rows.length;
    const conforming = rows.filter((entry) => entry.status === 'conforms').length;
    const byStatus = Object.fromEntries(
      CLIMB_STATUS_ORDER.map((status) => [status, rows.filter((entry) => entry.status === status).length]).filter(
        ([, count]) => (count as number) > 0,
      ),
    );
    return {
      surface: descriptor.surface,
      total,
      conforming,
      climbPercent: total === 0 ? 0 : Math.round((conforming / total) * 1000) / 10,
      byStatus,
    };
  });

const wantJson = process.argv.includes('--json');
const strict = process.argv.includes('--strict');

if (wantJson) {
  console.log(JSON.stringify({
    summary,
    firestoreRulesScorecard,
    climb: climbSurfaces,
    highRiskUnverified,
    orphanObservations: ledger.orphanObservations,
  }, null, 2));
  process.exit(strict && (highRiskUnverified.length > 0 || ledger.orphanObservations.length > 0) ? 1 : 0);
}

console.log('# Compatibility coverage report\n');
console.log(`Rows: ${summary.totalRows}`);
for (const descriptor of model.documentation.descriptors) console.log(`  ${descriptor.surface}: ${summary.bySurface[descriptor.surface]}`);
console.log('');
console.log(`Conforming rows: ${summary.conformingRows}`);
console.log(`Oracle-backed rows: ${summary.oracleBackedRows}`);
console.log(`Unit-backed rows: ${summary.unitBackedRows}`);
console.log(`Explicit exception rows: ${summary.explicitExceptionRows}`);
console.log(`Unsupported rows: ${summary.unsupportedRows}`);
console.log(`Unverified rows: ${summary.unverifiedRows}`);
console.log(`High-risk unverified rows: ${summary.highRiskUnverifiedRows}`);
console.log(`Unit-backed evidence-tier gap rows: ${summary.evidenceTierGapRows}`);
console.log(`Observations: ${summary.observations}`);
console.log(`Orphan observations: ${summary.orphanObservations}`);
console.log(`Registry conformance checks: ${summary.conformanceChecks}`);
console.log(
  `Firestore Rules conformance: ${firestoreRulesScorecard.score.numerator}/` +
  `${firestoreRulesScorecard.score.denominator} (${firestoreRulesScorecard.score.percent}%) — ` +
  `${firestoreRulesScorecard.counts.diverged} diverged, ` +
  `${firestoreRulesScorecard.counts.unknown} unknown, ` +
  `${firestoreRulesScorecard.counts['acceptance-mismatch']} acceptance-mismatch, ` +
  `${firestoreRulesScorecard.counts['local-unsupported']} local-unsupported, ` +
  `${firestoreRulesScorecard.counts['local-error']} local-error, ` +
  `${firestoreRulesScorecard.counts.unprobeable} unprobeable`,
);

if (climbSurfaces.length > 0) {
  console.log('\n## Climb\n');
  console.log('Surfaces climbing under CDD (registry statuses only; live suite results live in the climb lane):\n');
  for (const s of climbSurfaces) {
    const breakdown = Object.entries(s.byStatus)
      .map(([status, count]) => `${count} ${status}`)
      .join(', ');
    console.log(`- ${s.surface}: ${s.conforming}/${s.total} conforming (${s.climbPercent}%)${breakdown ? ` — ${breakdown}` : ''}`);
  }
}

if (highRiskUnverified.length > 0) {
  console.log('\n## High-risk unverified rows\n');
  for (const row of highRiskUnverified.slice(0, 30)) {
    console.log(`- ${row.id} (${row.file}:${row.line}, score ${row.riskScore}) — ${row.behavior.slice(0, 150)}${row.behavior.length > 150 ? '...' : ''}`);
    console.log(`  ${row.riskReasons.join('; ')}`);
  }
  if (highRiskUnverified.length > 30) console.log(`- ... ${highRiskUnverified.length - 30} more`);
}

if (ledger.orphanObservations.length > 0) {
  console.log('\n## Orphan observations\n');
  for (const obs of ledger.orphanObservations.slice(0, 30)) {
    console.log(`- ${obs.name} (${obs.matrixRow || 'no matrixRow'})`);
  }
  if (ledger.orphanObservations.length > 30) console.log(`- ... ${ledger.orphanObservations.length - 30} more`);
}

if (highRiskUnverified.length === 0 && ledger.orphanObservations.length === 0) {
  console.log('\n✓ Compatibility ledger has no high-risk unverified rows and no orphan observations.');
  process.exit(0);
}

console.log('\n! Compatibility coverage has unresolved high-risk rows or orphan observations. Run with --strict to fail on this debt.');
process.exit(strict ? 1 : 0);
