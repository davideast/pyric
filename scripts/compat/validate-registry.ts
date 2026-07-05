#!/usr/bin/env bun
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { allCompatibilityRows, observationExceptions, surfaceRegistries, type Automation, type CompatibilityRow, type CompatibilitySurfaceRegistry } from './registry/index.ts';
import { buildCompatibilityLedger, loadObservations, parseObservationRowIds, REPO_ROOT, summarizeLedger, type Observation } from './ledger.ts';
import { checkGeneratedMarkdown } from './generate-docs.ts';

const allowedAutomation = new Set<Automation>([
  'oracle-backed',
  'unit-backed',
  'type-backed',
  'sandbox-only',
  'playground-only',
  'unsupported',
  'unverified',
]);

export interface ValidationInput {
  rows: CompatibilityRow[];
  surfaces: CompatibilitySurfaceRegistry[];
  observations: Observation[];
  observationExceptions: Record<string, string>;
  checkMarkdown?: boolean;
}

export function validateCompatibilityRegistry(input: ValidationInput): string[] {
  const problems: string[] = [];
  const ids = new Map<string, number>();
  const observationNames = new Set(input.observations.map((obs) => obs.name));
  const rowIds = new Set<string>();

  for (const row of input.rows) {
    ids.set(row.id, (ids.get(row.id) ?? 0) + 1);
    rowIds.add(row.id);
    for (const alias of row.aliases) rowIds.add(alias);

    if (row.id !== `${row.surface}#${row.rowRef}`) problems.push(`${row.id}: id must equal surface#rowRef`);
    if (!row.section.trim()) problems.push(`${row.id}: missing section`);
    if (!row.api.trim()) problems.push(`${row.id}: missing api`);
    if (!row.behavior.trim()) problems.push(`${row.id}: missing behavior`);
    if (!row.status.trim()) problems.push(`${row.id}: missing status`);
    if (!allowedAutomation.has(row.automation)) problems.push(`${row.id}: invalid automation '${row.automation}'`);
    if (['sandbox-only', 'playground-only', 'unsupported'].includes(row.automation) && !row.exceptionReason?.trim()) {
      problems.push(`${row.id}: ${row.automation} rows require exceptionReason`);
    }
    if (row.riskScore > 0 && row.riskReasons.length === 0) problems.push(`${row.id}: riskScore > 0 requires riskReasons`);
    if (row.automation === 'oracle-backed' && row.oracleObservations.length === 0) problems.push(`${row.id}: oracle-backed row has no oracleObservations`);
    if (row.automation === 'unit-backed' && row.conformanceTests.length === 0) problems.push(`${row.id}: unit-backed row has no conformanceTests`);

    for (const observation of row.oracleObservations) {
      if (!observationNames.has(observation)) problems.push(`${row.id}: observation '${observation}.json' is missing`);
    }
    for (const testPath of row.conformanceTests) {
      if (!existsSync(join(REPO_ROOT, testPath))) problems.push(`${row.id}: conformance test '${testPath}' is missing`);
    }
    for (const check of row.conformanceChecks ?? []) {
      if (!observationNames.has(check.observation)) problems.push(`${row.id}: check ${check.finding} observation '${check.observation}.json' is missing`);
      if (!existsSync(join(REPO_ROOT, check.probe))) problems.push(`${row.id}: check ${check.finding} probe '${check.probe}' is missing`);
      const obs = input.observations.find((candidate) => candidate.name === check.observation);
      for (const key of Object.keys(check.expect)) {
        if (obs && !(key in obs.behavior)) problems.push(`${row.id}: check ${check.finding} expected behavior key '${key}' is missing from ${check.observation}.json`);
      }
    }
  }

  for (const [id, count] of ids) if (count > 1) problems.push(`duplicate row id: ${id} (${count} rows)`);

  for (const surface of input.surfaces) {
    const surfaceRows = surface.blocks.flatMap((block) => block.kind === 'table' ? block.rows : []);
    if (surfaceRows.length === 0) problems.push(`${surface.surface}: surface has no rows`);
    for (const row of surfaceRows) {
      if (row.surface !== surface.surface && !(surface.surface === 'rtdb' && row.surface === 'rtdb-modular')) {
        problems.push(`${row.id}: row surface does not belong in ${surface.compatPath}`);
      }
    }
  }

  const referencedObservations = new Set<string>();
  for (const row of input.rows) {
    for (const observation of row.oracleObservations) referencedObservations.add(observation);
    for (const check of row.conformanceChecks ?? []) referencedObservations.add(check.observation);
  }

  for (const obs of input.observations) {
    if (input.observationExceptions[obs.name]) continue;
    if (!referencedObservations.has(obs.name)) problems.push(`${obs.file}: observation is not referenced by a registry row`);
    const parsed = parseObservationRowIds(obs.matrixRow);
    if (parsed.length === 0) problems.push(`${obs.file}: matrixRow '${obs.matrixRow}' does not contain a parseable row id`);
    else if (parsed.every((id) => !rowIds.has(id))) problems.push(`${obs.file}: matrixRow '${obs.matrixRow}' does not match a registry row`);
  }

  for (const exception of Object.keys(input.observationExceptions)) {
    if (!observationNames.has(exception)) problems.push(`observation exception '${exception}' does not match an observation file`);
  }

  if (input.checkMarkdown) problems.push(...checkGeneratedMarkdown());

  return problems;
}

if (import.meta.main) {
  const ledger = buildCompatibilityLedger();
  const summary = summarizeLedger(ledger);
  const problems = validateCompatibilityRegistry({
    rows: allCompatibilityRows,
    surfaces: surfaceRegistries,
    observations: loadObservations(),
    observationExceptions,
    checkMarkdown: true,
  });

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
}
