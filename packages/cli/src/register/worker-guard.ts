/**
 * The register in worker threads.
 *
 * Built-in modules and resolve hooks are per thread, so the swap and the stop
 * have to be installed inside each worker as well. Node runs `--import` preloads (from the command
 * line or `NODE_OPTIONS`) in a worker built from a file, a `data:` URL or ESM
 * source, and the register then activates there as it does on the main
 * thread. Two kinds of worker skip it:
 *
 *  - a worker built from CommonJS source with `eval: true`, which never runs
 *    preloads;
 *  - a worker given its own `execArgv`, when the register came from the
 *    command line rather than `NODE_OPTIONS`.
 *
 * Wrapping `worker_threads.Worker` closes both.
 *
 * A worker of a registered thread is in the sandbox whatever `env` it is
 * given (#1621). The register activates in a thread under that thread's
 * `PYRIC_SANDBOX`, so a worker given its own `env` object
 * (`new Worker(file, { env: { PATH } })`) gets each `PYRIC_*` variable this
 * thread has and that `env` lacks, as a child process does. A variable the
 * caller set for the worker keeps the caller's value. When the register is
 * active in this thread, the worker's env also carries `PYRIC_SANDBOX_FORCE=1`
 * (including inherited and `SHARE_ENV` workers when `NODE_ENV=production`),
 * so a `NODE_ENV=production` mutation there does not refuse it.
 */
