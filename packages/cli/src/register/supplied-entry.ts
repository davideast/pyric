/**
 * `@pyric/cli/register/internal/supplied-rows`: the one seam through which
 * `@pyric/live/register` serves its rows to a Node process, over this
 * package's resolve hooks, stop, worker and child-process guards. Its caller
 * gives only where it is installed and the imports that pass through: the
 * row modules' ids are fixed (`live-row.ts`), and their source, the refusal
 * and the register entry children load all come from the installed
 * `@pyric/live` (`live-package.ts`). The gate is that installed package:
 * without it the register refuses to start. `@pyric/cli/register` never
 * reads this module, and no option, flag or environment variable turns live
 * mode on. When `firebase-admin` passes through, the
 * real Admin SDK loads with the app's own credential, which pyric never
 * reads, its class-defining loads go to the Admin rows when they are open,
 * and a service no row serves loads unobserved.
 */
import { readFileSync, realpathSync } from 'node:fs';
import Module from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installCjsResolveState, type CjsResolveState, type CjsResolveTurn, type DirectResolveGuard } from './cjs-resolve-state.js';
import { canonicalFileUrl, packageNameOf, packageRootDirOf } from './package-identity.js';
import { liveProjectId } from '../serve/live-project.js';
import { isLiveRegisterActive, isRegisterActive, markLiveRegisterActive } from './activation.js';
import { installChildProcessGuard } from './child-process-guard.js';
import { LIVE_PASS_THROUGH_VARIABLE, LIVE_PROJECT_ROOT_VARIABLE, LIVE_SDK_ROOT_VARIABLE, liveProjectRoot, loadInstalledLiveRegister, recordedPassThrough } from './live-package.js';
import { ADMIN_PASS_THROUGH, passThroughSdkPackages, passThroughSet } from '../serve/vite-supplied-rows.js';
import { createStopReporter, suppliedRowsStopFor } from './swap-or-stop.js';
import { isRegisterLiveModule } from './live-row.js';
import { ADMIN_ROW_LOADS, adminRowOfUrl, isAdminRowUrl } from './admin-row.js';
import { adminTreeResolution, isImportCondition, registerLiveModuleSource, registerRows, registerRowsResolution, type RegisterRows } from './supplied-rows.js';
import { installWorkerGuard } from './worker-guard.js';
import { installProcessHealth } from './process-health.js';
import { createUnobservedForwarder, onReattach, type UnobservedForwarder } from './unobserved-forward.js';
import type { NodeUnobservedLists } from 'pyric/sandbox/internal';

export { REGISTER_OBSERVER_URL, REGISTER_ROW_URLS } from './live-row.js';
export { ADMIN_ROW_LOADS, ADMIN_ROW_URLS, adminRowOfUrl, type AdminRowName } from './admin-row.js';
export { reachLiveHost, type LiveHostReach } from './live-host-reach.js';
export { liveProjectId } from '../serve/live-project.js';
export { LIVE_PROJECT_ROOT_VARIABLE, liveAppDirs, liveProjectRoot, recordedPassThrough } from './live-package.js';
export { idTokenIssuer, livePassThroughLine } from 'pyric/sandbox/internal';
export { swappedFirebaseEntries } from '../serve/firebase-module-swap.js';
export type { FirebaseRowSet, ServedFirebaseSpecifier } from '../serve/firebase-module-swap.js';
export type { SuppliedRowsPlane, SuppliedRowsRefusal } from '../serve/vite-supplied-rows.js';
export type { ObservedCall, ObservedCallService, ProductionOutcome } from 'pyric/sandbox';

interface ResolveContext {
  parentURL?: string;
  conditions?: string[];
}
interface ResolveResult {
  url: string;
  format?: string | null;
  shortCircuit?: boolean;
}
type NextResolve = (specifier: string, context?: ResolveContext) => ResolveResult;
type Resolve = (specifier: string, context: ResolveContext, nextResolve: NextResolve) => ResolveResult;

interface LoadContext {
  format?: string | null;
}
interface LoadResult {
  format?: string | null;
  source?: string | Uint8Array;
  shortCircuit?: boolean;
}
type NextLoad = (url: string, context?: LoadContext) => LoadResult;
type Load = (url: string, context: LoadContext, nextLoad: NextLoad) => LoadResult;

