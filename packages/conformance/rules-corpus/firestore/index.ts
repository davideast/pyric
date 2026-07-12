/**
 * Firestore rules conformance corpus — public entry point.
 *
 * `./` (this directory) is the index: one authored `ScenarioRecord` per file,
 * named `<scenario-id>.ts` (see `./load.ts`). There is no hand-maintained
 * aggregate — `ALL_RULES_FIRESTORE_SCENARIOS`, `STRESS_SCENARIOS`, and
 * `FIX_CLASS_SCENARIOS` are all computed from the loaded directory. Adding a
 * scenario is adding a file. Consumers:
 *   - packages/pyric/test/rules/parity/parity-stress.test.ts     (STRESS_SCENARIOS, live Rules-Test-API parity)
 *   - packages/pyric/test/rules/parity/round-fix-classes.test.ts (FIX_CLASS_SCENARIOS, live Rules-Test-API parity)
 *   - packages/conformance/src/run-rules.ts                      (ALL_RULES_FIRESTORE_SCENARIOS, production capture runner)
 *   - packages/pyric/test/rules/oracle-conformance.test.ts       (ALL_RULES_FIRESTORE_SCENARIOS, in-process replay)
 *
 * The observation filename for a scenario is `rules-firestore-<scenario.id>.json`
 * (see `observationName`). Keep scenario ids stable — they are the join key
 * between the corpus, the captured observations, and the replay suite.
 */
import { loadedFirestoreScenarios } from './load.ts';
import type { Scenario } from './types.ts';

export type { Scenario, ScenarioGroup } from './types.ts';

/** The observation filename prefix for every Firestore rules capture. */
export const RULES_FIRESTORE_OBSERVATION_PREFIX = 'rules-firestore-';

/** Every Firestore rules scenario in the corpus, sorted by id. `group` (loader-
 *  only classification) is stripped here so every consumer of this array
 *  sees exactly the historical `Scenario` shape. */
export const ALL_RULES_FIRESTORE_SCENARIOS: Scenario[] = loadedFirestoreScenarios.map(({ group: _group, ...scenario }) => scenario);

/** The resurrected pre-cutover stress scenarios (formerly stress-scenarios.ts),
 *  for the live parity suite (parity-stress.test.ts). */
export const STRESS_SCENARIOS: Scenario[] = loadedFirestoreScenarios
  .filter((p) => p.group === 'stress')
  .map(({ group: _group, ...scenario }) => scenario);

/** The round-1/2 fix-class scenarios (formerly fix-class-scenarios.ts), for the
 *  live parity suite (round-fix-classes.test.ts). */
export const FIX_CLASS_SCENARIOS: Scenario[] = loadedFirestoreScenarios
  .filter((p) => p.group === 'fix-class')
  .map(({ group: _group, ...scenario }) => scenario);

/** The observation stem (no extension) a given scenario captures into. */
export function observationName(scenario: Scenario): string {
  return `${RULES_FIRESTORE_OBSERVATION_PREFIX}${scenario.id}`;
}

/**
 * Stable per-case key for the observation verdict table. Case descriptions are
 * unique within a scenario; using the description keeps the observation human
 * diffable while remaining reproducible from the corpus at replay time.
 */
export function caseKey(scenario: Scenario, index: number): string {
  return scenario.cases[index].description;
}
