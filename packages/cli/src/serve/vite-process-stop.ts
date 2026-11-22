/**
 * Swap or stop in the Vite dev server process (ADR 0022).
 *
 * The plugin swaps `firebase/*` for the browser and routes the served
 * subpaths and `firebase-admin/*` in the server-rendered modules Vite
 * processes (`vite-ssr-routing.ts`). Vite leaves some loads to Node itself:
 * an installed package it externalizes that imports `firebase-admin` or
 * `firebase`, or an unserved `firebase/*` subpath in a server module. Under
 * `pyric sandbox -- vite dev` the register's resolve hook stops those. Under
 * plain `vite dev` there is no register, so the plugin acquires a scoped
 * lease on a single sync resolve hook in its process: while a server is open,
 * the active lease throws `PYRIC_REAL_SDK_STOPPED` (for `pyric()`) or
 * `PYRIC_LIVE_REFUSED` (for `@pyric/live/vite`), and releasing the lease on
 * `server.close()` leaves subsequent Node resolutions untouched.
 */
import Module from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isMainThread } from 'node:worker_threads';
import { UNSUPPORTED_RUNTIME_CODE } from '../cli/unsupported-runtime.js';
import { isLiveRegisterActive, isRegisterActive } from '../register/activation.js';
import { canonicalFirebaseSpecifier } from '../register/mapping.js';
import { requireRegisterHooks } from '../register/node-version-stop.js';
import {
  createStopReporter,
  isImportCondition,
  isUnservedFirebaseImport,
  stopFor,
  suppliedRowsStopFor,
  unservedFirebaseSubpathStop,
} from '../register/swap-or-stop.js';
import { isBypassedBridgeImport, type AiMode } from './firebase-module-swap.js';
import { installSyncWorkerViteSsrActivationIfActive } from './vite-ssr-worker-activation.js';
import { suppliedRows, type SuppliedRows } from './vite-supplied-rows.js';
import {
  installViteWorkerGuard,
  readViteWorkerStopEnv,
  restoreSharedViteWorkerEnv,
  type ActiveViteStopConfig,
} from './vite-worker-stop.js';

interface SyncResolveContext {
  parentURL?: string;
  conditions?: string[];
}

interface SyncResolveResult {
  url: string;
  format?: string | null;
  shortCircuit?: boolean;
}

/** Node's sync resolve hook (`module.registerHooks`, Node 22.15 and later). */
export type SyncResolve = (
  specifier: string,
  context: SyncResolveContext,
  nextResolve: (specifier: string, context?: SyncResolveContext) => SyncResolveResult,
) => SyncResolveResult;

type RegisterHooks = (hooks: { resolve: SyncResolve }) => void;

/** Typed locally: the repo's ambient Node types predate `registerHooks`. */
const moduleApi = Module as unknown as { registerHooks?: RegisterHooks };

interface SandboxStopLease {
  readonly kind: 'sandbox';
  getAiMode: () => AiMode;
  readonly projectRoot?: string;
  readonly report: ReturnType<typeof createStopReporter>;
  readonly allowedUrls: Set<string>;
}

interface LiveStopLease {
  readonly kind: 'live';
  readonly supplied: SuppliedRows;
  readonly report: ReturnType<typeof createStopReporter>;
}

type ProcessStopLease = SandboxStopLease | LiveStopLease;

interface StopState {
  readonly leases: ProcessStopLease[];
  readonly sharedEnvBackup: Map<string, string | undefined>;
  workerGuardInstalled: boolean;
}

/** Holds the installed hook's state, once per process. */
const VITE_PROCESS_STOP = Symbol.for('pyric.viteProcessStop');

export interface ViteProcessStopHookInput {
  /** The plugin's resolved AI mode, read on each resolve. */
  getAiMode: () => AiMode;
  write: (line: string) => void;
  /** Vite's resolved app root so bypassed SSR bridge imports prefer the app's Firebase SDK. */
  projectRoot?: string;
}

function resolveSandboxNodeLoad(
  lease: SandboxStopLease,
  specifier: string,
  context: SyncResolveContext,
  nextResolve: (specifier: string, context?: SyncResolveContext) => SyncResolveResult,
): SyncResolveResult {
  const aiMode = lease.getAiMode();
  const isEsm = context.conditions === undefined || isImportCondition(context.conditions);
  const isClientBridgeBypass =
    isEsm &&
    (specifier === 'firebase/app' || specifier === 'firebase/app-check') &&
    isBypassedBridgeImport(specifier, context.parentURL, aiMode);
  const isProductionFirebaseAi = isEsm && aiMode === 'production' && specifier === 'firebase/ai';
  const prefersProjectRoot = isClientBridgeBypass || isProductionFirebaseAi;
  if (prefersProjectRoot && lease.projectRoot !== undefined && lease.projectRoot !== '') {
    const rootParentUrl = pathToFileURL(path.join(path.resolve(lease.projectRoot), 'package.json')).href;
    const rootContext: SyncResolveContext = { parentURL: rootParentUrl };
    if (context.conditions !== undefined) {
      rootContext.conditions = context.conditions;
    }
    try {
      return nextResolve(specifier, rootContext);
    } catch {
      // Fall back to the bridge module's parentURL when not installed under projectRoot.
    }
  }
  return nextResolve(specifier, context);
}