const moduleApi = Module as unknown as {
  registerHooks?: (hooks: { resolve: Resolve; load: Load }) => void;
};

const LOG_PREFIX = '@pyric/live/register';

/**
 * The files of the passed-through Admin SDK's tree: the entry an app's own
 * `firebase-admin` import resolved to, and every file a file of the tree
 * resolved, directly or not. Built-ins (`node:*`) and loader instrumentation
 * packages never join.
 */
interface AdminTree {
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

function createAdminTree(): AdminTree {
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
function isAdminTreeImporter(tree: AdminTree, importer: string | undefined): boolean {
  return importer !== undefined && tree.has(importer);
}

/**
 * Whether this resolve is Node 22 resolving again a CommonJS file of the
 * Admin SDK's tree, by its own path and with no importer, as the stop's
 * `isCjsReloadOfAllowedFile` lets the rows' files through.
 */
function isAdminTreeReload(tree: AdminTree, specifier: string, importer: string | undefined, url: string): boolean {
  const isFile = url.startsWith('file:');
  if (importer !== undefined || !isFile || !tree.has(url)) return false;
  return specifier === fileURLToPath(url);
}

/** Adds a resolved file to the tree and returns the resolution. */
function joinAdminTree(tree: AdminTree, result: ResolveResult): ResolveResult {
  if (result.url.startsWith('file:')) tree.add(result.url);
  return result;
}

function isNodeModulesPath(filePath: string): boolean {
  return filePath.includes('/node_modules/') || filePath.includes('\\node_modules\\');
}

function isInstalledNodeModulesUrl(url: string): boolean {
  return url.startsWith('file:') && isNodeModulesPath(fileURLToPath(url));
}

/**
 * True when a cached `node_modules` CJS hook runs `require.resolve(pkgName, { paths })`
 * on a package directory already loaded by the Admin SDK's tree.
 */
function isAdminPackageMainProbe(
  specifier: string, importer: string | undefined, resolvedUrl: string,
  isEsmImport: boolean, cjsTurn: CjsResolveTurn | null, adminTree: AdminTree,
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
 * The real file behind each Admin row: where the Admin SDK's own load of it
 * first resolved. A `require()` resolves from its calling module, not from a
 * `parentURL` a hook passes on, so the row's own require is answered with
 * this file's path.
 */
type AdminRowFiles = Map<string, string>;

function adminRowRealPath(realFiles: AdminRowFiles, importer: string, specifier: string): string | null {
  const row = adminRowOfUrl(importer);
  if (row === null) return null;
  const realFile = realFiles.get(importer);
  if (realFile === undefined) return null;
  const expectedSpecifier = ADMIN_ROW_LOADS.get(row)?.specifier;
  const realPath = fileURLToPath(realFile);
  if (specifier !== expectedSpecifier && specifier !== realPath) return null;
  return realPath;
}

/**
 * The real module behind an Admin row: the row's own `require.resolve` of its
 * load's specifier (and subsequent `require` of that resolved path) gets the
 * file the Admin SDK's load resolved to, which joins the tree. Null for any
 * other import from a row id or any uncached `createRequire` caller.
 */
function resolveAdminRowOwn(
  realFiles: AdminRowFiles,
  adminTree: AdminTree,
  cjsTurn: CjsResolveTurn | null,
  specifier: string,
  context: ResolveContext,
  nextResolve: NextResolve,
): ResolveResult | null {
  const importer = context.parentURL;
  if (importer === undefined || cjsTurn === null) return null;
  const realPath = adminRowRealPath(realFiles, importer, specifier);
  if (realPath === null) return null;
  if (cjsTurn.fromLoad && !cjsTurn.hasCachedModuleImporter(importer)) return null;
  const resolved = nextResolve(realPath, context);
  if (!cjsTurn.hasCachedModuleImporter(importer)) return null;
  return joinAdminTree(adminTree, resolved);
}

/**
 * The Admin subpaths no row serves that this process loaded, each once, in
 * load order: the first load prints one line, and the process health lists
 * them. Beside them, the subpaths whose row gates their calls but records
 * none (App Check), which the start line already names.
 */
interface AdminUnobserved {
  note(subpath: string): void;
  list(): readonly string[];
  noteGated(subpath: string): void;
  gated(): readonly string[];
}

/** The Admin rows that gate their calls and record none, by the subpath the health names. */
const GATED_ADMIN_ROWS: ReadonlyMap<string, string> = new Map([['app-check', 'firebase-admin/app-check']]);

/** The line for the first load of an Admin subpath no row serves. */
export function adminUnobservedLine(subpath: string): string {
  return `${LOG_PREFIX}: ${subpath} loads unobserved. Live mode lets it reach Google with your credential, and no row records its calls.`;
}

function createAdminUnobserved(write: (line: string) => void, changed: () => void): AdminUnobserved {
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

/**
 * What a load of the Admin SDK gets from the Admin rows (`adminTreeResolution`):
 * its row module, with the real file it stands for recorded, or null to load
 * as Node resolved it, noting a subpath no row serves as unobserved.
 */
function adminRowResult(rows: RegisterRows, realFiles: AdminRowFiles, unobserved: AdminUnobserved, specifier: string, url: string): ResolveResult | null {
  const served = adminTreeResolution(rows, { specifier, url });
  if (served.kind === 'refused') throw served.error;
  if (served.kind === 'admin-unobserved') unobserved.note(served.subpath);
  if (served.kind !== 'admin-row') return null;
  const gatedSubpath = GATED_ADMIN_ROWS.get(adminRowOfUrl(served.url) ?? '');
  if (gatedSubpath !== undefined) unobserved.noteGated(gatedSubpath);
  if (!realFiles.has(served.url)) realFiles.set(served.url, url);
  return { url: served.url, format: 'commonjs', shortCircuit: true };
}

interface SuppliedResolveEnv {
  readonly rows: RegisterRows;
  readonly allowedUrls: Set<string>;
  readonly adminTree: AdminTree;
  readonly realFiles: AdminRowFiles;
  readonly report: ReturnType<typeof createStopReporter>;
}

function isCachedDirectAdminCaller(
  env: SuppliedResolveEnv,
  importer: string | undefined,
  request: string,
  hasCachedModuleParent: (importerUrl: string) => boolean,
): boolean {
  if (importer === undefined || !hasCachedModuleParent(importer)) return false;
  if (isAdminTreeImporter(env.adminTree, importer)) return true;
  return adminRowRealPath(env.realFiles, importer, request) !== null;
}

function canConsultAdminTree(importer: string, isEsmImport: boolean, cjsTurn: CjsResolveTurn | null): boolean {
  if (isEsmImport || cjsTurn === null) return true;
  if (!cjsTurn.fromLoad) return true;
  return cjsTurn.hasCachedModuleImporter(importer);
}

function hasVerifiedTreeImporter(importer: string, isEsmImport: boolean, cjsTurn: CjsResolveTurn | null): boolean {
  if (isEsmImport) return true;
  if (cjsTurn === null) return false;
  return cjsTurn.hasCachedModuleImporter(importer);
}

/**
 * Guards direct `Module._resolveFilename(id, parent)` calls outside
 * `registerHooks.resolve` (such as `require-in-the-middle`'s pre-load export
 * cache lookup, or `require.resolve` on Node 22.15) so live rows and installed
 * row imports pass while stopped SDKs report and throw `PYRIC_REAL_SDK_STOPPED`.
 */
function createDirectResolveGuard(env: SuppliedResolveEnv): DirectResolveGuard {
  const passThroughPackages = passThroughSdkPackages(env.rows.passThrough);
  return ({ request, resolvedFilename, importerUrl, hasCachedModuleParent }) => {
    if (!isNodeModulesPath(resolvedFilename)) return;
    if (isCachedDirectAdminCaller(env, importerUrl, request, hasCachedModuleParent)) return;
    const resolution = registerRowsResolution(env.rows, {
      specifier: request,
      importer: importerUrl,
      conditions: ['require', 'node'],
    });
    if (resolution.kind === 'refused') throw resolution.error;
    if (resolution.kind === 'module' || resolution.kind === 'installed-sdk') return;
    const isAdminImport = resolution.kind === 'admin-pass-through';
    const isPassThroughImport = resolution.kind === 'pass-through';
    const stop = suppliedRowsStopFor(
      { specifier: request, importer: importerUrl, url: pathToFileURL(resolvedFilename).href },
      env.allowedUrls,
      { isRowImport: false, isEsmImport: false, isPassThroughImport, passThroughPackages, isAdminImport },
    );
    if (stop !== null) {
      env.report(stop);
      throw stop;
    }
  };
}

/**
 * The resolve hook: rows, the installed SDK for a row's own import and for a
 * passed-through one, the real Admin SDK when it passes through, refusals,
 * and the stop. `allowedUrls` is the stop's record of the installed SDK
 * files it let load, and `adminTree` the passed-through Admin SDK's files.
 */
function resolveWithRows(
  env: SuppliedResolveEnv,
  unobserved: AdminUnobserved,
  cjsState: CjsResolveState,
): Resolve {
  const passThroughPackages = passThroughSdkPackages(env.rows.passThrough);
  return (specifier, context, nextResolve) => {
    const isEsmImport = isImportCondition(context.conditions);
    let cjsTurn: CjsResolveTurn | null = null;
    if (!isEsmImport) cjsTurn = cjsState.enterHookResolve();
    try {
      const importer = context.parentURL;
      const rowOwn = resolveAdminRowOwn(env.realFiles, env.adminTree, cjsTurn, specifier, context, nextResolve);
      if (rowOwn !== null) return rowOwn;

      let preResolved: ResolveResult | undefined;
      if (importer !== undefined && env.adminTree.has(importer)) {
        if (canConsultAdminTree(importer, isEsmImport, cjsTurn)) {
          const fromTree = nextResolve(specifier, context);
          if (hasVerifiedTreeImporter(importer, isEsmImport, cjsTurn)) {
            const rowResult = adminRowResult(env.rows, env.realFiles, unobserved, specifier, fromTree.url);
            if (rowResult !== null) return rowResult;
            const stop = suppliedRowsStopFor(
              { specifier, importer, url: fromTree.url },
              env.allowedUrls,
              { isRowImport: false, isEsmImport, isFromAdminTree: true },
            );
            if (stop !== null) throw stop;
            return joinAdminTree(env.adminTree, fromTree);
          }
          preResolved = fromTree;
        }
      }

      const request = { specifier, importer, conditions: context.conditions };
      const resolution = registerRowsResolution(env.rows, request);
      if (resolution.kind === 'refused') throw resolution.error;
      if (resolution.kind === 'module') return { url: resolution.url, format: 'module', shortCircuit: true };
      const isRowImport = resolution.kind === 'installed-sdk';
      const isPassThroughImport = resolution.kind === 'pass-through';
      const isAdminImport = resolution.kind === 'admin-pass-through';
      // A row resolves its own specifier as the app would: from the project root.
      // A passed-through import is the app's own, so it resolves as written.
      let result: ResolveResult;
      if (preResolved !== undefined) {
        result = preResolved;
      } else if (isRowImport) {
        result = nextResolve(specifier, { ...context, parentURL: resolution.projectUrl });
      } else {
        result = nextResolve(specifier, context);
      }
      if (isAdminTreeReload(env.adminTree, specifier, importer, result.url)) return result;
      const load = { specifier, importer, url: result.url };
      const grant = { isRowImport, isEsmImport, isPassThroughImport, passThroughPackages, isAdminImport };
      const stop = suppliedRowsStopFor(load, env.allowedUrls, grant);
      if (stop !== null) {
        if (isAdminPackageMainProbe(specifier, importer, result.url, isEsmImport, cjsTurn, env.adminTree)) {
          return result;
        }
        env.report(stop);
        throw stop;
      }
      // Only the real firebase-admin starts the tree, never an alias that lands elsewhere.
      const isAdminEntry = isAdminImport && packageNameOf(result.url) === 'firebase-admin';
      if (!isAdminEntry) return result;
      // An entry of a service the Admin rows do not serve, when on, loads unobserved (the row loads are never entries).
      adminRowResult(env.rows, env.realFiles, unobserved, specifier, result.url);
      return joinAdminTree(env.adminTree, result);
    } finally {
      cjsTurn?.exit();
    }
  };
}

function isAsyncCommonJsNullSourceError(error: unknown, url: string, context: LoadContext | undefined): boolean {
  if (!url.startsWith('file:')) return false;
  const format = context?.format;
  const canBeCommonJs = format === 'commonjs' || format == null;
  if (!canBeCommonJs) return false;
  if (typeof error !== 'object' || error === null) return false;
  const err = error as { code?: unknown; message?: unknown };
  if (err.code !== 'ERR_INVALID_RETURN_PROPERTY_VALUE') return false;
  const msg = typeof err.message === 'string' ? err.message : '';
  return msg.endsWith('got null.') || msg.endsWith('got undefined.');
}

/**
 * The load hook: serves fixed live and Admin row sources from `@pyric/live`,
 * falling back to `readFileSync` when Node 22.15's `validateLoad` rejects an
 * async `module.register()` hook's `{ format: 'commonjs', source: null }`
 * default step (nodejs/node#57327).
 */
function loadWithRows(rows: RegisterRows): Load {
  return (url, context, nextLoad) => {
    if (isAdminRowUrl(url)) return { format: 'commonjs', source: registerLiveModuleSource(rows, url), shortCircuit: true };
    if (isRegisterLiveModule(url)) return { format: 'module', source: registerLiveModuleSource(rows, url), shortCircuit: true };
    try {
      return nextLoad(url, context);
    } catch (error) {
      if (!isAsyncCommonJsNullSourceError(error, url, context)) throw error;
      return { format: 'commonjs', source: readFileSync(fileURLToPath(canonicalFileUrl(url))), shortCircuit: true };
    }
  };
}

function isRefusedInProduction(): boolean {
  return process.env.NODE_ENV === 'production' && process.env.PYRIC_SANDBOX_FORCE !== '1';
}

/** The live project in `projectRoot`, or null when none is set: the register entry refuses that start itself. */
function projectIdOrNull(projectRoot: string): string | null {
  try {
    return liveProjectId(projectRoot);
  } catch {
    return null;
  }
}

/** The process health's unobserved Admin lists, each absent when empty. */
function unobservedFields(
  admin: AdminUnobserved,
): { unobservedAdmin?: readonly string[]; gatedAdmin?: readonly string[] } {
  const unobservedAdmin = admin.list();
  const gatedAdmin = admin.gated();
  return {
    ...(unobservedAdmin.length === 0 ? {} : { unobservedAdmin }),
    ...(gatedAdmin.length === 0 ? {} : { gatedAdmin }),
  };
}

/**
 * Sends the lists to the live host on the connection observed calls use
 * (`observed-call-sender.ts`), which loads at the first send, so a process
 * that leaves nothing unobserved never loads it for this. From the first
 * send, each re-attach of that connection, as after the live host restarts,
 * calls `reattached`.
 */
function liveHostSender(reattached: () => void): (lists: NodeUnobservedLists) => Promise<void> {
  let watching = false;
  return async (lists) => {
    const sender = await import('./observed-call-sender.js');
    if (!watching) {
      watching = true;
      onReattach(sender.observeLiveHostConnection, reattached);
    }
    await sender.sendUnobservedLists(lists);
  };
}

/**
 * The pass-through list a child process inherits, without `firebase-admin`
 * while its own Admin rows are shut. The first process recorded it, so a Node 22
 * child of a Node 23 or later process would otherwise load the real Admin SDK
 * with no row and no project check; without it, each `firebase-admin` import
 * is refused, as in a Node 22 first process.
 */
function adminPassesWithRows(listed: readonly string[], adminRows: boolean): readonly string[] {
  if (adminRows) return listed;
  return listed.filter((specifier) => specifier !== ADMIN_PASS_THROUGH);
}

/** What the register entry gives the seam. */
export interface SuppliedRowsActivation {
  /**
   * The folder of the `@pyric/live` package calling this seam. The rows open
   * from the `@pyric/live` that resolves from there, before the one the
   * project root resolves, so they open when that package is installed
   * beside the app rather than in it.
   */
  readonly liveRoot?: string;
  /**
   * Served specifiers with no live row that load the app's installed SDK
   * unwrapped and unobserved, as `pyricLive({ passThrough })` lists them
   * (`passThroughSet`). Any other entry throws. Undefined in a child process
   * or worker, which passes through what its first process recorded,
   * except `firebase-admin` while its own Admin rows are shut.
   */
  readonly passThrough?: readonly string[];
  /**
   * Whether a passed-through Admin SDK's class-defining loads go to the Admin
   * rows (`admin-row.ts`). `@pyric/live/register` passes it on Node 23 or
   * later, with `firebase-admin` in `passThrough`.
   */
  readonly adminRows?: boolean;
}

/**
 * Starts the live rows in this thread: the installed `@pyric/live` opens
 * them, then the hooks go in, and every worker thread and child process this
 * process starts loads the installed register, for the same project root and
 * the same pass-through imports.
 * Throws, leaving the process unhooked, when the rows cannot open:
 * `@pyric/live` not installed beside the entry or in the project, Node
 * without `module.registerHooks`, `@pyric/cli/register` already active, or
 * a pass-through entry that cannot pass through.
 */
export async function activateWithSuppliedRows(input: SuppliedRowsActivation = {}): Promise<void> {
  if (isLiveRegisterActive()) return;
  if (isRefusedInProduction()) {
    process.stderr.write(
      `${LOG_PREFIX}: refusing to activate under NODE_ENV=production. Set PYRIC_SANDBOX_FORCE=1 to override (dev only).\n`,
    );
    return;
  }
  const registerHooks = moduleApi.registerHooks;
  if (typeof registerHooks !== 'function') {
    throw new Error(`${LOG_PREFIX}: live mode needs module.registerHooks, in Node 22.15 or later.`);
  }
  if (isRegisterActive()) {
    throw new Error(
      `${LOG_PREFIX}: @pyric/cli/register is already active in this process, so Firebase resolves to the sandbox. ` +
        'Start the process with one of the two.',
    );
  }
  const adminRows = input.adminRows === true;
  const passThrough = passThroughSet(input.passThrough ?? adminPassesWithRows(recordedPassThrough(process.env), adminRows));
  // Each unobserved Admin list is sent to the live host when it first gains an entry and on each change, so the host's health lists them.
  let forwarder: UnobservedForwarder | undefined;
  const changed = (): void => forwarder?.changed();
  // The installed SDK files the stop let load.
  const allowedUrls = new Set<string>();
  // Stays empty unless `firebase-admin` passes through: only an app's own import of it starts the tree.
  const adminTree = createAdminTree();
  const adminUnobserved = createAdminUnobserved((line) => void process.stderr.write(line), changed);
  const send = liveHostSender(() => forwarder?.reconnected());
  forwarder = createUnobservedForwarder({ read: () => unobservedFields(adminUnobserved), send });
  const installed = await loadInstalledLiveRegister(liveProjectRoot(process.env, process.cwd()), input.liveRoot);
  const rows = registerRows(passThrough, adminRows);
  rows.open(installed.rows);
  // Children and workers open the rows for this process's project and its checked firebase, wherever they start.
  process.env[LIVE_PROJECT_ROOT_VARIABLE] = installed.projectRoot;
  process.env[LIVE_SDK_ROOT_VARIABLE] = installed.sdkRoot;
  process.env[LIVE_PASS_THROUGH_VARIABLE] = [...passThrough].join(',');
  installWorkerGuard(installed.entryUrl);
  installChildProcessGuard(installed.entryUrl);
  const report = createStopReporter((line) => void process.stderr.write(line));
  const env: SuppliedResolveEnv = { rows, allowedUrls, adminTree, realFiles: new Map(), report };
  const cjsState = installCjsResolveState({ directResolveGuard: createDirectResolveGuard(env) });
  registerHooks({ resolve: resolveWithRows(env, adminUnobserved, cjsState), load: loadWithRows(rows) });
  // Its servers say this is a live process, so a proxy check can catch a sandbox page in front of it,
  // and list what no row observed.
  let projectId = projectIdOrNull(installed.projectRoot) ?? undefined;
  installProcessHealth(() => ({
    mode: 'live',
    projectId: (projectId ??= projectIdOrNull(installed.projectRoot) ?? undefined),
    ...unobservedFields(adminUnobserved),
  }));
  markLiveRegisterActive();
}
