/**
 * The fixed ids of the live row modules on the Node register
 * (`supplied-rows.ts`): one per live row, and one for the observer module
 * the rows share. Each is a file URL under `live-rows/` beside this module,
 * a folder no package ships, so an id loads only through the live
 * register's load hook, which serves its source from the installed
 * `@pyric/live`. Without that hook the import fails as not found, and
 * nothing behind it loads.
 *
 * The row is in the path, not a query: a module `require()` loads sees its
 * importer's URL without the query, and every row must know its own id.
 */
import { INSTALLED_SDK_SPECIFIERS } from '../serve/vite-supplied-rows.js';
import type { ServedFirebaseSpecifier } from '../serve/firebase-module-swap.js';

const LIVE_ROWS_DIR = new URL('./live-rows/', import.meta.url).href;

/** The one module id for each live row. No other id is a row module. */
export const REGISTER_ROW_URLS: ReadonlyMap<ServedFirebaseSpecifier, string> = new Map(
  [...INSTALLED_SDK_SPECIFIERS].map((specifier) => [specifier, `${LIVE_ROWS_DIR}${specifier}.js`]),
);

/** The id of the one observer module every row module imports. */
export const REGISTER_OBSERVER_URL = `${LIVE_ROWS_DIR}observer.js`;

/** Whether a URL is one of the fixed modules whose source comes from the installed `@pyric/live`. */
export function isRegisterLiveModule(url: string): boolean {
  return url === REGISTER_OBSERVER_URL || [...REGISTER_ROW_URLS.values()].includes(url);
}
