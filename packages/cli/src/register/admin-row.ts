/**
 * The Admin rows on the live register (D5 in the #2304 plan): the loads
 * through which every path of the real `firebase-admin` reaches the classes
 * its Firestore, Storage, Realtime Database, Auth, App Check and Messaging
 * calls run on. App Check's row gates its calls and records none. Each load,
 * made by a file of the passed-through Admin SDK's tree, resolves to a fixed
 * Admin row module instead. That module's source comes from the installed
 * `@pyric/live`: it loads the real module (its own require of the same
 * specifier, resolved as the Admin SDK's file asked) and exports it, so the
 * Admin SDK's modular entries and its namespace (`admin.firestore()`) both
 * get it.
 *
 * While the Admin rows are on, the Admin SDK loads only the folders those
 * services need. Every other `lib/<service>/` load is refused, so a service
 * pyric does not observe never loads, `security-rules` among them.
 *
 * Each row id is a file URL under `live-rows/admin/` beside this module, a
 * folder no package ships, so it loads only through the live register's load
 * hook (as `live-row.ts`'s ids do).
 *
 * Imports node built-ins and side-effect-free modules only.
 */

/** The Admin services the rows serve, one per class-defining load. */
export type AdminRowName = 'firestore' | 'storage' | 'database' | 'auth' | 'app-check' | 'messaging';

/** One class-defining load: the specifier a file of the Admin SDK requires, and the package its file belongs to. */
export interface AdminRowLoad {
  readonly specifier: string;
  readonly packageName: string;
  /** The file's path in its package, when the specifier is relative. */
  readonly pathInPackage?: string;
}

/** The loads, as firebase-admin 13's own files require them. */
export const ADMIN_ROW_LOADS: ReadonlyMap<AdminRowName, AdminRowLoad> = new Map<AdminRowName, AdminRowLoad>([
  ['firestore', { specifier: '@google-cloud/firestore', packageName: '@google-cloud/firestore' }],
  ['storage', { specifier: '@google-cloud/storage', packageName: '@google-cloud/storage' }],
  ['database', { specifier: '@firebase/database-compat/standalone', packageName: '@firebase/database-compat' }],
  ['auth', { specifier: './base-auth', packageName: 'firebase-admin', pathInPackage: 'lib/auth/base-auth.js' }],
  ['app-check', { specifier: './app-check', packageName: 'firebase-admin', pathInPackage: 'lib/app-check/app-check.js' }],
  ['messaging', { specifier: './messaging', packageName: 'firebase-admin', pathInPackage: 'lib/messaging/messaging.js' }],
]);

const ADMIN_ROWS_DIR = new URL('./live-rows/admin/', import.meta.url).href;

/** The one module id for each Admin row. */
export const ADMIN_ROW_URLS: ReadonlyMap<AdminRowName, string> = new Map(
  [...ADMIN_ROW_LOADS.keys()].map((name) => [name, `${ADMIN_ROWS_DIR}${name}.cjs`]),
);

/** Whether a URL is one of the Admin row ids. */
export function isAdminRowUrl(url: string | undefined): boolean {
  return url !== undefined && [...ADMIN_ROW_URLS.values()].includes(url);
}

/** The Admin row a URL is the id of, or null. */
export function adminRowOfUrl(url: string | undefined): AdminRowName | null {
  for (const [name, rowUrl] of ADMIN_ROW_URLS) if (rowUrl === url) return name;
  return null;
}

/** Where a load from the Admin SDK's tree landed: its specifier, and its file's package and path in it. */
export interface AdminTreeLoad {
  readonly specifier: string;
  readonly packageName: string | null;
  readonly pathInPackage: string | null;
}

function matchesLoad(load: AdminTreeLoad, row: AdminRowLoad): boolean {
  const isSpecifier = load.specifier === row.specifier && load.packageName === row.packageName;
  if (!isSpecifier) return false;
  return row.pathInPackage === undefined || load.pathInPackage === row.pathInPackage;
}

/** The Admin row a load from the Admin SDK's tree is, or null for any other load. */
export function adminRowOf(load: AdminTreeLoad): AdminRowName | null {
  for (const [name, row] of ADMIN_ROW_LOADS) if (matchesLoad(load, row)) return name;
  return null;
}

/**
 * The folders of `firebase-admin/lib/` the Admin rows' services load: the
 * app, the six services, the shared code and credentials, and the ESM
 * wrappers. The top-level `lib/*.js` files (the namespace) load too.
 */
const SERVED_ADMIN_FOLDERS: ReadonlySet<string> = new Set([
  'app',
  'auth',
  'firestore',
  'database',
  'storage',
  'app-check',
  'messaging',
  'utils',
  'credential',
  'esm',
]);

/** `lib/<folder>/...`, the folder of a file of firebase-admin. */
const LIB_FOLDER = /^lib\/([^/]+)\//;

/**
 * The Admin service a load of a firebase-admin file would start that the
 * Admin rows do not serve (`security-rules`, `remote-config`, ...), or null when
 * the file is served or is not under `lib/<service>/`.
 */
export function unservedAdminService(packageName: string | null, pathInPackage: string | null): string | null {
  if (packageName !== 'firebase-admin' || pathInPackage === null) return null;
  const folder = LIB_FOLDER.exec(pathInPackage)?.[1];
  if (folder === undefined || SERVED_ADMIN_FOLDERS.has(folder)) return null;
  return folder;
}
