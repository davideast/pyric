/**
 * Live rows on the Node register: the served specifiers `@pyric/live` serves
 * from the app's installed Firebase SDK (`INSTALLED_SDK_SPECIFIERS`), as the
 * Vite page plane does (`../serve/vite-supplied-rows.ts`). The row modules'
 * ids are fixed, one per specifier (`live-row.ts`), and their source comes
 * from the `@pyric/live` installed in the project (`live-package.ts`), as
 * does the refusal. The real-SDK stop opens only for one of those modules'
 * own ESM import of its specifier.
 * Every other Firebase import, served or not, and every `firebase-admin`
 * import the register does not pass through, is refused, never sent to a
 * sandbox mirror, so one app object never mixes the installed SDK with
 * sandbox services.
 *
 * The register may also pass served specifiers through (`passThrough`), as
 * the page plane does: each loads the app's installed SDK unwrapped, with no
 * row and no observer. Only a specifier with no live row can pass through
 * (`passThroughSet`). `@pyric/live/register` lists `firebase-admin` itself
 * on Node 23 or later: every `firebase-admin` and `firebase-admin/*` import
 * then loads the real Admin SDK, with the app's own credential
 * (`supplied-entry.ts` records the files it loads).
 *
 * The register opens the Admin rows (`admin-row.ts`) with it (`adminRows`):
 * the Admin SDK's four class-defining loads resolve to the Admin row modules,
 * which observe them, and its other services are refused.
 *
 * Imports node built-ins and side-effect-free modules only.
 */
import { passesAdminThrough, type PassThroughSpecifier, type SuppliedRowsRefusal } from '../serve/vite-supplied-rows.js';
import type { ServedFirebaseSpecifier } from '../serve/firebase-module-swap.js';
import { REGISTER_ROW_URLS, isRegisterLiveModule } from './live-row.js';
import { ADMIN_ROW_URLS, adminRowOf, unservedAdminService } from './admin-row.js';
import { packageNameOf, pathInPackageOf } from './package-identity.js';

/** What the register reads from the installed `@pyric/live`. */
export interface RegisterRowPackage {
  /** The file URL every row module resolves its own specifier from: the project's `package.json`. */
  readonly projectUrl: string;
  /** The error for a refused import. */
  readonly refusal: SuppliedRowsRefusal;
  /** The source of a fixed live module id, or null for any other id. */
  moduleSource(url: string): string | null;
}

/**
 * The live rows of one register. They stay shut, refusing every Firebase
 * import, until {@link RegisterRows.open} is given the installed `@pyric/live`.
 */
export interface RegisterRows {
  /** The served specifiers with no row that load the installed SDK unwrapped and unobserved, and `firebase-admin` when listed. */
  readonly passThrough: ReadonlySet<PassThroughSpecifier>;
  /** Whether the passed-through Admin SDK's loads go to the Admin rows (`admin-row.ts`). */
  readonly adminRows: boolean;
  /** The installed `@pyric/live`, or null while the rows are shut. */
  package(): RegisterRowPackage | null;
  open(found: RegisterRowPackage): void;
}

/** The refusal while the rows are shut, before the installed `@pyric/live` gives its own. */
function shutRefusal(specifier: string): Error {
  const error = new Error(`pyric: ${specifier} is refused, because the live rows are shut until @pyric/live opens them.`);
  return Object.assign(error, { code: 'PYRIC_LIVE_REFUSED' });
}

/**
 * Shut live rows, with the specifiers that pass through once they open.
 * `adminRows` opens the Admin rows, as `@pyric/live/register` does on Node 23 or later.
 */
export function registerRows(passThrough: ReadonlySet<PassThroughSpecifier> = new Set(), adminRows = false): RegisterRows {
  let found: RegisterRowPackage | null = null;
  return {
    passThrough,
    adminRows,
    package: () => found,
    open(next) {
      found = next;
    },
  };
}

export type RegisterRowsResolution =
  | { readonly kind: 'module'; readonly url: string }
  | { readonly kind: 'installed-sdk'; readonly projectUrl: string }
  | { readonly kind: 'pass-through' }
  | { readonly kind: 'admin-pass-through' }
  | { readonly kind: 'admin-row'; readonly url: string }
  | { readonly kind: 'refused'; readonly error: Error }
  | { readonly kind: 'unserved' };

/** `firebase`, `firebase/*`, `firebase-admin` and `firebase-admin/*`, as an app names them. */
const FIREBASE_IMPORT = /^firebase(-admin)?(\/.+)?$/;

/** `firebase-admin` and `firebase-admin/*`. */
const ADMIN_IMPORT = /^firebase-admin(\/.+)?$/;