function errorCodeOf(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err && typeof err.code === 'string') {
    return err.code;
  }
  return undefined;
}

function isMissingResolutionCode(code: string | undefined): boolean {
  return (
    code === 'ERR_MODULE_NOT_FOUND' ||
    code === 'MODULE_NOT_FOUND' ||
    code === 'ERR_PACKAGE_PATH_NOT_EXPORTED'
  );
}

function resolveAndEvaluateSandboxLease(
  lease: SandboxStopLease,
  specifier: string,
  context: SyncResolveContext,
  nextResolve: (specifier: string, context?: SyncResolveContext) => SyncResolveResult,
): SyncResolveResult {
  const importer = context.parentURL;
  const isEsmImport = context.conditions === undefined || isImportCondition(context.conditions);
  const canonical = canonicalFirebaseSpecifier(specifier);
  const effectiveSpecifier = canonical ?? specifier;
  let result: SyncResolveResult;
  try {
    result = resolveSandboxNodeLoad(lease, specifier, context, nextResolve);
  } catch (err) {
    if (isMissingResolutionCode(errorCodeOf(err)) && isUnservedFirebaseImport(effectiveSpecifier)) {
      const unservedStop = unservedFirebaseSubpathStop(specifier, importer, effectiveSpecifier);
      lease.report(unservedStop);
      throw unservedStop;
    }
    throw err;
  }
  return evaluateSandboxLease(lease, specifier, importer, isEsmImport, result);
}

function evaluateSandboxLease(
  lease: SandboxStopLease,
  specifier: string,
  importer: string | undefined,
  isEsmImport: boolean,
  result: SyncResolveResult,
): SyncResolveResult {
  const aiMode = lease.getAiMode();
  const stop = stopFor(
    {
      specifier,
      canonical: canonicalFirebaseSpecifier(specifier),
      importer,
      url: result.url,
      aiMode,
      isEsmImport,
    },
    lease.allowedUrls,
  );
  if (stop === null) return result;
  lease.report(stop);
  throw stop;
}

function evaluateLiveLease(
  lease: LiveStopLease,
  specifier: string,
  importer: string | undefined,
  result: SyncResolveResult,
): SyncResolveResult {
  const stopped = suppliedRowsStopFor(
    {
      specifier,
      canonical: canonicalFirebaseSpecifier(specifier),
      importer,
      url: result.url,
    },
    new Set(),
    { isRowImport: false, isEsmImport: false },
  );
  if (stopped === null) return result;
  const refusal = lease.supplied.refusal(specifier, 'server');
  lease.report(Object.assign(new Error(refusal.message), { url: result.url, specifier }));
  throw refusal;
}

/**
 * The hook: resolve as Node would, then stop a load of the real SDK that the
 * swap doesn't choose. Each stop is written once per file, so a caught
 * import still shows in the dev server log.
 */
export function viteProcessStopHook(input: ViteProcessStopHookInput): SyncResolve {
  const lease: SandboxStopLease = {
    kind: 'sandbox',
    getAiMode: input.getAiMode,
    projectRoot: input.projectRoot,
    report: createStopReporter(input.write),
    allowedUrls: new Set<string>(),
  };
  return (specifier, context, nextResolve) =>
    resolveAndEvaluateSandboxLease(lease, specifier, context, nextResolve);
}

export interface ViteProcessStopInput {
  getAiMode?: () => AiMode;
  projectRoot?: string;
  write?: (line: string) => void;
  /** Where the installed hook's state is kept. Defaults to `globalThis`. */
  slot?: Record<symbol, unknown>;
  /** Defaults to `module.registerHooks`; undefined on a Node without it. */
  registerHooks?: RegisterHooks;
  /** Defaults to the register's activation mark. */
  registerActive?: () => boolean;
  /** Defaults to `process.versions.node`. */
  nodeVersion?: string;
  /** Optional `node:worker_threads` stand-in for unit tests. */
  workerThreads?: { Worker: unknown };
  /** Override the preload module URL injected into spawned workers (for tests). */
  workerPreloadUrl?: string;
}

