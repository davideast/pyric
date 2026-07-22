#!/usr/bin/env bun
/**
 * Registry-backed audit for COMPAT rows whose claim outruns their evidence:
 * high-risk unverified rows that claim conformance without oracle
 * observations, local tests, or explicit exceptions, plus the sibling
 * evidence-tier worklist — unit-backed ✓ rows whose own risk taxonomy says
 * the behavior is unobserved (or cited but not replayed).
 *
 * The old audit inferred risk and exceptions by regexing prose directly. That
 * was useful when the matrices were small; the compatibility ledger now parses
 * every row into structured metadata and keeps the prose heuristic as the
 * fallback classifier in one place (`packages/conformance/src/ledger.ts`).
 *
 * Usage:
 *   bun run packages/conformance/src/audit.ts
 *   bun run packages/conformance/src/audit.ts --json
 */
import { buildCompatibilityLedger, evidenceTierGapRows, highRiskUnverifiedRows, summarizeLedger, type RegistryEntry } from './ledger.ts';
import { deriveConformanceModel } from './conformance-model.ts';

const model = await deriveConformanceModel();
const ledger = buildCompatibilityLedger(model);
const summary = summarizeLedger(ledger, model);

const candidates = highRiskUnverifiedRows(ledger);
const tierGaps = evidenceTierGapRows(ledger);

const skippedSandbox = ledger.entries.filter((row) => row.automation === 'sandbox-only');
const skippedStructural = ledger.entries.filter((row) => row.automation === 'type-backed');
const skippedPlayground = ledger.entries.filter((row) => row.automation === 'playground-only');

const toJsonRow = (row: RegistryEntry) => ({
  id: row.id,
  matrix: row.matrix,
  number: row.rowNumber ?? 0,
  rowRef: row.rowRef,
  behavior: row.behavior,
  status: row.status,
  probe: row.evidence,
  section: row.section,
  hasOracle: row.hasOracle,
  hasTestEvidence: row.hasTestEvidence,
  automation: row.automation,
  riskScore: row.riskScore,
  riskReasons: row.riskReasons,
});

const jsonCandidates = candidates.map(toJsonRow);
const jsonTierGaps = tierGaps.map(toJsonRow);

const wantJson = process.argv.includes('--json');
if (wantJson) {
  console.log(JSON.stringify({
    summary: {
      totalRows: summary.totalRows,
      authRows: summary.bySurface.auth,
      firestoreRows: summary.bySurface.firestore,
      storageRows: summary.bySurface.storage,
      rtdbRows: summary.bySurface.rtdb + summary.bySurface['rtdb-modular'],
      oracleLocked: summary.oracleBackedRows,
      unitBacked: summary.unitBackedRows,
      explicitExceptions: summary.explicitExceptionRows,
      unverifiedAnyStatus: summary.unverifiedRows,
      highRiskUnverified: candidates.length,
      evidenceTierGaps: tierGaps.length,
      skippedSandboxOnly: skippedSandbox.length,
      skippedStructuralShape: skippedStructural.length,
      skippedPlaygroundOnly: skippedPlayground.length,
      orphanObservations: summary.orphanObservations,
    },
    candidates: jsonCandidates,
    evidenceTierGaps: jsonTierGaps,
    skipped: {
      sandboxOnly: skippedSandbox,
      structuralShape: skippedStructural,
      playgroundOnly: skippedPlayground,
    },
  }, null, 2));
  process.exit(0);
}

console.log('# Compatibility audit — high-risk unverified matrix rows\n');
console.log(`**Total rows:** ${summary.totalRows} (auth: ${summary.bySurface.auth}, firestore: ${summary.bySurface.firestore}, rtdb: ${summary.bySurface.rtdb + summary.bySurface['rtdb-modular']}, storage: ${summary.bySurface.storage})`);
console.log(`**Oracle-backed:** ${summary.oracleBackedRows}`);
console.log(`**Unit-backed:** ${summary.unitBackedRows}`);
console.log(`**Explicit exceptions:** ${summary.explicitExceptionRows}`);
console.log(`**Unverified (any status):** ${summary.unverifiedRows}`);
console.log(`**Unverified + status ✓ + high-risk (score >= 2):** ${candidates.length}`);
console.log(`**Unit-backed ✓ + evidence-tier gap (unobserved / cited-not-replayed):** ${tierGaps.length}`);
console.log(`**Orphan observations:** ${summary.orphanObservations}`);
console.log();

function printWorklist(rows: typeof candidates): void {
  let lastMatrix = '';
  for (const row of rows) {
    if (row.matrix !== lastMatrix) {
      console.log(`### ${row.matrix}\n`);
      lastMatrix = row.matrix;
    }
    console.log(`- **${row.id}** (score ${row.riskScore}) — ${row.behavior.slice(0, 160)}${row.behavior.length > 160 ? '...' : ''}`);
    console.log(`  - ${row.riskReasons.join('; ')}`);
  }
}

if (candidates.length === 0) {
  console.log('## Ranked worklist\n');
  console.log('No high-risk conforming rows are missing oracle/test evidence or an explicit exception.');
} else {
  console.log('## Ranked worklist\n');
  printWorklist(candidates);
}

console.log('\n## Evidence-tier worklist — unit-backed ✓ rows whose behavior is unobserved\n');
if (tierGaps.length === 0) {
  console.log('No unit-backed conforming row carries an unobserved / cited-not-replayed climb risk.');
} else {
  printWorklist(tierGaps);
}

if (ledger.orphanObservations.length > 0) {
  console.log('\n## Orphan observations\n');
  for (const obs of ledger.orphanObservations) console.log(`- ${obs.name} — ${obs.matrixRow || 'no matrixRow'}`);
}
