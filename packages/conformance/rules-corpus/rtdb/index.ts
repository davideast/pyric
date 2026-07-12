/**
 * RTDB rules conformance corpus — public entry point.
 *
 * `./` (this directory) is the index: one authored `RtdbPackRecord` per file,
 * named `<pack-id>.ts` (see `./load.ts`). There is no hand-maintained
 * aggregate — `ALL_RULES_RTDB_PACKS` is computed from the loaded directory.
 * Adding a pack is adding a file. Consumers:
 *   - packages/conformance/src/run-rules-rtdb.ts                     (capture runner: deploy→observe→restore)
 *   - packages/pyric/test/database/rules-conformance.test.ts         (in-process replay vs frozen prod verdicts)
 *
 * The observation filename for a pack is `rules-rtdb-<pack.id>.json` (see
 * `rtdbObservationName`). Keep pack ids stable — they are the join key between
 * the corpus, the captured observations, and the replay suite, and they double
 * as the subtree mount key at capture/replay time.
 */
import { loadedRtdbPacks } from './load.ts';
import type { RtdbPack } from './types.ts';

export type { RtdbPack, RtdbTestCase, RtdbPackRecord } from './types.ts';

/** The observation filename prefix for every RTDB rules capture. */
export const RULES_RTDB_OBSERVATION_PREFIX = 'rules-rtdb-';

/** Every RTDB rules pack in the corpus, sorted by id. */
export const ALL_RULES_RTDB_PACKS: RtdbPack[] = loadedRtdbPacks;

/** The observation stem (no extension) a given pack captures into. */
export function rtdbObservationName(pack: RtdbPack): string {
  return `${RULES_RTDB_OBSERVATION_PREFIX}${pack.id}`;
}
