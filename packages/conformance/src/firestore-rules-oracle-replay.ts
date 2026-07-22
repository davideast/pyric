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

const HERE = dirname(fileURLToPath(import.meta.url));
const OBS_DIR = join(HERE, '..', 'observations', 'firestore-rules');

export interface FirestoreRulesObservation {
  name: string;
  rowIds: string[];
  behavior: Record<string, unknown>;
  inputDigest?: { algorithm?: unknown; value?: unknown };
}

type Verdict = 'ALLOW' | 'DENY' | 'UNSUPPORTED';

const KNOWN_DIVERGENCES: Readonly<Record<
  string,
  { prodVerdict: 'ALLOW' | 'DENY'; simVerdict: 'ALLOW' | 'DENY'; reason: string; issue: string }
>> = {
  'rules-firestore-get-after-and-exists-after :: getAfter target == request.resource.data ALLOW': {
    prodVerdict: 'DENY', simVerdict: 'ALLOW',
    reason: 'simulator getAfter() does not model the post-write document identity production compares against', issue: '#135',
  },
  'rules-firestore-get-after-and-exists-after :: existsAfter create true ALLOW': {
    prodVerdict: 'DENY', simVerdict: 'ALLOW',
    reason: 'simulator existsAfter() on a create does not match production post-write existence semantics', issue: '#135',
  },
  'rules-firestore-get-after-and-exists-after :: existsAfter delete false ALLOW': {
    prodVerdict: 'DENY', simVerdict: 'ALLOW',
    reason: 'simulator existsAfter() on a delete does not match production post-write existence semantics', issue: '#135',
  },
  'rules-firestore-get-after-and-exists-after :: existsAfter unrelated mocked path ALLOW': {
    prodVerdict: 'DENY', simVerdict: 'ALLOW',
    reason: 'simulator existsAfter() over an unrelated mocked path does not match production', issue: '#135',
  },
};

export function firestoreOracleReplayProblems(
  scenario: Scenario,
  observation: FirestoreRulesObservation,
  simulatorVerdicts: Readonly<Record<string, Verdict>>,
  rowStatus: string | undefined,
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
  if (JSON.stringify(observation.inputDigest) !== JSON.stringify(firestoreScenarioInputDigest(scenario))) {
    problems.push(`${observation.name}: observation input digest is stale`);
  }
  for (const [caseKey, prodVerdict] of Object.entries(observation.behavior)) {
    const simVerdict = simulatorVerdicts[caseKey];
    const key = `${observation.name} :: ${caseKey}`;
    if (simVerdict === 'UNSUPPORTED') {
      if (rowStatus !== 'unsupported') problems.push(`${key}: simulator abstained but row is ${rowStatus ?? 'missing'}`);
      continue;
    }
    const known = KNOWN_DIVERGENCES[key];
    if (known) {
      if (prodVerdict !== known.prodVerdict) problems.push(`${key}: pinned production verdict changed`);
      if (simVerdict !== known.simVerdict) {
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

/** Replay once and retain per-row results for the CDD climb reporter. */
export async function replayFirestoreRulesObservations(): Promise<FirestoreOracleReplayResult[]> {
  const scenarioByObservation = new Map(
    ALL_RULES_FIRESTORE_SCENARIOS.map((scenario) => [observationName(scenario), scenario]),
  );
  const rowStatus = new Map(
    allCompatibilityRows.filter(({ surface }) => surface === 'firestore-rules').map(({ id, status }) => [id, status]),
  );
  const files = readdirSync(OBS_DIR)
    .filter((file) => file.startsWith(RULES_FIRESTORE_OBSERVATION_PREFIX) && file.endsWith('.json'))
    .sort();
  if (files.length === 0) return [{
    name: 'firestore-rules-observation-set', rowId: '',
    problems: ['Firestore Rules oracle replay has no committed observations'],
  }];

  const { SimulateFirestoreRulesHandler } = await import('../../pyric/src/rules/simulator/handler.ts');
  const simulator = new SimulateFirestoreRulesHandler();
  const replays: FirestoreOracleReplayResult[] = [];
  const observedNames = new Set<string>();
  for (const file of files) {
    const observation = JSON.parse(readFileSync(join(OBS_DIR, file), 'utf8')) as FirestoreRulesObservation;
    observation.name ||= file.replace(/\.json$/, '');
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
    const verdicts = Object.fromEntries(result.data.results.map((entry, index) => [
      scenario.cases[index]!.description,
      entry.decision,
    ]));
    const rowId = observation.rowIds[0] ?? '';
    replays.push({
      name: observation.name,
      rowId,
      problems: firestoreOracleReplayProblems(scenario, observation, verdicts, rowStatus.get(rowId)),
    });
  }
  for (const name of scenarioByObservation.keys()) {
    if (!observedNames.has(name)) replays.push({
      name, rowId: '', problems: [`${name}: corpus scenario has no committed observation`],
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
