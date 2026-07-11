/**
 * Firestore rules conformance corpus — public entry point.
 *
 * `./` (this directory) is the index: one authored `PackRecord` per file,
 * named `<pack-id>.ts` (see `./load.ts`). There is no hand-maintained
 * aggregate — `ALL_RULES_FIRESTORE_PACKS`, `STRESS_PACKS`, and
 * `FIX_CLASS_PACKS` are all computed from the loaded directory. Adding a
 * pack is adding a file. Consumers:
 *   - packages/pyric/test/rules/parity/parity-stress.test.ts     (STRESS_PACKS, live Rules-Test-API parity)
 *   - packages/pyric/test/rules/parity/round-fix-classes.test.ts (FIX_CLASS_PACKS, live Rules-Test-API parity)
 *   - packages/conformance/src/run-rules.ts                      (ALL_RULES_FIRESTORE_PACKS, production capture runner)
 *   - packages/pyric/test/rules/oracle-conformance.test.ts       (ALL_RULES_FIRESTORE_PACKS, in-process replay)
 *
 * The observation filename for a pack is `rules-firestore-<pack.id>.json`
 * (see `observationName`). Keep pack ids stable — they are the join key
 * between the corpus, the captured observations, and the replay suite.
 */
import { loadedFirestorePacks } from './load.ts';
import type { Pack } from './types.ts';

export type { Pack, PackGroup } from './types.ts';

/** The observation filename prefix for every Firestore rules capture. */
export const RULES_FIRESTORE_OBSERVATION_PREFIX = 'rules-firestore-';

/** Every Firestore rules pack in the corpus, sorted by id. `group` (loader-
 *  only classification) is stripped here so every consumer of this array
 *  sees exactly the historical `Pack` shape. */
export const ALL_RULES_FIRESTORE_PACKS: Pack[] = loadedFirestorePacks.map(({ group: _group, ...pack }) => pack);

/** The resurrected pre-cutover stress packs (formerly stress-packs.ts),
 *  for the live parity suite (parity-stress.test.ts). */
export const STRESS_PACKS: Pack[] = loadedFirestorePacks
  .filter((p) => p.group === 'stress')
  .map(({ group: _group, ...pack }) => pack);

/** The round-1/2 fix-class packs (formerly fix-class-packs.ts), for the
 *  live parity suite (round-fix-classes.test.ts). */
export const FIX_CLASS_PACKS: Pack[] = loadedFirestorePacks
  .filter((p) => p.group === 'fix-class')
  .map(({ group: _group, ...pack }) => pack);

/** The observation stem (no extension) a given pack captures into. */
export function observationName(pack: Pack): string {
  return `${RULES_FIRESTORE_OBSERVATION_PREFIX}${pack.id}`;
}

/**
 * Stable per-case key for the observation verdict table. Case descriptions are
 * unique within a pack; using the description keeps the observation human
 * diffable while remaining reproducible from the corpus at replay time.
 */
export function caseKey(pack: Pack, index: number): string {
  return pack.cases[index].description;
}
