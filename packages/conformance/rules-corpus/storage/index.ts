/**
 * Storage rules conformance corpus — public entry point.
 *
 * Mirror of ../firestore/index.ts for the `service firebase.storage` surface.
 * `./` (this directory) is the index: one authored `StorageScenarioRecord` per
 * file, named `<scenario-id>.ts` (see `./load.ts`). There is no hand-maintained
 * aggregate — `ALL_RULES_STORAGE_SCENARIOS` is computed from the loaded
 * directory. Adding a scenario is adding a file. Consumers:
 *   - packages/conformance/src/run-rules-storage.ts                       (capture runner)
 *   - packages/pyric/test/storage/rules-oracle-conformance.test.ts (replay)
 *
 * The observation filename for a scenario is `rules-storage-<scenario.id>.json`
 * (see `storageObservationName`). Keep scenario ids stable — they are the join
 * key between the corpus, the captured observations, and the replay suite.
 */
import { loadedStorageScenarios } from './load.ts';
import type { StorageScenario } from './types.ts';

export type { StorageScenario } from './types.ts';

/** The observation filename prefix for every Storage rules capture. */
export const RULES_STORAGE_OBSERVATION_PREFIX = 'rules-storage-';

/** Every Storage rules scenario in the corpus, sorted by id. */
export const ALL_RULES_STORAGE_SCENARIOS: StorageScenario[] = loadedStorageScenarios;

/** The observation stem (no extension) a given scenario captures into. */
export function storageObservationName(scenario: StorageScenario): string {
  return `${RULES_STORAGE_OBSERVATION_PREFIX}${scenario.id}`;
}
