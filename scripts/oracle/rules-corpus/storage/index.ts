/**
 * Storage rules conformance corpus — public entry point.
 *
 * Mirror of ../firestore/index.ts for the `service firebase.storage` surface.
 * Consumers:
 *   - scripts/oracle/run-rules-storage.ts                       (capture runner)
 *   - packages/pyric/test/storage/rules-oracle-conformance.test.ts (replay)
 *
 * The observation filename for a pack is `rules-storage-<pack.id>.json`
 * (see `storageObservationName`). Keep pack ids stable — they are the join key
 * between the corpus, the captured observations, and the replay suite.
 */
import { STORAGE_PACKS } from './packs.ts';
import type { StoragePack } from './types.ts';

export type { StoragePack } from './types.ts';
export { STORAGE_PACKS } from './packs.ts';

/** The observation filename prefix for every Storage rules capture. */
export const RULES_STORAGE_OBSERVATION_PREFIX = 'rules-storage-';

/** Every Storage rules pack in the corpus. */
export const ALL_RULES_STORAGE_PACKS: StoragePack[] = [...STORAGE_PACKS];

/** The observation stem (no extension) a given pack captures into. */
export function storageObservationName(pack: StoragePack): string {
  return `${RULES_STORAGE_OBSERVATION_PREFIX}${pack.id}`;
}
