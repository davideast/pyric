#!/usr/bin/env bun
import { buildCompatibilityLedger, summarizeLedger } from './ledger.ts';

const ledger = buildCompatibilityLedger();
const summary = summarizeLedger(ledger);
const highRiskUnverified = ledger.entries
  .filter((e) => e.isConforming && e.riskScore >= 2 && e.automation === 'unverified')
  .sort((a, b) => b.riskScore - a.riskScore || a.id.localeCompare(b.id));

const wantJson = process.argv.includes('--json');
const strict = process.argv.includes('--strict');

if (wantJson) {
  console.log(JSON.stringify({ summary, highRiskUnverified, orphanObservations: ledger.orphanObservations }, null, 2));
  process.exit(strict && (highRiskUnverified.length > 0 || ledger.orphanObservations.length > 0) ? 1 : 0);
}

console.log('# Compatibility coverage report\n');
console.log(`Rows: ${summary.totalRows}`);
console.log(`  auth: ${summary.bySurface.auth}`);
console.log(`  firestore: ${summary.bySurface.firestore}`);
console.log(`  rtdb: ${summary.bySurface.rtdb}`);
console.log(`  rtdb-modular: ${summary.bySurface['rtdb-modular']}`);
console.log(`  storage: ${summary.bySurface.storage}`);
console.log('');
console.log(`Conforming rows: ${summary.conformingRows}`);
console.log(`Oracle-backed rows: ${summary.oracleBackedRows}`);
console.log(`Unit-backed rows: ${summary.unitBackedRows}`);
console.log(`Explicit exception rows: ${summary.explicitExceptionRows}`);
console.log(`Unsupported rows: ${summary.unsupportedRows}`);
console.log(`Unverified rows: ${summary.unverifiedRows}`);
console.log(`High-risk unverified rows: ${summary.highRiskUnverifiedRows}`);
console.log(`Observations: ${summary.observations}`);
console.log(`Orphan observations: ${summary.orphanObservations}`);
console.log(`Registry conformance checks: ${summary.conformanceChecks}`);

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