import Module, { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { types } from 'node:util';
import {
  hasForeignRegisterPreload,
  hasPreloadBeforeRegister,
  hasPreloadBeforeRegisterTokens,
  isSandboxParent,
  loadsRegister,
  matchesRegisterSpecifier,
  pinnedInheritedVariables,
  withCanonicalRegisterExecArgv,
  withCanonicalRegisterNodeOptions,
  withInheritedSandbox,
} from './child-process-guard.js';

type Env = Record<string, string | undefined>;

/** The `Worker` options this module reads. */
interface WorkerOptionsLike {
  eval?: unknown;
  execArgv?: unknown;
  env?: unknown;
  [key: string]: unknown;
}

type WorkerConstructor = new (source: unknown, options?: unknown) => object;

/** Marks a `Worker` this module already wrapped. */
const GUARDED_WORKER = Symbol.for('pyric.guardedWorker');

/** A `'use strict'` directive, which must stay the first statement. */
const USE_STRICT = /^(\s*(['"])use strict\2;?[ \t]*\n?)/;

/**
 * Whether the caller gave the worker an env object of its own. `SHARE_ENV` is
 * a symbol, and a worker with no `env` gets a copy of this thread's env; both
 * already carry this thread's `PYRIC_*` variables.
 */
function isOwnEnv(env: unknown): env is Env {
  return typeof env === 'object' && env !== null;
}

/** Matches Node `worker_threads` truthiness for `options.eval`. */
function isEvalWorker(options: WorkerOptionsLike | undefined): boolean {
  return Boolean(options?.eval);
}

function hasEvalAccessor(options: WorkerOptionsLike | undefined): boolean {
  if (options === undefined || options === null) return false;
  if (types.isProxy(options)) return true;
  for (let current: object | null = options; current !== null; current = Object.getPrototypeOf(current)) {
    const descriptor = Object.getOwnPropertyDescriptor(current, 'eval');
    if (descriptor !== undefined) return typeof descriptor.get === 'function';
  }
  return false;
}

const ATTACHED_PRELOAD_PREFIXES = ['--import=', '--require=', '-r='] as const;

function needsNodeOptionsGuard(
  nodeOptions: string,
  parentNodeOptions: string,
  registerUrl: string,
  parentLoadedViaNodeOptions: boolean,
): boolean {
  return (
    parentLoadedViaNodeOptions ||
    loadsRegister(parentNodeOptions, registerUrl) ||
    loadsRegister(nodeOptions, registerUrl) ||
    hasForeignRegisterPreload(nodeOptions, registerUrl) ||
    hasPreloadBeforeRegister(nodeOptions, registerUrl)
  );
}

function needsParentNodeOptionsRestore(
  parentNodeOptions: string,
  registerUrl: string,
  parentLoadedViaNodeOptions: boolean,
): boolean {
  const hasForeign = hasForeignRegisterPreload(parentNodeOptions, registerUrl);
  const hasEarlierPreload = hasPreloadBeforeRegister(parentNodeOptions, registerUrl);
  const droppedOwnPreload = parentLoadedViaNodeOptions && !loadsRegister(parentNodeOptions, registerUrl);
  return hasForeign || hasEarlierPreload || droppedOwnPreload;
}

function hasNonFileUrlRegisterExecArgv(execArgv: readonly string[], registerUrl: string): boolean {
  for (const arg of execArgv) {
    if (!arg.startsWith('file:') && matchesRegisterSpecifier(arg, registerUrl)) {
      return true;
    }
    for (const prefix of ATTACHED_PRELOAD_PREFIXES) {
      if (arg.startsWith(prefix)) {
        const target = arg.slice(prefix.length);
        if (!target.startsWith('file:') && matchesRegisterSpecifier(target, registerUrl)) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * The arguments to build the worker with, so that it loads the register at
 * `registerUrl` in the sandbox `parentEnv` names. `parentActive` says whether
 * the register is active in this thread; `@pyric/live/register` installs this
 * guard too, without it. Returns new values and never changes the caller's.
 */
export function guardWorkerArguments(
  source: unknown,
  options: WorkerOptionsLike | undefined,
  registerUrl: string,
  parentEnv: Env = process.env,
  parentActive: boolean = isSandboxParent(),
  evalRegisterUrl: string = registerUrl,
  parentLoadedViaNodeOptions = false,
): [unknown, WorkerOptionsLike | undefined] {
  let guardedSource = source;
  let guardedOptions = options;
  const evalMode = isEvalWorker(options);
  if (hasEvalAccessor(options)) {
    guardedOptions = { ...guardedOptions, eval: evalMode };
  }
  if (evalMode && typeof source === 'string') {
    guardedSource = withRegisterPrefix(source, evalRegisterUrl);
  }
  if (Array.isArray(options?.execArgv)) {
    guardedOptions = {
      ...guardedOptions,
      execArgv: withCanonicalRegisterExecArgv(options.execArgv, registerUrl),
    };
  }
  if (isOwnEnv(options?.env)) {
    const inherited = withInheritedSandbox(options.env, parentEnv, parentActive);
    const parentNodeOptions = parentEnv.NODE_OPTIONS ?? '';
    const childNodeOptions = inherited.NODE_OPTIONS ?? '';
    if (needsNodeOptionsGuard(childNodeOptions, parentNodeOptions, registerUrl, parentLoadedViaNodeOptions)) {
      inherited.NODE_OPTIONS = withCanonicalRegisterNodeOptions(childNodeOptions, registerUrl);
    }
    guardedOptions = { ...guardedOptions, env: inherited };
  } else if (options?.env === undefined) {
    const pinned = pinnedInheritedVariables();
    let needsPinnedEnv = false;
    for (const [name, value] of pinned) {
      if (parentEnv[name] !== value) {
        needsPinnedEnv = true;
        break;
      }
    }
    const parentNodeOptions = parentEnv.NODE_OPTIONS ?? '';
    const needsCanonicalNodeOptions = needsParentNodeOptionsRestore(
      parentNodeOptions,
      registerUrl,
      parentLoadedViaNodeOptions,
    );
    const needsProductionForce =
      parentActive && parentEnv.NODE_ENV === 'production' && parentEnv.PYRIC_SANDBOX_FORCE !== '1';
    if (needsPinnedEnv || needsCanonicalNodeOptions || needsProductionForce) {
      const inherited = withInheritedSandbox(parentEnv, parentEnv, parentActive);
      if (needsNodeOptionsGuard(parentNodeOptions, parentNodeOptions, registerUrl, parentLoadedViaNodeOptions)) {
        inherited.NODE_OPTIONS = withCanonicalRegisterNodeOptions(parentNodeOptions, registerUrl);
      }
      guardedOptions = { ...guardedOptions, env: inherited };
    }
  } else if (typeof options?.env === 'symbol') {
    if (parentActive && parentEnv.PYRIC_SANDBOX_FORCE !== '1') {
      parentEnv.PYRIC_SANDBOX_FORCE = '1';
    }
    for (const [name, value] of pinnedInheritedVariables()) {
      if (parentEnv[name] !== value) parentEnv[name] = value;
    }
    const parentNodeOptions = parentEnv.NODE_OPTIONS ?? '';
    if (needsParentNodeOptionsRestore(parentNodeOptions, registerUrl, parentLoadedViaNodeOptions)) {
      parentEnv.NODE_OPTIONS = withCanonicalRegisterNodeOptions(parentNodeOptions, registerUrl);
    }
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
export function installWorkerGuard(
  registerUrl: string,
  workerThreads?: { Worker: unknown },
  evalRegisterUrl: string = registerUrl,
): void {
  const target = workerThreads ?? (createRequire(import.meta.url)('node:worker_threads') as { Worker: unknown });
  const Original = target.Worker as (WorkerConstructor & { [GUARDED_WORKER]?: true }) | undefined;
  if (typeof Original !== 'function' || Original[GUARDED_WORKER] === true) return;
  const parentLoadedViaNodeOptions = loadsRegister(process.env.NODE_OPTIONS ?? '', registerUrl);
  class GuardedWorker extends Original {
    static readonly [GUARDED_WORKER] = true;
    constructor(source: unknown, options?: WorkerOptionsLike) {
      let effectiveOptions = options;
      const evalMode = isEvalWorker(options);
      if (hasEvalAccessor(options)) {
        effectiveOptions = { ...effectiveOptions, eval: evalMode };
      }
      if (
        effectiveOptions?.execArgv === undefined &&
        (hasNonFileUrlRegisterExecArgv(process.execArgv, registerUrl) ||
          hasPreloadBeforeRegisterTokens(process.execArgv, registerUrl))
      ) {
        effectiveOptions = {
          ...effectiveOptions,
          execArgv: withCanonicalRegisterExecArgv(process.execArgv, registerUrl),
        };
      }
      super(
        ...guardWorkerArguments(
          source,
          effectiveOptions,
          registerUrl,
          process.env,
          isSandboxParent(),
          evalRegisterUrl,
          parentLoadedViaNodeOptions,
        ),
      );
    }
  }
  Object.defineProperty(GuardedWorker, 'name', { value: Original.name });
  target.Worker = GuardedWorker;
  // ESM `import { Worker } from 'node:worker_threads'` reads the export as
  // synced, so publish the replacement there too.
  if (workerThreads === undefined) Module.syncBuiltinESMExports();
}
