/**
 * Storage rules conformance corpus — public entry point.
 *
 * Mirror of ../firestore/index.ts for the `service firebase.storage` surface.
 * `./` (this directory) is the index: one authored `StoragePackRecord` per
 * file, named `<pack-id>.ts` (see `./load.ts`). There is no hand-maintained
 * aggregate — `ALL_RULES_STORAGE_PACKS` is computed from the loaded
 * directory. Adding a pack is adding a file. Consumers:
 *   - packages/conformance/src/run-rules-storage.ts                       (capture runner)
 *   - packages/pyric/test/storage/rules-oracle-conformance.test.ts (replay)
 *
 * The observation filename for a pack is `rules-storage-<pack.id>.json`
 * (see `storageObservationName`). Keep pack ids stable — they are the join
 * key between the corpus, the captured observations, and the replay suite.
 */
import { loadedStoragePacks } from './load.ts';
import type { StoragePack } from './types.ts';

export type { StoragePack } from './types.ts';

/** The observation filename prefix for every Storage rules capture. */
export const RULES_STORAGE_OBSERVATION_PREFIX = 'rules-storage-';

/** Every Storage rules pack in the corpus, sorted by id. */
export const ALL_RULES_STORAGE_PACKS: StoragePack[] = loadedStoragePacks;

/** The observation stem (no extension) a given pack captures into. */
export function storageObservationName(pack: StoragePack): string {
  return `${RULES_STORAGE_OBSERVATION_PREFIX}${pack.id}`;
}
