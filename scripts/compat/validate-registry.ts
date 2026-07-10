#!/usr/bin/env bun
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { allCompatibilityRows, observationExceptions, surfaceDescriptors, type Automation, type CompatibilityRow, type CompatStatus, type SurfaceDescriptor } from './registry/index.ts';
import { buildCompatibilityLedger, loadObservations, REPO_ROOT, summarizeLedger, type Observation } from './ledger.ts';
import { checkGeneratedMarkdown } from './generate-docs.ts';

const allowedStatus = new Set<CompatStatus>([
  'conforms',
  'diverged-documented',
  'bug',
  'unsupported',
  'unverified',
]);

const allowedAutomation = new Set<Automation>([
  'oracle-backed',
  'shape-backed',
  'unit-backed',
  'type-backed',
  'sandbox-only',
  'playground-only',
  'unsupported',
  'unverified',
]);

export interface ValidationInput {
  rows: CompatibilityRow[];
  descriptors: SurfaceDescriptor[];
  observations: Observation[];
  observationExceptions: Record<string, string>;
  checkMarkdown?: boolean;
}

export function validateCompatibilityRegistry(input: ValidationInput): string[] {
  const problems: string[] = [];
  const ids = new Map<string, number>();
  const observationNames = new Set(input.observations.map((obs) => obs.name));
  const observationByName = new Map(input.observations.map((obs) => [obs.name, obs]));

  for (const row of input.rows) {
    ids.set(row.id, (ids.get(row.id) ?? 0) + 1);

    if (row.id !== `${row.surface}#${row.rowRef}`) problems.push(`${row.id}: id must equal surface#rowRef`);
    if (!row.section.trim()) problems.push(`${row.id}: missing section`);
    if (!row.api.trim()) problems.push(`${row.id}: missing api`);
    if (!row.behavior.trim()) problems.push(`${row.id}: missing behavior`);
    if (!allowedStatus.has(row.status)) problems.push(`${row.id}: invalid status '${row.status}'`);
    if (row.statusNote !== undefined && !row.statusNote.trim()) problems.push(`${row.id}: statusNote must not be blank`);
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
      const obs = observationByName.get(check.observation);
      for (const key of Object.keys(check.expect)) {
        if (obs && !(key in obs.behavior)) problems.push(`${row.id}: check ${check.finding} expected behavior key '${key}' is missing from ${check.observation}.json`);
      }
    }

    // Row -> observation direction: every observation a row cites must link
    // the row back through its structured rowIds.
    const citedObservations = new Set([...row.oracleObservations, ...(row.conformanceChecks ?? []).map((check) => check.observation)]);
    for (const observation of citedObservations) {
      const obs = observationByName.get(observation);
      if (obs && !obs.rowIds.includes(row.id)) problems.push(`${observation}.json: cited by ${row.id} but rowIds does not list it`);
    }
  }

  for (const [id, count] of ids) if (count > 1) problems.push(`duplicate row id: ${id} (${count} rows)`);

  const registries = [...new Set(input.descriptors.map((d) => d.registry))];
  for (const registry of registries) {
    const allowedSurfaces = new Set(input.descriptors.filter((d) => d.registry === registry).map((d) => d.surface));
    const registryRows = registry.blocks.flatMap((block) => block.kind === 'table' ? block.rows : []);
    if (registryRows.length === 0) problems.push(`${registry.surface}: surface has no rows`);
    for (const row of registryRows) {
      if (!allowedSurfaces.has(row.surface)) problems.push(`${row.id}: row surface does not belong in ${registry.compatPath}`);
    }
  }
  for (const descriptor of input.descriptors) {
    if (!input.rows.some((row) => row.surface === descriptor.surface)) problems.push(`${descriptor.surface}: surface has no rows`);
  }

  const referencedObservations = new Set<string>();
  for (const row of input.rows) {
    for (const observation of row.oracleObservations) referencedObservations.add(observation);
    for (const check of row.conformanceChecks ?? []) referencedObservations.add(check.observation);
  }

  const rowIds = new Set(input.rows.map((row) => row.id));
  for (const obs of input.observations) {
    // Observation -> row direction: every structured link must resolve to a
    // real (canonical) registry row, exceptions included.
    for (const id of obs.rowIds) {
      if (!rowIds.has(id)) problems.push(`${obs.file}: rowIds entry '${id}' does not match a registry row`);
    }
    const descriptor = input.descriptors.find((d) => d.observationPrefix && obs.file.startsWith(d.observationPrefix));
    if (!descriptor) problems.push(`${obs.file}: filename does not start with a known surface observation prefix`);
    if (input.observationExceptions[obs.name]) continue;
    if (!referencedObservations.has(obs.name)) problems.push(`${obs.file}: observation is not referenced by a registry row`);
    if (obs.rowIds.length === 0) problems.push(`${obs.file}: observation has no rowIds`);
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
    descriptors: surfaceDescriptors,
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
