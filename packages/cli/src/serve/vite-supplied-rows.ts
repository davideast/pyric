/**
 * Live rows on the Vite page plane: the four served specifiers `@pyric/live`
 * serves from the app's installed Firebase SDK, in place of the swap. The
 * row modules' ids are fixed here, one per specifier, and their source comes
 * from the `@pyric/live` package installed in the project
 * (`vite-live-package.ts`). The swap's real-SDK stop opens only for one of
 * those virtual modules' own import of its specifier, and only once that
 * package is found. Every other Firebase and `firebase-admin` import is
 * refused, never sent to the sandbox row or the stop, so one app object
 * never mixes the installed SDK with sandbox services. So is every
 * `@firebase/*` import, except one from an SDK file the rows loaded, and
 * every load of an installed SDK file, by whatever specifier, path or URL,
 * that the rows did not lead to (`vite-module-swap.ts`), as the Node plane's
 * stop decides by the resolved file (`../register/swap-or-stop.ts`).
 *
 * `pyric()` supplies no rows. A plugin gets them only through
 * `@pyric/cli/vite/internal/supplied-rows`, which takes no module ids.
 */
import { realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
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
  /**
   * The installed SDK files the rows loaded on the page, as real file URLs,
   * as the Node plane's stop records them (`suppliedRowsStopFor`). Only these
   * files may import more of the SDK.
   */
  readonly liveSdkUrls: Set<string>;
}

/** Shut live rows with the supplier's refusal. */
export function suppliedRows(refusal: SuppliedRowsRefusal): SuppliedRows {
  let found: RowModulePackage | null = null;
  return {
    refusal,
    liveSdkUrls: new Set(),
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

/** `@firebase/*`: the SDK's own packages, which `firebase/*` imports. */
const SDK_PACKAGE_IMPORT = /^@firebase\/[^/]+(\/.+)?$/;

/**
 * Whether the live rows answer this import on the page plane: every Firebase,
 * `firebase-admin` and `@firebase/*` import.
 */
export function isSuppliedRowsImport(source: string): boolean {
  return FIREBASE_IMPORT.test(source) || SDK_PACKAGE_IMPORT.test(source);
}

/**
 * The real file URL of a Vite module id, without the query or hash Vite may
 * add, or null for a virtual id or one that names no file on disk.
 */
export function realFileUrlOf(id: string): string | null {
  const file = id.replace(/[?#].*$/, '');
  if (!isAbsolute(file)) return null;
  try {
    return pathToFileURL(realpathSync(file)).href;
  } catch {
    return null;
  }
}

/** Whether `importer` is one of the installed SDK files the rows loaded on the page. */
function isLoadedSdkFile(rows: SuppliedRows, importer: string | undefined): boolean {
  if (importer === undefined) return false;
  const url = realFileUrlOf(importer);
  return url !== null && rows.liveSdkUrls.has(url);
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
  const isSdkPackageImport = SDK_PACKAGE_IMPORT.test(source);
  const isOpen = rows.package() !== null;
  if (isSdkPackageImport) {
    const isSdkOwnImport = isOpen && isLoadedSdkFile(rows, importer);
    return isSdkOwnImport ? { kind: 'unserved' } : { kind: 'refused', error: rows.refusal(source, 'page') };
  }
  const id = ROW_MODULE_IDS.get(source as ServedFirebaseSpecifier);
  const isShut = rows.package() === null;
  if (id === undefined || isShut) return { kind: 'refused', error: rows.refusal(source, 'page') };
  return importer === id ? { kind: 'installed-sdk' } : { kind: 'module', id };
}
