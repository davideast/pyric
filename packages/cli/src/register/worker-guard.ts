/**
 * The register in worker threads.
 *
 * Built-in modules and resolve hooks are per thread, so the swap, the stop
 * and the network guard have to be installed inside each worker as well. The
 * register installs this wrapper whatever `PYRIC_GUARD` says. Node runs `--import` preloads (from the command
 * line or `NODE_OPTIONS`) in a worker built from a file, a `data:` URL or ESM
 * source, and the register then activates there as it does on the main
 * thread. Two kinds of worker skip it:
 *
 *  - a worker built from CommonJS source with `eval: true`, which never runs
 *    preloads;
 *  - a worker given its own `execArgv`, when the register came from the
 *    command line rather than `NODE_OPTIONS`.
 *
 * Wrapping `worker_threads.Worker` closes both. The worker still activates
 * the register only under its own `PYRIC_SANDBOX`, exactly as the main thread
 * does, so a worker the caller started outside the sandbox stays outside it.
 */
import Module, { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

/** The `Worker` options this module reads. */
interface WorkerOptionsLike {
  eval?: unknown;
  execArgv?: unknown;
}

type WorkerConstructor = new (source: unknown, options?: unknown) => object;

/** Marks a `Worker` this module already wrapped. */
const GUARDED_WORKER = Symbol.for('pyric.guardedWorker');

/** A `'use strict'` directive, which must stay the first statement. */
const USE_STRICT = /^(\s*(['"])use strict\2;?[ \t]*\n?)/;

/**
 * The arguments to build the worker with, so that it loads the register at
 * `registerUrl`. Returns new values and never changes the caller's.
 */
export function guardWorkerArguments(
  source: unknown,
  options: WorkerOptionsLike | undefined,
  registerUrl: string,
): [unknown, WorkerOptionsLike | undefined] {
  let guardedSource = source;
  let guardedOptions = options;
  if (options?.eval === true && typeof source === 'string') {
    guardedSource = withRegisterPrefix(source, registerUrl);
  }
  if (Array.isArray(options?.execArgv) && !options.execArgv.includes(registerUrl)) {
    guardedOptions = { ...options, execArgv: [...options.execArgv, '--import', registerUrl] };
  }
  return [guardedSource, guardedOptions];
}

/**
 * Eval source that first loads the register. `require` exists only when Node
 * runs the source as CommonJS; ESM source already ran the preload, and the
 * prefix does nothing there.
 */
function withRegisterPrefix(source: string, registerUrl: string): string {
  const prefix = `typeof require === 'function' && require(${JSON.stringify(fileURLToPath(registerUrl))});\n`;
  const directive = USE_STRICT.exec(source)?.[1];
  if (directive === undefined) return `${prefix}${source}`;
  const separator = directive.endsWith('\n') ? '' : '\n';
  return `${directive}${separator}${prefix}${source.slice(directive.length)}`;
}

/**
 * Replace `workerThreads.Worker` with a subclass that builds every worker with
 * {@link guardWorkerArguments}. A subclass keeps `instanceof Worker` true.
 * `workerThreads` defaults to `node:worker_threads`; tests pass a stand-in.
 */
export function installWorkerGuard(registerUrl: string, workerThreads?: { Worker: unknown }): void {
  const target = workerThreads ?? (createRequire(import.meta.url)('node:worker_threads') as { Worker: unknown });
  const Original = target.Worker as (WorkerConstructor & { [GUARDED_WORKER]?: true }) | undefined;
  if (typeof Original !== 'function' || Original[GUARDED_WORKER] === true) return;
  class GuardedWorker extends Original {
    static readonly [GUARDED_WORKER] = true;
    constructor(source: unknown, options?: WorkerOptionsLike) {
      super(...guardWorkerArguments(source, options, registerUrl));
    }
  }
  Object.defineProperty(GuardedWorker, 'name', { value: Original.name });
  target.Worker = GuardedWorker;
  // ESM `import { Worker } from 'node:worker_threads'` reads the export as
  // synced, so publish the replacement there too.
  if (workerThreads === undefined) Module.syncBuiltinESMExports();
}