/** How an import names its module: the specifier, the importer's URL, and the resolve conditions. */
export interface RegisterRowsImport {
  readonly specifier: string;
  readonly importer: string | undefined;
  /** An array on an ESM import; Node 22 passes a `require()` other shapes, or none. */
  readonly conditions: unknown;
}

/** Whether a resolve hook's conditions name `import`: an ESM import, never a `require()`. */
export function isImportCondition(conditions: unknown): boolean {
  const isList = Array.isArray(conditions) || conditions instanceof Set;
  if (!isList) return false;
  return [...(conditions as Iterable<unknown>)].includes('import');
}

/**
 * Whether the import is the row module's own: its ESM import of its
 * specifier. Rows are ES modules, so their import resolves with the `import`
 * condition. A `createRequire` call can name the row's URL as its importer,
 * but it resolves with `require`, so it gets the row again, never the
 * installed SDK behind it.
 */
function isOwnRowImport(rowUrl: string, request: RegisterRowsImport): boolean {
  const isFromRow = request.importer === rowUrl;
  const isEsmImport = isImportCondition(request.conditions);
  return isFromRow && isEsmImport;
}

/**
 * What an import gets under live rows: the row's module; the installed SDK,
 * when that row module imports its own specifier; the installed SDK
 * unwrapped, for a specifier the register passes through; the real Admin
 * SDK, for a `firebase-admin` import when the register passes it through; the refusal, for every
 * other Firebase and `firebase-admin` import and for every one while the rows
 * are shut; or `unserved` for anything else, which resolves as Node resolves
 * it and still meets the stop.
 */
export function registerRowsResolution(rows: RegisterRows, request: RegisterRowsImport): RegisterRowsResolution {
  const specifier = request.specifier;
  const isLiveModule = isRegisterLiveModule(specifier);
  const found = rows.package();
  if (isLiveModule && found !== null) return { kind: 'module', url: specifier };
  const isFirebaseImport = FIREBASE_IMPORT.test(specifier);
  if (!isFirebaseImport) return { kind: 'unserved' };
  const url = REGISTER_ROW_URLS.get(specifier as ServedFirebaseSpecifier);
  if (found === null) return { kind: 'refused', error: shutRefusal(specifier) };
  const isPassThrough = rows.passThrough.has(specifier as PassThroughSpecifier) && !ADMIN_IMPORT.test(specifier);
  if (isPassThrough) return { kind: 'pass-through' };
  const isAdminPassThrough = ADMIN_IMPORT.test(specifier) && passesAdminThrough(rows.passThrough);
  if (isAdminPassThrough) return { kind: 'admin-pass-through' };
  if (url === undefined) return { kind: 'refused', error: found.refusal(specifier, 'node') };
  return isOwnRowImport(url, request) ? { kind: 'installed-sdk', projectUrl: found.projectUrl } : { kind: 'module', url };
}

/** A load the passed-through Admin SDK made, or the app's own `firebase-admin` import, and where Node resolved it. */
export interface AdminTreeRequest {
  readonly specifier: string;
  readonly url: string;
  /** Defaults to the manifest lookup in `package-identity.ts`. */
  readonly nameOf?: (url: string) => string | null;
  /** Defaults to `pathInPackageOf` in `package-identity.ts`. */
  readonly pathInPackage?: (url: string, packageName: string) => string | null;
}

/**
 * What a load of the passed-through Admin SDK gets while the Admin rows are
 * on: the Admin row module at its four class-defining loads, the refusal for
 * a file of a `lib/<service>/` folder the rows do not serve, or `unserved`
 * for anything else, which loads as Node resolved it. Always `unserved`
 * while the Admin rows are shut.
 */
export function adminTreeResolution(rows: RegisterRows, request: AdminTreeRequest): RegisterRowsResolution {
  const found = rows.package();
  if (!rows.adminRows || found === null) return { kind: 'unserved' };
  const packageName = (request.nameOf ?? packageNameOf)(request.url);
  const pathOf = request.pathInPackage ?? pathInPackageOf;
  const pathInPackage = packageName === null ? null : pathOf(request.url, packageName);
  const row = adminRowOf({ specifier: request.specifier, packageName, pathInPackage });
  if (row !== null) return { kind: 'admin-row', url: ADMIN_ROW_URLS.get(row)! };
  const service = unservedAdminService(packageName, pathInPackage);
  if (service === null) return { kind: 'unserved' };
  return { kind: 'refused', error: found.refusal(`firebase-admin/${service}`, 'node') };
}

/** The source the load hook serves for a fixed live module. Throws while the rows are shut. */
export function registerLiveModuleSource(rows: RegisterRows, url: string): string {
  const found = rows.package();
  if (found === null) throw new Error(`pyric: ${url} is a live row module, and @pyric/live has not opened the rows.`);
  const source = found.moduleSource(url);
  if (source === null) throw new Error(`pyric: @pyric/live has no source for the live module ${url}.`);
  return source;
}
