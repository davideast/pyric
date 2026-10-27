import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RulesEngine } from '../rules-language/load.ts';
import { ALL_RULES_FIRESTORE_SCENARIOS } from '../rules-corpus/firestore/index.ts';
import { ALL_RULES_STORAGE_SCENARIOS, type StorageScenario } from '../rules-corpus/storage/index.ts';
import { ALL_RULES_RTDB_DEPLOY_SCENARIOS, ALL_RULES_RTDB_SCENARIOS } from '../rules-corpus/rtdb/index.ts';
import { firestoreObservationMatchesScenario } from './firestore-rules-input-digest.ts';
import { storageRulesTestInputDigest } from './storage-rules-input-digest.ts';
import { loadStorageRulesExceptions } from './storage-rules-exceptions.ts';

export interface StorageObservationIdentity {
  inputDigest?: { algorithm?: unknown; value?: unknown };
  behavior?: Record<string, unknown>;
}

/** True only when the Storage observation covers this exact input and case-key set. */
export function storageObservationMatchesScenario(
  scenario: Pick<StorageScenario, 'rules' | 'cases'>,
  observation: StorageObservationIdentity,
): boolean {
  const expected = storageRulesTestInputDigest(scenario.rules, scenario.cases);
  if (
    observation.inputDigest?.algorithm !== expected.algorithm ||
    observation.inputDigest.value !== expected.value
  ) return false;
  const observedCases = Object.keys(observation.behavior ?? {}).sort();
  const scenarioCases = scenario.cases.map(({ description }) => description).sort();
  return JSON.stringify(observedCases) === JSON.stringify(scenarioCases);
}

export interface RulesLanguageScenario {
  id: string;
  rules: string;
  /** The constructs the scenario's capture adjudicates, when the analyzer
   *  cannot derive them from `rules`. An RTDB deploy scenario records whether
   *  production accepts each ruleset, so it credits exactly the construct each
   *  case names, never every construct its rulesets happen to contain. */
  constructs?: readonly string[];
}

const OBSERVATION_SURFACE: Record<RulesEngine, string> = {
  firestore: 'firestore-rules',
  storage: 'storage-rules',
  rtdb: 'rtdb-rules',
};

/** Load corpus scenarios and only provenance-bound observation twins. */
export function loadRulesLanguageScenarios(
  engine: RulesEngine,
): { scenarios: RulesLanguageScenario[]; twinIds: Set<string> } {
  const here = dirname(fileURLToPath(import.meta.url));
  const observationDirectory = join(here, '..', 'observations', OBSERVATION_SURFACE[engine]);
  let observationFiles: string[] = [];
  try {
    observationFiles = readdirSync(observationDirectory);
  } catch {
    // A surface with no captures has no evidence twins.
  }
  const prefix = `rules-${engine}-`;
  const candidateTwinIds = new Set(observationFiles
    .filter((file) => file.startsWith(prefix) && file.endsWith('.json'))
    .map((file) => file.slice(prefix.length, -'.json'.length)));

  if (engine === 'firestore') {
    const scenarios = ALL_RULES_FIRESTORE_SCENARIOS.map(({ id, rules }) => ({ id, rules }));
    const scenariosById = new Map(ALL_RULES_FIRESTORE_SCENARIOS.map((scenario) => [scenario.id, scenario]));
    const twinIds = new Set<string>();
    for (const id of candidateTwinIds) {
      const scenario = scenariosById.get(id);
      if (!scenario) continue;
      const observation = JSON.parse(
        readFileSync(join(observationDirectory, `${prefix}${id}.json`), 'utf8'),
      ) as { inputDigest?: { algorithm?: unknown; value?: unknown }; behavior?: Record<string, unknown> };
      if (firestoreObservationMatchesScenario(scenario, observation)) twinIds.add(id);
    }
    return { scenarios, twinIds };
  }
  if (engine === 'rtdb') {
    return {
      scenarios: [
        ...ALL_RULES_RTDB_SCENARIOS.map(({ id, rules }) => ({ id, rules })),
        ...ALL_RULES_RTDB_DEPLOY_SCENARIOS.map(({ id, deployCases }) => ({
          id,
          rules: '{}',
          constructs: [...new Set(deployCases.map((deployCase) => deployCase.construct))],
        })),
      ],
      twinIds: candidateTwinIds,
    };
  }
  // A scenario pyric refuses to parse cannot be analyzed and earns no syntactic
  // credit; its pinned row names the constructs it diverges on.
  const parsePinned = new Set([...loadStorageRulesExceptions()]
    .filter(([, pin]) => pin.kind === 'parse')
    .map(([name]) => name));
  const scenarios = ALL_RULES_STORAGE_SCENARIOS.map(({ id, rules }): RulesLanguageScenario => (
    parsePinned.has(`${prefix}${id}`) ? { id, rules, constructs: [] } : { id, rules }
  ));
  const scenariosById = new Map(ALL_RULES_STORAGE_SCENARIOS.map((scenario) => [scenario.id, scenario]));
  const twinIds = new Set<string>();
  for (const id of candidateTwinIds) {
    const scenario = scenariosById.get(id);
    if (!scenario) continue;
    const observation = JSON.parse(
      readFileSync(join(observationDirectory, `${prefix}${id}.json`), 'utf8'),
    ) as StorageObservationIdentity;
    if (storageObservationMatchesScenario(scenario, observation)) twinIds.add(id);
  }
  return {
    scenarios,
    twinIds,
  };
}
