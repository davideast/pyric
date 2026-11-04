/**
 * The live row set: the Firebase specifiers live mode serves from the app's
 * own installed SDK, each to the wrapped module that serves it. It is
 * supplied to `@pyric/cli`'s one swap table rather than kept as a second
 * table, so every plane that reads the table reads these rows the same way
 * (`swap-table.ts`). The page plane serves them through `@pyric/live/vite`
 * and refuses every other served specifier.
 *
 * This file is loaded in the page too, so it imports only types from
 * `@pyric/cli`.
 */
import type { ServedFirebaseSpecifier } from '@pyric/cli/vite/internal/supplied-rows';
import { wrapLiveModule, type LiveModuleKey, type LiveModuleSite } from './modules.js';

export const LIVE_ROWS: ReadonlyMap<ServedFirebaseSpecifier, LiveModuleKey> = new Map<ServedFirebaseSpecifier, LiveModuleKey>([
  ['firebase/app', 'live-app'],
  ['firebase/auth', 'live-auth'],
  ['firebase/firestore', 'live-firestore'],
  ['firebase/app-check', 'live-app-check'],
]);

/**
 * The module a plane serves for `specifier` under live mode: the app's own
 * `real` module, wrapped by its live row for `site`. Throws for a specifier
 * with no live row.
 */
export function liveModuleFor<T extends object>(specifier: ServedFirebaseSpecifier, real: T, site: LiveModuleSite): T {
  const key = LIVE_ROWS.get(specifier);
  if (key === undefined) throw new Error(`@pyric/live has no live row for ${specifier}.`);
  return wrapLiveModule(key, specifier, real, site);
}
