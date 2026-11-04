/**
 * Live rows on the Node register: the four served specifiers `@pyric/live`
 * serves from the app's installed Firebase SDK, as the Vite page plane does
 * (`../serve/vite-supplied-rows.ts`). The row modules' ids are fixed, one
 * per specifier (`live-row.ts`), and their source comes from the
 * `@pyric/live` installed in the project (`live-package.ts`). The real-SDK
 * stop opens only for one of those modules' own import of its specifier.
 * Every other Firebase import, served or not, and every `firebase-admin`
 * import is refused, never sent to a sandbox mirror, so one app object never
 * mixes the installed SDK with sandbox services.
 *
 * Imports node built-ins and side-effect-free modules only.
 */
import type { SuppliedRowsRefusal } from '../serve/vite-supplied-rows.js';
import type { ServedFirebaseSpecifier } from '../serve/firebase-module-swap.js';
import { REGISTER_ROW_URLS, isRegisterLiveModule } from './live-row.js';

/** What the register reads from the installed `@pyric/live`. */
export interface RegisterRowPackage {
  /** The file URL every row module resolves its own specifier from: the project's `package.json`. */
  readonly projectUrl: string;
  /** The source of a fixed live module id, or null for any other id. */
  moduleSource(url: string): string | null;
}

/**
 * The live rows of one register. They stay shut, refusing every Firebase
 * import, until {@link RegisterRows.open} is given the installed `@pyric/live`.
 */
export interface RegisterRows {
  readonly refusal: SuppliedRowsRefusal;
  /** The installed `@pyric/live`, or null while the rows are shut. */
  package(): RegisterRowPackage | null;
  open(found: RegisterRowPackage): void;
}

/** Shut live rows with the supplier's refusal. */
export function registerRows(refusal: SuppliedRowsRefusal): RegisterRows {
  let found: RegisterRowPackage | null = null;
  return {
    refusal,
    package: () => found,
    open(next) {
      found = next;
    },
  };
}

export type RegisterRowsResolution =
  | { readonly kind: 'module'; readonly url: string }
  | { readonly kind: 'installed-sdk'; readonly projectUrl: string }
  | { readonly kind: 'refused'; readonly error: Error }
  | { readonly kind: 'unserved' };

/** `firebase`, `firebase/*`, `firebase-admin` and `firebase-admin/*`, as an app names them. */
const FIREBASE_IMPORT = /^firebase(-admin)?(\/.+)?$/;

/**
 * What an import gets under live rows: the row's module; the installed SDK,
 * when that row module imports its own specifier; the refusal, for every
 * other Firebase and `firebase-admin` import and for every one while the rows
 * are shut; or `unserved` for anything else, which resolves as Node resolves
 * it and still meets the stop.
 */
export function registerRowsResolution(rows: RegisterRows, specifier: string, importer: string | undefined): RegisterRowsResolution {
  const isLiveModule = isRegisterLiveModule(specifier);
  const found = rows.package();
  if (isLiveModule && found !== null) return { kind: 'module', url: specifier };
  const isFirebaseImport = FIREBASE_IMPORT.test(specifier);
  if (!isFirebaseImport) return { kind: 'unserved' };
  const url = REGISTER_ROW_URLS.get(specifier as ServedFirebaseSpecifier);
  if (url === undefined || found === null) return { kind: 'refused', error: rows.refusal(specifier, 'node') };
  return importer === url ? { kind: 'installed-sdk', projectUrl: found.projectUrl } : { kind: 'module', url };
}

/** The source the load hook serves for a fixed live module. Throws while the rows are shut. */
export function registerLiveModuleSource(rows: RegisterRows, url: string): string {
  const found = rows.package();
  if (found === null) throw new Error(`pyric: ${url} is a live row module, and @pyric/live has not opened the rows.`);
  const source = found.moduleSource(url);
  if (source === null) throw new Error(`pyric: @pyric/live has no source for the live module ${url}.`);
  return source;
}
