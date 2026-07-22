import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ALL_RULES_FIRESTORE_SCENARIOS,
  RULES_FIRESTORE_OBSERVATION_PREFIX,
  observationName,
  type Scenario,
} from '../rules-corpus/firestore/index.ts';
import { allCompatibilityRows } from '../registry/index.ts';
import { firestoreScenarioInputDigest } from './firestore-rules-input-digest.ts';
import { loadFirestoreRulesExceptions } from './firestore-rules-exceptions.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const OBS_DIR = join(HERE, '..', 'observations', 'firestore-rules');

export interface FirestoreRulesObservation {
  name: string;
  rowIds: string[];
  behavior: Record<string, unknown>;
  diagnostics?: Record<string, {
    notes?: unknown;
    api?: { functionCalls?: unknown };
  }>;
  inputDigest?: { algorithm?: unknown; value?: unknown };
}

export interface FirestoreOracleRegistryRow {
  id: string;
  oracleObservations: readonly string[];
}

type Verdict = 'ALLOW' | 'DENY' | 'UNSUPPORTED';

const KNOWN_EXCEPTIONS = loadFirestoreRulesExceptions();

function diagnosticProblems(
  observation: FirestoreRulesObservation,
  caseKey: string,
  expectedFunction: string,
): string[] {
  const diagnostic = observation.diagnostics?.[caseKey];
  const notes = Array.isArray(diagnostic?.notes) ? diagnostic.notes : [];
  const calls = Array.isArray(diagnostic?.api?.functionCalls) ? diagnostic.api.functionCalls : [];
  const expectedNote = `Function not found error: Name: [${expectedFunction}]`;
  const noteMatches = notes.some((note) => typeof note === 'string' && note.includes(expectedNote));
  const callMatches = calls.some((call) => typeof call === 'object' && call !== null
    && (call as { function?: unknown }).function === expectedFunction);
  return [
    ...(!noteMatches ? [`${observation.name} :: ${caseKey}: missing ${expectedFunction} function-not-found diagnostic`] : []),
    ...(!callMatches ? [`${observation.name} :: ${caseKey}: missing ${expectedFunction} diagnostic function call`] : []),
  ];
}

export function firestoreOracleReplayProblems(
  scenario: Scenario,
  observation: FirestoreRulesObservation,
  simulatorVerdicts: Readonly<Record<string, Verdict>>,
  row: { id: string; status?: string; conformanceDisposition?: string },
  matchedDivergences?: Set<string>,
): string[] {
  const problems: string[] = [];
  if (observation.rowIds.length !== 1) {
    problems.push(`${observation.name}: expected exactly one registry row, got ${observation.rowIds.join(', ') || '(none)'}`);
    return problems;
  }
  const expectedKeys = scenario.cases.map(({ description }) => description).sort();
  const observedKeys = Object.keys(observation.behavior).sort();
  if (JSON.stringify(observedKeys) !== JSON.stringify(expectedKeys)) {
    problems.push(`${observation.name}: observation case set is stale`);
  }
  const simulatorKeys = Object.keys(simulatorVerdicts).sort();
  if (JSON.stringify(simulatorKeys) !== JSON.stringify(expectedKeys)) {
    problems.push(`${observation.name}: simulator case set is not exact`);
  }
  if (JSON.stringify(observation.inputDigest) !== JSON.stringify(firestoreScenarioInputDigest(scenario))) {
    problems.push(`${observation.name}: observation input digest is stale`);
  }
  for (const [caseKey, prodVerdict] of Object.entries(observation.behavior)) {
    const simVerdict = simulatorVerdicts[caseKey];
    const key = `${observation.name} :: ${caseKey}`;
    if (simVerdict === 'UNSUPPORTED') {
      problems.push(`${key}: simulator abstained; an abstention cannot underwrite canonical score evidence`);
      continue;
    }
    const known = KNOWN_EXCEPTIONS.get(key);
    if (known) {
      matchedDivergences?.add(key);
      problems.push(...diagnosticProblems(observation, caseKey, known.diagnosticFunction));
      if (row.id !== known.rowId) problems.push(`${key}: divergence belongs to ${known.rowId}, not ${row.id}`);
      if (row.status !== 'diverged-documented') {
        problems.push(`${key}: ${known.rowId} must remain diverged-documented while verdicts differ`);
      }
      if (row.conformanceDisposition !== known.conformanceDisposition) {
        problems.push(`${key}: ${known.rowId} must retain ${known.conformanceDisposition} disposition`);
      }
      if (prodVerdict !== known.productionVerdict) problems.push(`${key}: pinned production verdict changed`);
      if (simVerdict !== known.simulatorVerdict) {
        problems.push(`${key}: pinned simulator verdict changed (${known.issue}: ${known.reason})`);
      }
      continue;
    }
    if (simVerdict !== prodVerdict) {
      problems.push(`${key}: production ${JSON.stringify(prodVerdict)}, simulator ${JSON.stringify(simVerdict)}`);
    }
  }
  return problems;
}

export interface FirestoreOracleReplayResult {
  name: string;
  rowId: string;
  problems: string[];
}

/**
 * Prove the one-row/one-observation join that lets replay evidence support a
 * registry assertion. The scorecard must not rely on a separate climb test to
 * reject a forged or stale row ID.
 */
