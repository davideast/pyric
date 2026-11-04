/**
 * The live row set: the Firebase specifiers live mode serves from the app's
 * own installed SDK, each to the wrapped module that serves it. It is
 * supplied to `@pyric/cli`'s one swap table rather than kept as a second
 * table, so every plane that reads the table reads these rows the same way.
 *
 * No plane selects the set yet. The specifiers it leaves out keep the
 * sandbox rows until live mode refuses them.
 */
import {
  swappedFirebaseEntries,
  type FirebaseRowSet,
  type ServedFirebaseSpecifier,
} from '../../cli/src/serve/firebase-module-swap.js';
import { wrapLiveModule, type LiveModuleKey } from './modules.js';
import type { LiveObserver } from './observe.js';

export const LIVE_ROWS: ReadonlyMap<ServedFirebaseSpecifier, LiveModuleKey> = new Map<ServedFirebaseSpecifier, LiveModuleKey>([
  ['firebase/app', 'live-app'],
  ['firebase/auth', 'live-auth'],
  ['firebase/firestore', 'live-firestore'],
  ['firebase/app-check', 'live-app-check'],
]);

/** The swap table with the live rows applied over sandbox mode. */
export function liveFirebaseEntries(): ReadonlyMap<ServedFirebaseSpecifier, string> {
  const rows: FirebaseRowSet = LIVE_ROWS;
  return swappedFirebaseEntries('sandbox', rows);
}

/**
 * The module a plane serves for `specifier` under live mode: the app's own
 * `real` module, wrapped by its live row. `sdkVersion` is the installed
 * `firebase`'s `SDK_VERSION`, as `firebase/app` exports it. Throws for a
 * specifier with no live row.
 */
export function liveModuleFor<T extends object>(
  specifier: ServedFirebaseSpecifier,
  real: T,
  observer: LiveObserver,
  sdkVersion: string,
): T {
  const key = LIVE_ROWS.get(specifier);
  if (key === undefined) throw new Error(`@pyric/live has no live row for ${specifier}.`);
  return wrapLiveModule(key, specifier, real, observer, sdkVersion);
}
