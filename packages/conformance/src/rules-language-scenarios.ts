import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RulesEngine } from '../rules-language/load.ts';
import { ALL_RULES_FIRESTORE_SCENARIOS } from '../rules-corpus/firestore/index.ts';
import { ALL_RULES_STORAGE_SCENARIOS } from '../rules-corpus/storage/index.ts';
import { ALL_RULES_RTDB_SCENARIOS } from '../rules-corpus/rtdb/index.ts';
import { firestoreObservationMatchesScenario } from './firestore-rules-input-digest.ts';

export interface RulesLanguageScenario {
  id: string;
  rules: string;
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
  const corpus = engine === 'storage' ? ALL_RULES_STORAGE_SCENARIOS : ALL_RULES_RTDB_SCENARIOS;
  return {
    scenarios: corpus.map(({ id, rules }) => ({ id, rules })),
    twinIds: candidateTwinIds,
  };
}
