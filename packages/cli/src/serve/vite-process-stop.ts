/**
 * Swap or stop in the Vite dev server process (ADR 0022).
 *
 * The plugin swaps `firebase/*` for the browser and routes the served
 * subpaths and `firebase-admin/*` in the server-rendered modules Vite
 * processes (`vite-ssr-routing.ts`). Vite leaves some loads to Node itself:
 * an installed package it externalizes that imports `firebase-admin` or
 * `firebase`, or an unserved `firebase/*` subpath in a server module. Under
 * `pyric sandbox -- vite dev` the register's resolve hook stops those. Under
 * plain `vite dev` there is no register, so the plugin installs this sync
 * resolve hook in its process: it resolves nothing differently, and throws
 * `PYRIC_REAL_SDK_STOPPED` before a real SDK file loads, with the register's
 * own decision and error (`stopFor` in `../register/swap-or-stop.ts`).
 *
 * The hook can't see what loaded before the plugin module ran, such as the
 * Vite config's own static imports.
 */
import Module from 'node:module';
import { UNSUPPORTED_RUNTIME_CODE } from '../cli/unsupported-runtime.js';
import { isRegisterActive } from '../register/activation.js';
import { canonicalFirebaseSpecifier } from '../register/mapping.js';
import { requireRegisterHooks } from '../register/node-version-stop.js';
import { packageNameOf } from '../register/package-identity.js';
import { createStopReporter, stopFor } from '../register/swap-or-stop.js';
import type { AiMode } from './firebase-module-swap.js';

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

/** What this process's hook reads on each resolve, so a Vite restart can replace the AI mode. */
interface StopState {
  getAiMode: () => AiMode;
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

/**
 * The hook: resolve as Node would, then stop a load of the real SDK that the
 * swap doesn't choose. Each stop is written once per file, so a caught
 * import still shows in the dev server log.
 */
export function viteProcessStopHook(input: ViteProcessStopHookInput): SyncResolve {
  const report = createStopReporter(input.write);
  const allowedUrls = new Set<string>();
  return (specifier, context, nextResolve) => {
    const result = nextResolve(specifier, context);
    const aiMode = input.getAiMode();
    const stop = stopFor({
      specifier,
      canonical: canonicalFirebaseSpecifier(specifier),
      importer: context.parentURL,
      url: result.url,
      aiMode,
    }, allowedUrls);
    if (stop === null) return result;
    if (isViteFirebaseAiLoad(result.url, context.parentURL, aiMode)) {
      allowedUrls.add(result.url);
      return result;
    }
    report(stop);
    throw stop;
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

const BUN_TEST_ENTRYPOINT = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

function isInProcessBunTestRunner(): boolean {
  const bunGlobal = (globalThis as { Bun?: { main?: unknown } }).Bun;
  return typeof bunGlobal?.main === 'string' && BUN_TEST_ENTRYPOINT.test(bunGlobal.main);
}

function createViteBunUnsupportedError(bunVersion: string): Error & { code: string } {
  const message =
    `pyric() Vite plugin: Bun ${bunVersion} does not run Node module.registerHooks [${UNSUPPORTED_RUNTIME_CODE}].\n` +
    "  Without synchronous module.registerHooks, externalized server imports of firebase and firebase-admin cannot be swapped or stopped and would reach live Firebase.\n" +
    '  Run Vite under Node >= 22.15 (for example `npx vite dev`).\n' +
    `  code: ${UNSUPPORTED_RUNTIME_CODE}`;
  const error = new Error(message) as Error & { code: string };
  error.code = UNSUPPORTED_RUNTIME_CODE;
  return error;
}

/**
 * Install the hook in this process once, unless the register is active, in
 * which case its own hook already stops these loads. Returns whether a hook
 * of this module is in place. A later call, from the plugin a Vite restart
 * builds, only replaces the AI mode the hook reads.
 */
export function installViteProcessStop(input: ViteProcessStopInput = {}): boolean {
  const registerActive = input.registerActive ?? isRegisterActive;
  if (registerActive()) return false;
  const slot = input.slot ?? (globalThis as unknown as Record<symbol, unknown>);
  const getAiMode = input.getAiMode ?? (() => 'sandbox');
  const installed = slot[VITE_PROCESS_STOP] as StopState | undefined;
  if (installed !== undefined) {
    installed.getAiMode = getAiMode;
    return true;
  }
  const write = input.write ?? ((line) => void process.stderr.write(line));
  const hasExplicitHooks = 'registerHooks' in input;
  if (!hasExplicitHooks && typeof process.versions.bun === 'string') {
    if (isInProcessBunTestRunner()) return false;
    const error = createViteBunUnsupportedError(process.versions.bun);
    write(`${error.message}\n`);
    throw error;
  }
  const registerHooks = requireRegisterHooks(
    hasExplicitHooks ? input.registerHooks : moduleApi.registerHooks?.bind(Module),
    'pyric() Vite plugin',
    input.nodeVersion ?? process.versions.node,
    write,
  );
  const state: StopState = { getAiMode };
  registerHooks({
    resolve: viteProcessStopHook({
      getAiMode: () => state.getAiMode(),
      write,
    }),
  });
  slot[VITE_PROCESS_STOP] = state;
  return true;
}
