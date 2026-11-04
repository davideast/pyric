/**
 * Live rows on the Vite page plane: the four served specifiers `@pyric/live`
 * serves from the app's installed Firebase SDK, in place of the swap. The
 * row modules' ids are fixed here, one per specifier, and their source comes
 * from the `@pyric/live` package installed in the project
 * (`vite-live-package.ts`). The swap's real-SDK stop opens only for one of
 * those virtual modules' own import of its specifier, and only once that
 * package is found. Every other Firebase and `firebase-admin` import is
 * refused, never sent to the sandbox row or the stop, so one app object
 * never mixes the installed SDK with sandbox services.
 *
 * `pyric()` supplies no rows. A plugin gets them only through
 * `@pyric/cli/vite/internal/supplied-rows`, which takes no module ids.
 */
import type { ServedFirebaseSpecifier } from './firebase-module-swap.js';
import type { RowModulePackage } from './vite-live-package.js';

/** The served specifiers a live row serves from the app's installed SDK. */
export const INSTALLED_SDK_SPECIFIERS: ReadonlySet<ServedFirebaseSpecifier> = new Set<ServedFirebaseSpecifier>([
  'firebase/app',
  'firebase/auth',
  'firebase/firestore',
  'firebase/app-check',
]);

/** The prefix of every module id the live rows serve; `\0` keeps every other plugin off them. */
const ROW_MODULE_PREFIX = '\0pyric-live:';

/** The one module id for each live row. No other id is a row module. */
export const ROW_MODULE_IDS: ReadonlyMap<ServedFirebaseSpecifier, string> = new Map(
  [...INSTALLED_SDK_SPECIFIERS].map((specifier) => [specifier, `${ROW_MODULE_PREFIX}${specifier}`]),
);

/** The id of the one observer module every row module imports, and the specifier they import it by. */
export const OBSERVER_MODULE_ID = `${ROW_MODULE_PREFIX}observer`;
export const OBSERVER_SPECIFIER = 'virtual:pyric-live-observer';

/** Whether an id is one of the fixed modules whose source comes from the installed `@pyric/live`. */
export function isLiveModuleId(id: string): boolean {
  return id === OBSERVER_MODULE_ID || [...ROW_MODULE_IDS.values()].includes(id);
}

/**
 * Where a refused import was made: page code, server code Vite runs, or a
 * Node process under a register that serves supplied rows
 * (`../register/supplied-rows.ts`).
 */
export type SuppliedRowsPlane = 'page' | 'server' | 'node';

/** The refusal a supplier gives for a served specifier with no row, and for every server-rendered Firebase import. */
export type SuppliedRowsRefusal = (specifier: string, plane: SuppliedRowsPlane) => Error;

/**
 * The live rows of one plugin. They stay shut, refusing every served
 * specifier, until {@link SuppliedRows.open} is given the installed
 * `@pyric/live`.
 */
export interface SuppliedRows {
  readonly refusal: SuppliedRowsRefusal;
  /** The installed `@pyric/live`, or null while the rows are shut. */
  package(): RowModulePackage | null;
  /** Opens the rows with the package found from the project root. */
  open(found: RowModulePackage): void;
}

/** Shut live rows with the supplier's refusal. */
export function suppliedRows(refusal: SuppliedRowsRefusal): SuppliedRows {
  let found: RowModulePackage | null = null;
  return {
    refusal,
    package: () => found,
    open(next) {
      found = next;
    },
  };
}

export type SuppliedRowsResolution =
  | { readonly kind: 'module'; readonly id: string }
  | { readonly kind: 'installed-sdk' }
  | { readonly kind: 'refused'; readonly error: Error }
  | { readonly kind: 'unserved' };

/** `firebase`, `firebase/*`, `firebase-admin` and `firebase-admin/*`, as an app names them. */
const FIREBASE_IMPORT = /^firebase(-admin)?(\/.+)?$/;

/** Whether the live rows answer this import on the page plane: every Firebase and `firebase-admin` import. */
export function isSuppliedRowsImport(source: string): boolean {
  return FIREBASE_IMPORT.test(source);
}

/**
 * What a page-plane Firebase import gets under live rows: the row's module;
 * the installed SDK, when that row module imports its own specifier; the
 * refusal, for every other `firebase`, `firebase/*` and `firebase-admin`
 * import, served by pyric or not, and for every one while the rows are shut,
 * as the Node register refuses them (`../register/supplied-rows.ts`); or
 * `unserved` for anything else.
 */
export function suppliedRowsResolution(rows: SuppliedRows, source: string, importer: string | undefined): SuppliedRowsResolution {
  const isFirebaseImport = isSuppliedRowsImport(source);
  if (!isFirebaseImport) return { kind: 'unserved' };
  const id = ROW_MODULE_IDS.get(source as ServedFirebaseSpecifier);
  const isShut = rows.package() === null;
  if (id === undefined || isShut) return { kind: 'refused', error: rows.refusal(source, 'page') };
  return importer === id ? { kind: 'installed-sdk' } : { kind: 'module', id };
}
