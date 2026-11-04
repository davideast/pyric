/**
 * `@pyric/cli/register/internal/supplied-rows`: the one seam through which
 * `@pyric/live/register` serves its rows to a Node process, over this
 * package's resolve hooks, stop, worker and child-process guards. It takes
 * no module ids: the row modules are fixed (`supplied-rows.ts`), and their
 * source comes from the `@pyric/live` installed in the project, which opens
 * them only for its own register entry (`live-package.ts`). Without that
 * package the register refuses to start. `@pyric/cli/register` never reads
 * this module, and no option, flag or environment variable reaches it.
 */
import Module from 'node:module';
import { isLiveRegisterActive, isRegisterActive, markLiveRegisterActive } from './activation.js';
import { installChildProcessGuard } from './child-process-guard.js';
import { loadRegisterRowPackage } from './live-package.js';
import { createStopReporter, suppliedRowsStopFor } from './swap-or-stop.js';
import { isRegisterLiveModule } from './live-row.js';
import {
  registerLiveModuleSource,
  registerRows,
  registerRowsResolution,
  type RegisterRows,
} from './supplied-rows.js';
import { installWorkerGuard } from './worker-guard.js';
import type { SuppliedRowsRefusal } from '../serve/vite-supplied-rows.js';

export { REGISTER_OBSERVER_URL, REGISTER_ROW_URLS } from './live-row.js';
export type { ServedFirebaseSpecifier } from '../serve/firebase-module-swap.js';
export type { SuppliedRowsPlane, SuppliedRowsRefusal } from '../serve/vite-supplied-rows.js';
export type { ObservedCall, ObservedCallService, ProductionOutcome } from 'pyric/sandbox';

/** What the supplier gives: the error for a refused import, and the URL of its own register entry. */
export interface SuppliedRegisterInput {
  readonly refusal: SuppliedRowsRefusal;
  /** `import.meta.url` of the register entry calling this; it must be the installed `@pyric/live/register`. */
  readonly entryUrl: string;
}

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

/** The resolve hook: rows, the installed SDK for a row's own import, refusals, and the stop. */
function resolveWithRows(rows: RegisterRows): Resolve {
  const report = createStopReporter((line) => void process.stderr.write(line));
  const allowedUrls = new Set<string>();
  return (specifier, context, nextResolve) => {
    const resolution = registerRowsResolution(rows, specifier, context.parentURL);
    if (resolution.kind === 'refused') throw resolution.error;
    if (resolution.kind === 'module') return { url: resolution.url, format: 'module', shortCircuit: true };
    const isRowImport = resolution.kind === 'installed-sdk';
    // A row resolves its own specifier as the app would: from the project root.
    const result = isRowImport
      ? nextResolve(specifier, { ...context, parentURL: resolution.projectUrl })
      : nextResolve(specifier, context);
    const stop = suppliedRowsStopFor({ specifier, importer: context.parentURL, url: result.url }, allowedUrls, isRowImport);
    if (stop === null) return result;
    report(stop);
    throw stop;
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

/**
 * Starts the live rows in this thread: the installed `@pyric/live` opens
 * them, then the hooks go in, and every worker thread and child process this
 * process starts loads the same entry. Throws, leaving the process
 * unhooked, when the rows cannot open: `@pyric/live` not installed in the
 * project, the entry not its register, Node without `module.registerHooks`,
 * or `@pyric/cli/register` already active.
 */
export async function activateWithSuppliedRows(input: SuppliedRegisterInput): Promise<void> {
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
  const rows = registerRows(input.refusal);
  rows.open(await loadRegisterRowPackage(process.cwd(), input.entryUrl));
  installWorkerGuard(input.entryUrl);
  installChildProcessGuard(input.entryUrl);
  registerHooks({ resolve: resolveWithRows(rows), load: loadWithRows(rows) });
  markLiveRegisterActive();
  process.stderr.write(
    `${LOG_PREFIX}: live mode. firebase/app, firebase/auth, firebase/firestore and firebase/app-check are your ` +
      'installed SDK, talking to your Firebase project, and each call is reported to the Node host.\n',
  );
}
