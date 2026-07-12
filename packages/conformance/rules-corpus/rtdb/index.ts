/**
 * RTDB rules conformance corpus — public entry point.
 *
 * `./` (this directory) is the index: one authored `RtdbScenarioRecord` per file,
 * named `<scenario-id>.ts` (see `./load.ts`). There is no hand-maintained
 * aggregate — `ALL_RULES_RTDB_SCENARIOS` is computed from the loaded directory.
 * Adding a scenario is adding a file. Consumers:
 *   - packages/conformance/src/run-rules-rtdb.ts                     (capture runner: deploy→observe→restore)
 *   - packages/pyric/test/database/rules-conformance.test.ts         (in-process replay vs frozen prod verdicts)
 *
 * The observation filename for a scenario is `rules-rtdb-<scenario.id>.json` (see
 * `rtdbObservationName`). Keep scenario ids stable — they are the join key between
 * the corpus, the captured observations, and the replay suite, and they double
 * as the subtree mount key at capture/replay time.
 */
import { loadedRtdbScenarios } from './load.ts';
import type { RtdbScenario } from './types.ts';

export type { RtdbScenario, RtdbTestCase, RtdbScenarioRecord } from './types.ts';

/** The observation filename prefix for every RTDB rules capture. */
export const RULES_RTDB_OBSERVATION_PREFIX = 'rules-rtdb-';

/** Every RTDB rules scenario in the corpus, sorted by id. */
export const ALL_RULES_RTDB_SCENARIOS: RtdbScenario[] = loadedRtdbScenarios;

/** The observation stem (no extension) a given scenario captures into. */
export function rtdbObservationName(scenario: RtdbScenario): string {
  return `${RULES_RTDB_OBSERVATION_PREFIX}${scenario.id}`;
}
