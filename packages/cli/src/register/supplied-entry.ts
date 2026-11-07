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
 * mode on. It installs live mode's network report first (`live-net-guard.ts`),
 * which never refuses a call and names each Google host no live row observes
 * (ADR 0022, amendment 2026-11-07). When `firebase-admin` passes through, the
 * real Admin SDK loads with the app's own credential, which pyric never
 * reads, its class-defining loads go to the Admin rows when they are open,
 * and a service no row serves loads unobserved.
 */
import Module from 'node:module';
import { fileURLToPath } from 'node:url';
import { packageNameOf } from './package-identity.js';
import { liveProjectId } from '../serve/live-project.js';
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
import { ADMIN_ROW_LOADS, adminRowOfUrl, isAdminRowUrl } from './admin-row.js';
import {
  adminTreeResolution,
  isImportCondition,
  registerLiveModuleSource,
  registerRows,
  registerRowsResolution,
  type RegisterRows,
} from './supplied-rows.js';
import { installWorkerGuard } from './worker-guard.js';
import { installProcessHealth } from './process-health.js';
import { createUnobservedForwarder, type UnobservedForwarder } from './unobserved-forward.js';
import type { NodeUnobservedLists } from 'pyric/sandbox/internal';

export { REGISTER_OBSERVER_URL, REGISTER_ROW_URLS } from './live-row.js';
export { ADMIN_ROW_LOADS, ADMIN_ROW_URLS, adminRowOfUrl, type AdminRowName } from './admin-row.js';
export { reachLiveHost, type LiveHostReach } from './live-host-reach.js';
export { liveProjectId } from '../serve/live-project.js';
export { LIVE_PROJECT_ROOT_VARIABLE, liveAppDirs, liveProjectRoot } from './live-package.js';
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
 * The real file behind each Admin row: where the Admin SDK's own load of it
 * first resolved. A `require()` resolves from its calling module, not from a
 * `parentURL` a hook passes on, so the row's own require is answered with
 * this file's path.
 */
type AdminRowFiles = Map<string, string>;

/**
 * The real module behind an Admin row: the row's own require of its load's
 * specifier gets the file the Admin SDK's load resolved to, which joins the
 * tree. Null for any other import from a row id.
 */
