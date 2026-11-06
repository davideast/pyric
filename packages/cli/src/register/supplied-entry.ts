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
 * mode on. It installs live mode's network guard first (`live-net-guard.ts`),
 * so only the live rows' SDK, and the SDK of each passed-through import,
 * reaches Google from the process. When `firebase-admin` passes through, the
 * real Admin SDK loads with the app's own credential, which pyric never
 * reads, and the guard admits its Google traffic only from the files its
 * import reached.
 */
import Module from 'node:module';
import { fileURLToPath } from 'node:url';
import { packageNameOf } from './package-identity.js';
import { isLiveRegisterActive, isRegisterActive, markLiveRegisterActive } from './activation.js';
import { installChildProcessGuard } from './child-process-guard.js';
import {
  LIVE_PASS_THROUGH_VARIABLE,
  LIVE_PROJECT_ROOT_VARIABLE,
  LIVE_SDK_ROOT_VARIABLE,
  liveProjectRoot,
  loadInstalledLiveRegister,
  recordedPassThrough,
} from './live-package.js';
import { passThroughSdkPackages, passThroughSet } from '../serve/vite-supplied-rows.js';
import { createStopReporter, suppliedRowsStopFor } from './swap-or-stop.js';
import { installLiveNetGuard } from './live-net-guard.js';
import { isRegisterLiveModule } from './live-row.js';
import {
  isImportCondition,
  registerLiveModuleSource,
  registerRows,
  registerRowsResolution,
  type RegisterRows,
} from './supplied-rows.js';
import { installWorkerGuard } from './worker-guard.js';

export { REGISTER_OBSERVER_URL, REGISTER_ROW_URLS } from './live-row.js';
export { reachLiveHost, type LiveHostReach } from './live-host-reach.js';
export { liveProjectId } from '../serve/live-project.js';
export { LIVE_PROJECT_ROOT_VARIABLE, liveAppDirs, liveProjectRoot } from './live-package.js';
export { livePassThroughLine } from 'pyric/sandbox/internal';
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

interface LoadResult {
  format?: string | null;
  source?: string;
  shortCircuit?: boolean;
}
type NextLoad = (url: string, context?: unknown) => LoadResult;
type Load = (url: string, context: unknown, nextLoad: NextLoad) => LoadResult;

const moduleApi = Module as unknown as {
  registerHooks?: (hooks: { resolve: Resolve; load: Load }) => void;
};

const LOG_PREFIX = '@pyric/live/register';

/**
 * The files of the passed-through Admin SDK's tree: the entry an app's own
 * `firebase-admin` import resolved to, and every file a file of the tree
 * resolved, directly or not. Built-ins (`node:*`) are not files, so they
 * never join.
 */
interface AdminTree {
  has(url: string): boolean;
  add(url: string): void;
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

/**
 * The resolve hook: rows, the installed SDK for a row's own import and for a
 * passed-through one, the real Admin SDK when it passes through, refusals,
 * and the stop. `allowedUrls` is the stop's record of the installed SDK
 * files it let load, and `adminTree` the passed-through Admin SDK's files;
 * the network guard reads both.
 */
function resolveWithRows(rows: RegisterRows, allowedUrls: Set<string>, adminTree: AdminTree): Resolve {
  const report = createStopReporter((line) => void process.stderr.write(line));
  const passThroughPackages = passThroughSdkPackages(rows.passThrough);
  return (specifier, context, nextResolve) => {
    const importer = context.parentURL;
    // The Admin SDK's own files load whatever it needs, as Node resolves it, and the stop lets it (`isFromAdminTree`).
    if (isAdminTreeImporter(adminTree, importer)) {
      const fromTree = nextResolve(specifier, context);
      const stop = suppliedRowsStopFor({ specifier, importer, url: fromTree.url }, allowedUrls, { isRowImport: false, isEsmImport: false, isFromAdminTree: true });
      if (stop !== null) throw stop;
      return joinAdminTree(adminTree, fromTree);
    }
    const request = { specifier, importer, conditions: context.conditions };
    const resolution = registerRowsResolution(rows, request);
    if (resolution.kind === 'refused') throw resolution.error;
    if (resolution.kind === 'module') return { url: resolution.url, format: 'module', shortCircuit: true };
    const isRowImport = resolution.kind === 'installed-sdk';
    const isPassThroughImport = resolution.kind === 'pass-through';
    const isAdminImport = resolution.kind === 'admin-pass-through';
    // A row resolves its own specifier as the app would: from the project root.
    // A passed-through import is the app's own, so it resolves as written.
    const result = isRowImport
      ? nextResolve(specifier, { ...context, parentURL: resolution.projectUrl })
      : nextResolve(specifier, context);
    if (isAdminTreeReload(adminTree, specifier, importer, result.url)) return result;
    const isEsmImport = isImportCondition(context.conditions);
    const load = { specifier, importer, url: result.url };
    const grant = { isRowImport, isEsmImport, isPassThroughImport, passThroughPackages, isAdminImport };
    const stop = suppliedRowsStopFor(load, allowedUrls, grant);
    if (stop !== null) {
      report(stop);
      throw stop;
    }
    // Only the real firebase-admin starts the tree, never an alias that lands elsewhere.
    const isAdminEntry = isAdminImport && packageNameOf(result.url) === 'firebase-admin';
    return isAdminEntry ? joinAdminTree(adminTree, result) : result;
  };
}

/** The load hook: a fixed live module's source, from the installed `@pyric/live`. */
function loadWithRows(rows: RegisterRows): Load {
  return (url, context, nextLoad) => {
    const isLiveModule = isRegisterLiveModule(url);
    if (!isLiveModule) return nextLoad(url, context);
    return { format: 'module', source: registerLiveModuleSource(rows, url), shortCircuit: true };
  };
}

function isRefusedInProduction(): boolean {
  return process.env.NODE_ENV === 'production' && process.env.PYRIC_SANDBOX_FORCE !== '1';
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
   * or worker, which passes through what its first process recorded.
   */
  readonly passThrough?: readonly string[];
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
  const passThrough = passThroughSet(input.passThrough ?? recordedPassThrough(process.env));
  // First, before any hook: the network guard (`live-net-guard.ts`). A fetch
  // to Google passes only from a file of the installed SDK the stop let load.
  const allowedUrls = new Set<string>();
  // Stays empty unless `firebase-admin` passes through: only an app's own import of it starts the tree.
  const adminTree = new Set<string>();
  installLiveNetGuard({ isLiveSdkFile: (url) => allowedUrls.has(url), isAdminSdkFile: (url) => adminTree.has(url), passThrough });
  const installed = await loadInstalledLiveRegister(liveProjectRoot(process.env, process.cwd()), input.liveRoot);
  const rows = registerRows(passThrough);
  rows.open(installed.rows);
  // Children and workers open the rows for this process's project and its checked firebase, wherever they start.
  process.env[LIVE_PROJECT_ROOT_VARIABLE] = installed.projectRoot;
  process.env[LIVE_SDK_ROOT_VARIABLE] = installed.sdkRoot;
  process.env[LIVE_PASS_THROUGH_VARIABLE] = [...passThrough].join(',');
  installWorkerGuard(installed.entryUrl);
  installChildProcessGuard(installed.entryUrl);
  registerHooks({ resolve: resolveWithRows(rows, allowedUrls, adminTree), load: loadWithRows(rows) });
  markLiveRegisterActive();
}
