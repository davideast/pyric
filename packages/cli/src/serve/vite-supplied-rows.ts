/**
 * Rows another workspace package serves on the Vite page plane in place of
 * the swap: one module per served specifier, each loading the app's own
 * installed Firebase SDK. The swap's real-SDK stop opens for a row's own
 * module only, and only for the specifiers in
 * {@link INSTALLED_SDK_SPECIFIERS}. Every other served specifier is refused
 * with the supplier's error, never sent to the sandbox row, so one app object
 * never mixes the installed SDK with sandbox services.
 *
 * `pyric()` supplies no rows. A plugin gets them only through
 * `@pyric/cli/vite/internal/supplied-rows`, which is not a public entry.
 */
import { SDK_MODULES, type ServedFirebaseSpecifier } from './firebase-module-swap.js';

/** The served specifiers a supplied row may serve from the app's installed SDK. */
export const INSTALLED_SDK_SPECIFIERS: ReadonlySet<ServedFirebaseSpecifier> = new Set<ServedFirebaseSpecifier>([
  'firebase/app',
  'firebase/auth',
  'firebase/firestore',
  'firebase/app-check',
]);

/** Where a refused import was made: page code, or server code Vite runs. */
export type SuppliedRowsPlane = 'page' | 'server';

export interface SuppliedRows {
  /**
   * Served specifier to the id of the module the supplier serves for it.
   * That module's own import of the same specifier reaches the installed SDK.
   */
  readonly modules: ReadonlyMap<ServedFirebaseSpecifier, string>;
  /** The error for a served specifier with no row, and for every server-rendered Firebase import. */
  readonly refusal: (specifier: string, plane: SuppliedRowsPlane) => Error;
}

/** Rows checked against {@link INSTALLED_SDK_SPECIFIERS}. Throws for a row outside it. */
export function suppliedRows(rows: SuppliedRows): SuppliedRows {
  for (const specifier of rows.modules.keys()) {
    const opensStop = !INSTALLED_SDK_SPECIFIERS.has(specifier);
    if (opensStop) throw new Error(`pyric: a supplied row cannot serve ${specifier} from the installed Firebase SDK.`);
  }
  return { modules: new Map(rows.modules), refusal: rows.refusal };
}

export type SuppliedRowsResolution =
  | { readonly kind: 'module'; readonly id: string }
  | { readonly kind: 'installed-sdk' }
  | { readonly kind: 'refused'; readonly error: Error }
  | { readonly kind: 'unserved' };

const SERVED: ReadonlySet<string> = new Set(SDK_MODULES);

/**
 * What a page-plane `firebase/*` import gets under supplied rows: the row's
 * module; the installed SDK, when the row's own module imports its
 * specifier; the supplier's refusal, for any other served specifier; or
 * `unserved`, which the swap's stop answers as it does without rows.
 */
export function suppliedRowsResolution(rows: SuppliedRows, source: string, importer: string | undefined): SuppliedRowsResolution {
  const isServed = SERVED.has(source);
  if (!isServed) return { kind: 'unserved' };
  const specifier = source as ServedFirebaseSpecifier;
  const id = rows.modules.get(specifier);
  if (id === undefined) return { kind: 'refused', error: rows.refusal(specifier, 'page') };
  const isRowModule = importer === id && INSTALLED_SDK_SPECIFIERS.has(specifier);
  return isRowModule ? { kind: 'installed-sdk' } : { kind: 'module', id };
}