export function firestoreOracleRegistryProblems(
  observations: readonly Pick<FirestoreRulesObservation, 'name' | 'rowIds'>[],
  rows: readonly FirestoreOracleRegistryRow[],
): string[] {
  const problems: string[] = [];
  const rowById = new Map(rows.map((row) => [row.id, row]));
  const observationByName = new Map(observations.map((observation) => [observation.name, observation]));
  const observationsByRow = new Map<string, string[]>();

  if (observationByName.size !== observations.length) {
    problems.push('Firestore Rules oracle replay contains duplicate observation names');
  }
  if (rowById.size !== rows.length) {
    problems.push('Firestore Rules oracle replay contains duplicate registry row IDs');
  }

  for (const observation of observations) {
    if (observation.rowIds.length !== 1) continue;
    const rowId = observation.rowIds[0]!;
    const row = rowById.get(rowId);
    if (!row) {
      problems.push(`${observation.name}: unknown Firestore Rules registry row ${rowId}`);
      continue;
    }
    const assigned = observationsByRow.get(rowId) ?? [];
    assigned.push(observation.name);
    observationsByRow.set(rowId, assigned);
    if (row.oracleObservations.length !== 1 || row.oracleObservations[0] !== observation.name) {
      problems.push(
        `${observation.name}: ${rowId} must link back to exactly this observation, got ` +
        `${row.oracleObservations.join(', ') || '(none)'}`,
      );
    }
  }

  for (const row of rows) {
    if (row.oracleObservations.length !== 1) {
      problems.push(`${row.id}: expected exactly one Firestore Rules oracle observation`);
    }
    for (const name of row.oracleObservations) {
      const observation = observationByName.get(name);
      if (!observation) problems.push(`${row.id}: linked observation ${name} is missing`);
      else if (observation.rowIds.length !== 1 || observation.rowIds[0] !== row.id) {
        problems.push(`${row.id}: linked observation ${name} does not link back to this row`);
      }
    }
    const assigned = observationsByRow.get(row.id) ?? [];
    if (assigned.length !== 1) {
      problems.push(`${row.id}: expected exactly one assigned observation, got ${assigned.join(', ') || '(none)'}`);
    }
  }
  return problems;
}

/** Replay once and retain per-row results for the CDD climb reporter. */
export async function replayFirestoreRulesObservations(): Promise<FirestoreOracleReplayResult[]> {
  const scenarioByObservation = new Map(
    ALL_RULES_FIRESTORE_SCENARIOS.map((scenario) => [observationName(scenario), scenario]),
  );
  const firestoreRows = allCompatibilityRows.filter(({ surface }) => surface === 'firestore-rules');
  const rowStatus = new Map(firestoreRows.map((row) => [row.id, row]));
  const files = readdirSync(OBS_DIR)
    .filter((file) => file.startsWith(RULES_FIRESTORE_OBSERVATION_PREFIX) && file.endsWith('.json'))
    .sort();
  if (files.length === 0) return [{
    name: 'firestore-rules-observation-set', rowId: '',
    problems: ['Firestore Rules oracle replay has no committed observations'],
  }];
  const observations = files.map((file) => {
    const observation = JSON.parse(readFileSync(join(OBS_DIR, file), 'utf8')) as FirestoreRulesObservation;
    observation.name ||= file.replace(/\.json$/, '');
    return observation;
  });

  const { SimulateFirestoreRulesHandler } = await import('../../pyric/src/rules/simulator/handler.ts');
  const simulator = new SimulateFirestoreRulesHandler();
  const registryProblems = firestoreOracleRegistryProblems(observations, firestoreRows);
  const replays: FirestoreOracleReplayResult[] = registryProblems.length === 0 ? [] : [{
    name: 'firestore-rules-registry-linkage', rowId: '', problems: registryProblems,
  }];
  const matchedDivergences = new Set<string>();
  const observedNames = new Set<string>();
  for (const observation of observations) {
    observedNames.add(observation.name);
    const scenario = scenarioByObservation.get(observation.name);
    if (!scenario) {
      replays.push({
        name: observation.name, rowId: observation.rowIds[0] ?? '',
        problems: [`${observation.name}: no matching corpus scenario`],
      });
      continue;
    }
    const result = simulator.simulate(scenario.rules, scenario.cases);
    if (!result.success) {
      replays.push({
        name: observation.name, rowId: observation.rowIds[0] ?? '',
        problems: [`${observation.name}: simulator failed: ${result.error.code} ${result.error.message}`],
      });
      continue;
    }
    if (result.data.results.length !== scenario.cases.length) {
      replays.push({
        name: observation.name, rowId: observation.rowIds[0] ?? '',
        problems: [
          `${observation.name}: simulator returned ${result.data.results.length} results for ${scenario.cases.length} cases`,
        ],
      });
      continue;
    }
    const verdicts = Object.fromEntries(result.data.results.map((entry) => [entry.description, entry.decision]));
    const rowId = observation.rowIds[0] ?? '';
    const registryRow = rowStatus.get(rowId);
    replays.push({
      name: observation.name,
      rowId,
      problems: firestoreOracleReplayProblems(
        scenario,
        observation,
        verdicts,
        { id: rowId, status: registryRow?.status, conformanceDisposition: registryRow?.conformanceDisposition },
        matchedDivergences,
      ),
    });
  }
  for (const name of scenarioByObservation.keys()) {
    if (!observedNames.has(name)) replays.push({
      name, rowId: '', problems: [`${name}: corpus scenario has no committed observation`],
    });
  }
  for (const [key, known] of KNOWN_EXCEPTIONS) {
    if (!matchedDivergences.has(key)) replays.push({
      name: key, rowId: known.rowId, problems: [`${key}: stale or unused divergence pin`],
    });
  }
  return replays;
}

/** Fail closed unless every committed production observation replays locally. */
export async function assertFirestoreRulesOracleReplay(): Promise<void> {
  const problems = (await replayFirestoreRulesObservations()).flatMap(({ problems }) => problems);
  if (problems.length > 0) {
    throw new Error(`Firestore Rules oracle replay failed:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`);
  }
}
