/**
 * Admin SDK file-tree membership and unobserved/gated Admin subpath tracking
 * for `@pyric/cli/register/internal/supplied-rows`.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { CjsResolveTurn } from './cjs-resolve-state.js';
import { canonicalFileUrl, packageNameOf, packageRootDirOf } from './package-identity.js';

export const LIVE_REGISTER_LOG_PREFIX = '@pyric/live/register';

/**
 * The files of the passed-through Admin SDK's tree: the entry an app's own
 * `firebase-admin` import resolved to, and every file a file of the tree
 * resolved, directly or not. Built-ins (`node:*`) and loader instrumentation
 * packages never join.
 */
export interface AdminTree {
  has(url: string): boolean;
  add(url: string): void;
  hasPackageDir(directory: string): boolean;
}

const INSTRUMENTATION_PACKAGES: ReadonlySet<string> = new Set([
  'require-in-the-middle',
  'import-in-the-middle',
]);

function safeRealpath(directory: string): string {
  try {
    return realpathSync(directory);
  } catch {
    return directory;
  }
}

export function createAdminTree(): AdminTree {
  const urls = new Set<string>();
  const packageDirs = new Set<string>();
  return {
    has: (url) => urls.has(url) || urls.has(canonicalFileUrl(url)),
    add(url) {
      if (!url.startsWith('file:')) return;
      const pkg = packageNameOf(url);
      if (pkg !== null && INSTRUMENTATION_PACKAGES.has(pkg)) return;
      urls.add(url);
      urls.add(canonicalFileUrl(url));
      const dir = packageRootDirOf(url);
      if (dir !== null) {
        packageDirs.add(dir);
        packageDirs.add(safeRealpath(dir));
      }
    },
    hasPackageDir: (directory) =>
      packageDirs.has(directory) || packageDirs.has(safeRealpath(directory)),
  };
}

/** Whether `url` is a file of the tree, as an import made from it names its importer. */
export function isAdminTreeImporter(tree: AdminTree, importer: string | undefined): boolean {
  return importer !== undefined && tree.has(importer);
}

/**
 * Whether this resolve is Node 22 resolving again a CommonJS file of the
 * Admin SDK's tree, by its own path and with no importer, as the stop's
 * `isCjsReloadOfAllowedFile` lets the rows' files through.
 */
export function isAdminTreeReload(
  tree: AdminTree,
  specifier: string,
  importer: string | undefined,
  url: string,
): boolean {
  const isFile = url.startsWith('file:');
  if (importer !== undefined || !isFile || !tree.has(url)) return false;
  return specifier === fileURLToPath(url);
}

/** Adds a resolved file to the tree and returns the resolution. */
export function joinAdminTree<T extends { url: string }>(tree: AdminTree, result: T): T {
  if (result.url.startsWith('file:')) tree.add(result.url);
  return result;
}

export function isNodeModulesPath(filePath: string): boolean {
  return filePath.includes('/node_modules/') || filePath.includes('\\node_modules\\');
}

function isInstalledNodeModulesUrl(url: string): boolean {
  return url.startsWith('file:') && isNodeModulesPath(fileURLToPath(url));
}

/**
 * True when a cached `node_modules` CJS hook runs `require.resolve(pkgName, { paths })`
 * on a package directory already loaded by the Admin SDK's tree.
 */
export function isAdminPackageMainProbe(
  specifier: string,
  importer: string | undefined,
  resolvedUrl: string,
  isEsmImport: boolean,
  cjsTurn: CjsResolveTurn | null,
  adminTree: AdminTree,
): boolean {
  if (isEsmImport || cjsTurn === null) return false;
  if (importer === undefined || !isInstalledNodeModulesUrl(importer)) return false;
  if (!cjsTurn.isResolveOnlyWithPaths(importer)) return false;
  const pkgName = packageNameOf(resolvedUrl);
  if (pkgName === null || specifier !== pkgName) return false;
  const pkgDir = packageRootDirOf(resolvedUrl);
  if (pkgDir === null) return false;
  return adminTree.hasPackageDir(pkgDir);
}

/**
 * The Admin subpaths no row serves that this process loaded, each once, in
 * load order: the first load prints one line, and the process health lists
 * them. Beside them, the subpaths whose row gates their calls but records
 * none (App Check), which the start line already names.
 */
export interface AdminUnobserved {
  note(subpath: string): void;
  list(): readonly string[];
  noteGated(subpath: string): void;
  gated(): readonly string[];
}

/** The line for the first load of an Admin subpath no row serves. */
export function adminUnobservedLine(subpath: string): string {
  return `${LIVE_REGISTER_LOG_PREFIX}: ${subpath} loads unobserved. Live mode lets it reach Google with your credential, and no row records its calls.`;
}

export function createAdminUnobserved(
  write: (line: string) => void,
  changed: () => void,
): AdminUnobserved {
  const loaded: string[] = [];
  const gated: string[] = [];
  return {
    note(subpath) {
      if (loaded.includes(subpath)) return;
      loaded.push(subpath);
      write(`${adminUnobservedLine(subpath)}\n`);
      changed();
    },
    list: () => [...loaded],
    noteGated(subpath) {
      if (gated.includes(subpath)) return;
      gated.push(subpath);
      changed();
    },
    gated: () => [...gated],
  };
}

/** The process health's unobserved Admin lists, each absent when empty. */
export function unobservedFields(
  admin: AdminUnobserved,
): { unobservedAdmin?: readonly string[]; gatedAdmin?: readonly string[] } {
  const unobservedAdmin = admin.list();
  const gatedAdmin = admin.gated();
  const fields: { unobservedAdmin?: readonly string[]; gatedAdmin?: readonly string[] } = {};
  if (unobservedAdmin.length > 0) fields.unobservedAdmin = unobservedAdmin;
  if (gatedAdmin.length > 0) fields.gatedAdmin = gatedAdmin;
  return fields;
}
