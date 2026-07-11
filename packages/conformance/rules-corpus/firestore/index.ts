/**
 * Firestore rules conformance corpus — public entry point.
 *
 * This is the ONE home for the migrated parity packs. Consumers:
 *   - packages/pyric/test/rules/parity/*.test.ts   (live Rules-Test-API parity)
 *   - scripts/oracle/run-rules.ts                  (production capture runner)
 *   - packages/pyric/test/rules/oracle-conformance.test.ts (in-process replay)
 *
 * The observation filename for a pack is `rules-firestore-<pack.id>.json`
 * (see `observationName`). Keep pack ids stable — they are the join key
 * between the corpus, the captured observations, and the replay suite.
 */
import { STRESS_PACKS } from './stress-packs.ts';
import { FIX_CLASS_PACKS } from './fix-class-packs.ts';
import type { Pack } from './types.ts';

export type { Pack } from './types.ts';
export { STRESS_PACKS } from './stress-packs.ts';
export { FIX_CLASS_PACKS } from './fix-class-packs.ts';

/** The observation filename prefix for every Firestore rules capture. */
export const RULES_FIRESTORE_OBSERVATION_PREFIX = 'rules-firestore-';

/** Every Firestore rules pack in the corpus (stress packs, then fix-class). */
export const ALL_RULES_FIRESTORE_PACKS: Pack[] = [...STRESS_PACKS, ...FIX_CLASS_PACKS];

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
