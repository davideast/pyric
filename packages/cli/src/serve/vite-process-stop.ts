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
import { UNSUPPORTED_RUNTIME_CODE } from '../cli/unsupported-runtime.js';
import { isLiveRegisterActive, isRegisterActive } from '../register/activation.js';
import { canonicalFirebaseSpecifier } from '../register/mapping.js';
import { requireRegisterHooks } from '../register/node-version-stop.js';
import { packageNameOf } from '../register/package-identity.js';
import { createStopReporter, stopFor, suppliedRowsStopFor } from '../register/swap-or-stop.js';
import type { AiMode } from './firebase-module-swap.js';
import type { SuppliedRows } from './vite-supplied-rows.js';

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
}

/** Holds the installed hook's state, once per process. */
const VITE_PROCESS_STOP = Symbol.for('pyric.viteProcessStop');

export interface ViteProcessStopHookInput {
  /** The plugin's resolved AI mode, read on each resolve. */
  getAiMode: () => AiMode;
  write: (line: string) => void;
}

/** The package the real `firebase/ai` entry re-exports. */
const FIREBASE_AI_PACKAGE = '@firebase/ai';

/**
 * Whether this is Vite importing the real `firebase/ai` entry's own package
 * in production AI mode. The plugin hands that entry to Vite, which runs it
 * in its module runner and imports its `@firebase/ai` natively, by file URL
 * from a file of the `vite` package, so `stopFor` sees Vite as the importer.
 * Only `@firebase/ai`, only in production AI mode, and only from Vite: the
 * runner's other `@firebase/*` loads, and an app file's own `@firebase/ai`,
 * still stop. `@firebase/ai`'s own imports pass as the imports of an allowed
 * SDK file.
 */
function isViteFirebaseAiLoad(url: string, importer: string | undefined, aiMode: AiMode): boolean {
  const isProductionMode = aiMode === 'production';
  const isFromVite = importer !== undefined && packageNameOf(importer) === 'vite';
  if (!isProductionMode || !isFromVite) return false;
  return packageNameOf(url) === FIREBASE_AI_PACKAGE;
}

function evaluateSandboxLease(
  lease: SandboxStopLease,
  specifier: string,
  context: SyncResolveContext,
  result: SyncResolveResult,
): SyncResolveResult {
  const aiMode = lease.getAiMode();
  const stop = stopFor(
    {
      specifier,
      canonical: canonicalFirebaseSpecifier(specifier),
      importer: context.parentURL,
      url: result.url,
      aiMode,
    },
    lease.allowedUrls,
  );
  if (stop === null) return result;
  if (isViteFirebaseAiLoad(result.url, context.parentURL, aiMode)) {
    lease.allowedUrls.add(result.url);
    return result;
  }
  lease.report(stop);
  throw stop;
}

function evaluateLiveLease(
  lease: LiveStopLease,
  specifier: string,
  context: SyncResolveContext,
  result: SyncResolveResult,
): SyncResolveResult {
  const stopped = suppliedRowsStopFor(
    {
      specifier,
      canonical: canonicalFirebaseSpecifier(specifier),
      importer: context.parentURL,
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
    report: createStopReporter(input.write),
    allowedUrls: new Set<string>(),
  };
  return (specifier, context, nextResolve) => {
    const result = nextResolve(specifier, context);
    return evaluateSandboxLease(lease, specifier, context, result);
  };
}

export interface ViteProcessStopInput {
  getAiMode?: () => AiMode;
  write?: (line: string) => void;
  /** Where the installed hook's state is kept. Defaults to `globalThis`. */
  slot?: Record<symbol, unknown>;
  /** Defaults to `module.registerHooks`; undefined on a Node without it. */
  registerHooks?: RegisterHooks;
  /** Defaults to the register's activation mark. */
  registerActive?: () => boolean;
  /** Defaults to `process.versions.node`. */
  nodeVersion?: string;
}

export interface ViteLiveProcessStopInput {
  write?: (line: string) => void;
  slot?: Record<symbol, unknown>;
  registerHooks?: RegisterHooks;
  registerActive?: () => boolean;
  nodeVersion?: string;
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
  if (existing !== undefined) return existing;
  const label = surface === 'live' ? '@pyric/live/vite' : 'pyric() Vite plugin';
  const registerHooks = requireRegisterHooks(
    resolveHooksCallback(input),
    label,
    input.nodeVersion ?? process.versions.node,
    write,
  );
  const state: StopState = { leases: [] };
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const result = nextResolve(specifier, context);
      if (registerActiveCheck()) return result;
      const active = state.leases.at(-1);
      if (active === undefined) return result;
      if (active.kind === 'live') {
        if (isLiveRegisterActive()) return result;
        return evaluateLiveLease(active, specifier, context, result);
      }
      return evaluateSandboxLease(active, specifier, context, result);
    },
  });
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
  const lease: SandboxStopLease = {
    kind: 'sandbox',
    getAiMode: input.getAiMode ?? (() => 'sandbox'),
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
