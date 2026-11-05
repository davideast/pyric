/**
 * The live rows applied to `@pyric/cli`'s one swap table. Node only: the
 * table module reads the file system. It imports the table through the
 * register seam, not the Vite one, so `@pyric/live` loads in a project
 * without `vite` (#2081).
 */
import { swappedFirebaseEntries, type FirebaseRowSet, type ServedFirebaseSpecifier } from '@pyric/cli/register/internal/supplied-rows';
import { LIVE_ROWS } from './rows.js';

/** The swap table with the live rows applied over sandbox mode. */
export function liveFirebaseEntries(): ReadonlyMap<ServedFirebaseSpecifier, string> {
  const rows: FirebaseRowSet = LIVE_ROWS;
  return swappedFirebaseEntries('sandbox', rows);
}