export interface ViteLiveProcessStopInput {
  write?: (line: string) => void;
  slot?: Record<symbol, unknown>;
  registerHooks?: RegisterHooks;
  registerActive?: () => boolean;
  nodeVersion?: string;
  workerThreads?: { Worker: unknown };
  workerPreloadUrl?: string;
}

const BUN_TEST_ENTRYPOINT = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

function isInProcessBunTestRunner(): boolean {
  const bunGlobal = (globalThis as { Bun?: { main?: unknown } }).Bun;
  return typeof bunGlobal?.main === 'string' && BUN_TEST_ENTRYPOINT.test(bunGlobal.main);
}

function createViteBunUnsupportedError(surface: 'sandbox' | 'live', bunVersion: string): Error & { code: string } {
  const label = surface === 'live' ? '@pyric/live/vite' : 'pyric() Vite plugin';
  let detail =
    '  Without synchronous module.registerHooks, externalized server imports of firebase and firebase-admin cannot be swapped or stopped and would reach live Firebase.\n';
  if (surface === 'live') {
    detail =
      '  Without synchronous module.registerHooks, externalized server imports of firebase and firebase-admin cannot be refused in live mode.\n';
  }
  const message =
    `${label}: Bun ${bunVersion} does not run Node module.registerHooks [${UNSUPPORTED_RUNTIME_CODE}].\n` +
    detail +
    '  Run Vite under Node >= 22.15 (for example `npx vite dev`).\n' +
    `  code: ${UNSUPPORTED_RUNTIME_CODE}`;
  const error = new Error(message) as Error & { code: string };
  error.code = UNSUPPORTED_RUNTIME_CODE;
  return error;
}

function resolveHooksCallback(input: ViteLiveProcessStopInput): RegisterHooks | undefined {
  if ('registerHooks' in input) return input.registerHooks;
  if (moduleApi.registerHooks === undefined) return undefined;
  return moduleApi.registerHooks.bind(Module);
}

function isAnyRegisterActive(): boolean {
  return isRegisterActive() || isLiveRegisterActive();
}

/**
 * Validate upfront during `config()` that the host runtime supports synchronous
 * `module.registerHooks`, without acquiring an active server lease yet.
 */
export function validateViteProcessStopRuntime(
  surface: 'sandbox' | 'live',
  input: ViteLiveProcessStopInput = {},
): void {
  const defaultRegisterCheck = surface === 'live' ? isAnyRegisterActive : isRegisterActive;
  const registerActive = input.registerActive ?? defaultRegisterCheck;
  if (registerActive()) return;
  const write = input.write ?? ((line) => void process.stderr.write(line));
  const hasExplicitHooks = 'registerHooks' in input;
  if (!hasExplicitHooks && typeof process.versions.bun === 'string') {
    if (isInProcessBunTestRunner()) return;
    const error = createViteBunUnsupportedError(surface, process.versions.bun);
    write(`${error.message}\n`);
    throw error;
  }
  const label = surface === 'live' ? '@pyric/live/vite' : 'pyric() Vite plugin';
  requireRegisterHooks(resolveHooksCallback(input), label, input.nodeVersion ?? process.versions.node, write);
}

function activeStopConfig(
  state: StopState,
  registerActiveCheck: () => boolean,
): ActiveViteStopConfig | null {
  const active = state.leases.at(-1);
  if (active === undefined) return null;
  if (registerActiveCheck()) return null;
  if (active.kind === 'live') {
    if (isLiveRegisterActive()) return null;
    return { kind: 'live' };
  }
  return {
    kind: 'sandbox',
    aiMode: active.getAiMode(),
    projectRoot: active.projectRoot,
  };
}

function ensureWorkerGuard(
  state: StopState,
  input: ViteLiveProcessStopInput,
  registerActiveCheck: () => boolean,
): void {
  if (state.workerGuardInstalled) return;
  const shouldGuardWorkers = 'workerThreads' in input || input.slot === undefined;
  if (!shouldGuardWorkers) return;
  state.workerGuardInstalled = true;
  installViteWorkerGuard({
    preloadUrl: input.workerPreloadUrl ?? import.meta.url,
    getActiveConfig: () => activeStopConfig(state, registerActiveCheck),
    sharedEnvBackup: state.sharedEnvBackup,
    workerThreads: input.workerThreads,
  });
}