function resolveAdminRowOwn(
  realFiles: AdminRowFiles,
  adminTree: AdminTree,
  specifier: string,
  context: ResolveContext,
  nextResolve: NextResolve,
): ResolveResult | null {
  const importer = context.parentURL;
  const row = adminRowOfUrl(importer);
  const realFile = importer === undefined ? undefined : realFiles.get(importer);
  const isOwnLoad = row !== null && realFile !== undefined && ADMIN_ROW_LOADS.get(row)?.specifier === specifier;
  if (!isOwnLoad) return null;
  return joinAdminTree(adminTree, nextResolve(fileURLToPath(realFile), context));
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

/**
 * The resolve hook: rows, the installed SDK for a row's own import and for a
 * passed-through one, the real Admin SDK when it passes through, refusals,
 * and the stop. `allowedUrls` is the stop's record of the installed SDK
 * files it let load, and `adminTree` the passed-through Admin SDK's files;
 * the network guard reads both.
 */
function resolveWithRows(rows: RegisterRows, allowedUrls: Set<string>, adminTree: AdminTree, unobserved: AdminUnobserved): Resolve {
  const report = createStopReporter((line) => void process.stderr.write(line));
  const passThroughPackages = passThroughSdkPackages(rows.passThrough);
  const realFiles: AdminRowFiles = new Map();
  return (specifier, context, nextResolve) => {
    const importer = context.parentURL;
    const rowOwn = resolveAdminRowOwn(realFiles, adminTree, specifier, context, nextResolve);
    if (rowOwn !== null) return rowOwn;
    // The Admin SDK's own files load whatever it needs, as Node resolves it, and the stop lets it (`isFromAdminTree`),
    // except where the Admin rows, when on, serve a row or note a service no row serves.
    if (isAdminTreeImporter(adminTree, importer)) {
      const fromTree = nextResolve(specifier, context);
      const rowResult = adminRowResult(rows, realFiles, unobserved, specifier, fromTree.url);
      if (rowResult !== null) return rowResult;
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
    if (!isAdminEntry) return result;
    // An entry of a service the Admin rows do not serve, when on, loads unobserved (the row loads are never entries).
    adminRowResult(rows, realFiles, unobserved, specifier, result.url);
    return joinAdminTree(adminTree, result);
  };
}

/** The load hook: a fixed live module's source, from the installed `@pyric/live`. Admin rows are CommonJS, as the Admin SDK is. */
function loadWithRows(rows: RegisterRows): Load {
  return (url, context, nextLoad) => {
    if (isAdminRowUrl(url)) return { format: 'commonjs', source: registerLiveModuleSource(rows, url), shortCircuit: true };
    const isLiveModule = isRegisterLiveModule(url);
    if (!isLiveModule) return nextLoad(url, context);
    return { format: 'module', source: registerLiveModuleSource(rows, url), shortCircuit: true };
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

/** The process health's unobserved lists, each absent when empty. */
function unobservedFields(
  hosts: readonly string[],
  admin: AdminUnobserved,
): { unobserved?: readonly string[]; unobservedAdmin?: readonly string[]; gatedAdmin?: readonly string[] } {
  const unobservedAdmin = admin.list();
  const gatedAdmin = admin.gated();
  return {
    ...(hosts.length === 0 ? {} : { unobserved: hosts }),
    ...(unobservedAdmin.length === 0 ? {} : { unobservedAdmin }),
    ...(gatedAdmin.length === 0 ? {} : { gatedAdmin }),
  };
}

/**
 * Sends the lists to the live host on the connection observed calls use
 * (`observed-call-sender.ts`), which loads at the first send, so a process
 * that leaves nothing unobserved never loads it for this.
 */
async function sendToLiveHost(lists: NodeUnobservedLists): Promise<void> {
  const { sendUnobservedLists } = await import('./observed-call-sender.js');
  await sendUnobservedLists(lists);
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
  const passThrough = passThroughSet(input.passThrough ?? recordedPassThrough(process.env));
  const adminRows = input.adminRows === true;
  // First, before any hook: the network report (`live-net-guard.ts`). It never
  // refuses a call, and names each Google host no live row observes.
  // Each list sent to the live host when it first gains an entry and on each change, so the host's health lists them.
  let forwarder: UnobservedForwarder | undefined;
  const changed = (): void => forwarder?.changed();
  const network = installLiveNetGuard({ adminRows, onUnobserved: changed });
  // The installed SDK files the stop let load.
  const allowedUrls = new Set<string>();
  // Stays empty unless `firebase-admin` passes through: only an app's own import of it starts the tree.
  const adminTree = new Set<string>();
  const adminUnobserved = createAdminUnobserved((line) => void process.stderr.write(line), changed);
  forwarder = createUnobservedForwarder({ read: () => unobservedFields(network.unobserved(), adminUnobserved), send: sendToLiveHost });
  const installed = await loadInstalledLiveRegister(liveProjectRoot(process.env, process.cwd()), input.liveRoot);
  const rows = registerRows(passThrough, adminRows);
  rows.open(installed.rows);
  // Children and workers open the rows for this process's project and its checked firebase, wherever they start.
  process.env[LIVE_PROJECT_ROOT_VARIABLE] = installed.projectRoot;
  process.env[LIVE_SDK_ROOT_VARIABLE] = installed.sdkRoot;
  process.env[LIVE_PASS_THROUGH_VARIABLE] = [...passThrough].join(',');
  installWorkerGuard(installed.entryUrl);
  installChildProcessGuard(installed.entryUrl);
  registerHooks({ resolve: resolveWithRows(rows, allowedUrls, adminTree, adminUnobserved), load: loadWithRows(rows) });
  // Its servers say this is a live process, so a proxy check can catch a sandbox page in front of it,
  // and list what no row observed.
  const projectId = projectIdOrNull(installed.projectRoot) ?? undefined;
  installProcessHealth(() => ({ mode: 'live', projectId, ...unobservedFields(network.unobserved(), adminUnobserved) }));
  markLiveRegisterActive();
}
