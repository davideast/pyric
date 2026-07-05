#!/usr/bin/env bun
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildCompatibilityLedger, REPO_ROOT, summarizeLedger } from './ledger.ts';

const ledger = buildCompatibilityLedger();
const summary = summarizeLedger(ledger);
const problems: string[] = [];

const ids = new Map<string, number>();
for (const row of ledger.rows) ids.set(row.id, (ids.get(row.id) ?? 0) + 1);
for (const [id, count] of ids) if (count > 1) problems.push(`duplicate row id: ${id} (${count} rows)`);

for (const [surface, count] of Object.entries(summary.bySurface)) {
  if (count === 0) problems.push(`surface has no rows: ${surface}`);
}

const authRows = ledger.entries.filter((e) => e.matrix === 'auth');
if (authRows.length === 0) problems.push('Auth pilot registry has no rows.');

for (const row of authRows) {
  if (!row.status.trim()) problems.push(`${row.id}: missing status`);
  if (!row.behavior.trim()) problems.push(`${row.id}: missing behavior`);
  if (row.isConforming && row.automation === 'unverified') {
    problems.push(`${row.id}: conforming Auth row lacks oracle/test evidence or an explicit exception`);
  }
}

const rowLookup = new Set<string>();
for (const row of ledger.rows) {
  rowLookup.add(row.id);
  for (const alias of row.aliases) rowLookup.add(alias);
}

const exceptions = ledger.overlay.observationExceptions ?? {};
for (const obs of ledger.observations) {
  if (exceptions[obs.name]) continue;
  if (obs.rowIds.length === 0) {
    problems.push(`${obs.file}: matrixRow '${obs.matrixRow}' does not contain a parseable row id`);
    continue;
  }
  if (obs.rowIds.every((id) => !rowLookup.has(id))) {
    problems.push(`${obs.file}: matrixRow '${obs.matrixRow}' does not match a COMPAT row`);
  }
}

const observationNames = new Set(ledger.observations.map((obs) => obs.name));
for (const check of ledger.overlay.conformanceChecks) {
  if (!observationNames.has(check.observation)) problems.push(`${check.finding}: observation '${check.observation}.json' is missing`);
  if (!existsSync(join(REPO_ROOT, check.probe))) problems.push(`${check.finding}: probe '${check.probe}' is missing`);
  const obs = ledger.observations.find((o) => o.name === check.observation);
  if (obs && obs.rowIds.every((id) => !rowLookup.has(id))) {
    problems.push(`${check.finding}: observation '${check.observation}.json' does not map to a known row`);
  }
  for (const key of Object.keys(check.expect)) {
    if (obs && !(key in obs.behavior)) problems.push(`${check.finding}: expected behavior key '${key}' is missing from ${check.observation}.json`);
  }
}

const wantJson = process.argv.includes('--json');
if (wantJson) {
  console.log(JSON.stringify({ summary, problems }, null, 2));
} else {
  console.log('# Compatibility registry validation\n');
  console.log(`Rows: ${summary.totalRows}`);
  console.log(`Observations: ${summary.observations}`);
  console.log(`Conformance checks: ${summary.conformanceChecks}`);
  console.log(`Problems: ${problems.length}`);
  if (problems.length > 0) {
    console.log('');
    for (const problem of problems) console.error(`- ${problem}`);
  }
}

process.exit(problems.length === 0 ? 0 : 1);