function ensureProcessStopState(
  surface: 'sandbox' | 'live',
  input: ViteLiveProcessStopInput,
  registerActiveCheck: () => boolean,
): StopState | null {
  if (registerActiveCheck()) return null;
  const slot = input.slot ?? (globalThis as unknown as Record<symbol, unknown>);
  const write = input.write ?? ((line) => void process.stderr.write(line));
  const hasExplicitHooks = 'registerHooks' in input;
  if (!hasExplicitHooks && typeof process.versions.bun === 'string') {
    if (isInProcessBunTestRunner()) return null;
    const error = createViteBunUnsupportedError(surface, process.versions.bun);
    write(`${error.message}\n`);
    throw error;
  }
  const existing = slot[VITE_PROCESS_STOP] as StopState | undefined;
  if (existing !== undefined) {
    ensureWorkerGuard(existing, input, registerActiveCheck);
    return existing;
  }
  const label = surface === 'live' ? '@pyric/live/vite' : 'pyric() Vite plugin';
  const registerHooks = requireRegisterHooks(
    resolveHooksCallback(input),
    label,
    input.nodeVersion ?? process.versions.node,
    write,
  );
  const state: StopState = {
    leases: [],
    sharedEnvBackup: new Map<string, string | undefined>(),
    workerGuardInstalled: false,
  };
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (registerActiveCheck()) return nextResolve(specifier, context);
      const active = state.leases.at(-1);
      if (active === undefined) return nextResolve(specifier, context);
      if (active.kind === 'live') {
        const importer = context.parentURL;
        const liveResult = nextResolve(specifier, context);
        if (isLiveRegisterActive()) return liveResult;
        return evaluateLiveLease(active, specifier, importer, liveResult);
      }
      return resolveAndEvaluateSandboxLease(active, specifier, context, nextResolve);
    },
  });
  ensureWorkerGuard(state, input, registerActiveCheck);
  slot[VITE_PROCESS_STOP] = state;
  return state;
}

function pushLease(state: StopState, lease: ProcessStopLease): () => void {
  state.leases.push(lease);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const index = state.leases.lastIndexOf(lease);
    if (index !== -1) state.leases.splice(index, 1);
    if (state.leases.length === 0) {
      restoreSharedViteWorkerEnv(state.sharedEnvBackup, process.env);
    }
  };
}

/**
 * Acquire a scoped sandbox process-stop lease for one Vite dev server instance.
 * Calling the returned callback releases only this server's lease.
 */
export function acquireViteProcessStop(input: ViteProcessStopInput = {}): () => void {
  const registerActive = input.registerActive ?? isRegisterActive;
  const state = ensureProcessStopState('sandbox', input, registerActive);
  if (state === null) return () => {};
  const write = input.write ?? ((line) => void process.stderr.write(line));
  let getAiMode: () => AiMode = () => 'sandbox';
  if (input.getAiMode !== undefined) {
    getAiMode = input.getAiMode;
  }
  const lease: SandboxStopLease = {
    kind: 'sandbox',
    getAiMode,
    projectRoot: input.projectRoot,
    report: createStopReporter(write),
    allowedUrls: new Set<string>(),
  };
  return pushLease(state, lease);
}

/**
 * Acquire a scoped live process-stop lease for one `@pyric/live/vite` server instance.
 * Calling the returned callback releases only this server's lease.
 */
export function acquireViteLiveProcessStop(
  supplied: SuppliedRows,
  input: ViteLiveProcessStopInput = {},
): () => void {
  const registerActive = input.registerActive ?? (() => isRegisterActive() || isLiveRegisterActive());
  const state = ensureProcessStopState('live', input, registerActive);
  if (state === null) return () => {};
  const write = input.write ?? ((line) => void process.stderr.write(line));
  const lease: LiveStopLease = {
    kind: 'live',
    supplied,
    report: createStopReporter(write),
  };
  return pushLease(state, lease);
}

const VITE_WORKER_STOP_PRELOAD_INSTALLED = Symbol.for('pyric.viteWorkerStopPreloadInstalled');

function workerLiveRefusal(specifier: string): Error {
  const error = new Error(
    `pyric: ${specifier} is refused on the server in live mode, because @pyric/live/vite stops direct Firebase SDK imports in the Vite dev server process and its worker threads.`,
  );
  return Object.assign(error, { code: 'PYRIC_LIVE_REFUSED' });
}

/**
 * Auto-activate the Vite process-stop hook when preloaded inside a
 * `worker_threads.Worker` spawned under an active standalone Vite lease.
 */
function activateViteWorkerProcessStopIfNeeded(): void {
  if (isMainThread) return;
  const g = globalThis as Record<symbol, unknown>;
  if (g[VITE_WORKER_STOP_PRELOAD_INSTALLED] === true) return;
  const config = readViteWorkerStopEnv(process.env);
  if (config === null) return;
  g[VITE_WORKER_STOP_PRELOAD_INSTALLED] = true;
  if (config.kind === 'live') {
    acquireViteLiveProcessStop(suppliedRows((specifier) => workerLiveRefusal(specifier)));
    return;
  }
  installSyncWorkerViteSsrActivationIfActive(process.env);
  acquireViteProcessStop({
    getAiMode: () => config.aiMode,
    projectRoot: config.projectRoot,
  });
}

activateViteWorkerProcessStopIfNeeded();
