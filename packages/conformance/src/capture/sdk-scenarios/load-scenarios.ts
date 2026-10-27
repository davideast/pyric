import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { FirestoreScenario, RtdbScenario } from './scenario-types.ts';

const SCENARIO_SUFFIX = '.scenario.ts';

/** The scenario files in one service directory. The directory is the index. */
export function scenarioFiles(service: 'firestore' | 'rtdb'): string[] {
  const directory = join(import.meta.dir, service);
  return readdirSync(directory)
    .filter((file) => file.endsWith(SCENARIO_SUFFIX))
    .sort()
    .map((file) => join(directory, file));
}

async function loadAll<T extends { observation: { name: string } }>(service: 'firestore' | 'rtdb'): Promise<T[]> {
  const scenarios: T[] = [];
  for (const file of scenarioFiles(service)) {
    const module = await import(pathToFileURL(file).href) as { scenario: T };
    const expected = file.slice(file.lastIndexOf('/') + 1, -SCENARIO_SUFFIX.length);
    if (module.scenario.observation.name !== expected) {
      throw new Error(`${file}: scenario observation name '${module.scenario.observation.name}' must match its filename`);
    }
    scenarios.push(module.scenario);
  }
  return scenarios;
}

export const loadFirestoreScenarios = () => loadAll<FirestoreScenario>('firestore');
export const loadRtdbScenarios = () => loadAll<RtdbScenario>('rtdb');
