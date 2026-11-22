/**
 * Worker-thread propagation for standalone Vite dev server process stops (#1447).
 *
 * Under `pyric sandbox -- vite dev` or `pyric live -- vite dev`, the active
 * register (`@pyric/cli/register` or `@pyric/live/register`) already wraps
 * `worker_threads.Worker` via `register/worker-guard.ts`. Under plain
 * `vite dev` (standalone `pyric()` or `@pyric/live/vite`), no register is
 * active, so `module.registerHooks` on the main thread does not carry into
 * `new Worker(...)` threads.
 *
 * Wrapping `worker_threads.Worker` while a Vite process-stop lease is active
 * snapshots `options` once (defeating TOCTOU getters and Proxies), injects a
 * canonical synchronous `--require` + `--import` preload for
 * `vite-process-stop` at the front of `NODE_OPTIONS` (and `execArgv` whenever
 * explicit `execArgv` or `SHARE_ENV` is used, ahead of caller preloads and
 * `--`), prefixes CommonJS `eval: true` source (defeating
 * `function require() {}` hoisting), and propagates the active stop mode
 * across custom, inherited (`undefined`/`null`), and `SHARE_ENV` environments.
 * Node ignores `process.env.NODE_OPTIONS` for `SHARE_ENV` workers, so those
 * receive synthesized `execArgv` with any process-only flags (such as
 * `--max-old-space-size`) stripped on `ERR_WORKER_INVALID_EXEC_ARGV`. When no
 * Vite lease is active (or when the full register is active), `Worker`
 * arguments pass through untouched, and any `SHARE_ENV` writes to
 * `process.env` are restored when the last Vite lease releases.
 */
import Module, { createRequire } from 'node:module';
import {
  withCanonicalRegisterExecArgv,
  withCanonicalRegisterNodeOptions,
} from '../register/preload-tokens.js';
import {
  isEvalWorker,
  isOwnEnv,
  snapshotWorkerOptions,
  withRegisterPrefix,
  type WorkerOptionsLike,
} from '../register/worker-guard.js';
import type { AiMode } from './firebase-module-swap.js';

type Env = Record<string, string | undefined>;
type WorkerConstructor = new (source: unknown, options?: unknown) => object;

/** Env key selecting the stop surface inside a Vite worker thread (`sandbox` or `live`). */
export const VITE_WORKER_STOP_MODE_ENV = 'PYRIC_VITE_WORKER_STOP_MODE';
/** Env key carrying the sandbox AI mode (`sandbox` or `production`) to a Vite worker thread. */
export const VITE_WORKER_STOP_AI_MODE_ENV = 'PYRIC_VITE_WORKER_STOP_AI_MODE';
/** Env key carrying Vite's resolved project root to a Vite worker thread. */
export const VITE_WORKER_STOP_PROJECT_ROOT_ENV = 'PYRIC_VITE_WORKER_STOP_PROJECT_ROOT';

/** Marks a `Worker` constructor already wrapped by this module. */
const VITE_GUARDED_WORKER = Symbol.for('pyric.viteGuardedWorker');

const INVALID_EXEC_ARGV_PREFIX = 'invalid execArgv flags: ';

/** Active Vite process-stop configuration propagated into spawned workers. */
export type ActiveViteStopConfig =
  | { readonly kind: 'sandbox'; readonly aiMode: AiMode; readonly projectRoot?: string }
  | { readonly kind: 'live' };

function cloneEnvOnce(raw: Env): Env {
  const copy: Env = { ...raw };
  if (!Object.prototype.hasOwnProperty.call(copy, 'NODE_OPTIONS') && 'NODE_OPTIONS' in raw) {
    const value = raw.NODE_OPTIONS;
    if (typeof value === 'string' || value === undefined) {
      copy.NODE_OPTIONS = value;
    }
  }
  return copy;
}

function recordPriorKey(
  backup: Map<string, string | undefined> | undefined,
  env: Env,
  key: string,
): void {
  if (backup === undefined || backup.has(key)) return;
  backup.set(key, env[key]);
}

function applyViteWorkerStopEnv(
  target: Env,
  config: ActiveViteStopConfig,
  preloadUrl: string,
  backup?: Map<string, string | undefined>,
): void {
  recordPriorKey(backup, target, VITE_WORKER_STOP_MODE_ENV);
  target[VITE_WORKER_STOP_MODE_ENV] = config.kind;

  recordPriorKey(backup, target, VITE_WORKER_STOP_AI_MODE_ENV);
  recordPriorKey(backup, target, VITE_WORKER_STOP_PROJECT_ROOT_ENV);
  if (config.kind === 'sandbox') {
    target[VITE_WORKER_STOP_AI_MODE_ENV] = config.aiMode;
    if (config.projectRoot !== undefined && config.projectRoot !== '') {
      target[VITE_WORKER_STOP_PROJECT_ROOT_ENV] = config.projectRoot;
    } else {
      delete target[VITE_WORKER_STOP_PROJECT_ROOT_ENV];
    }
  } else {
    delete target[VITE_WORKER_STOP_AI_MODE_ENV];
    delete target[VITE_WORKER_STOP_PROJECT_ROOT_ENV];
  }

  recordPriorKey(backup, target, 'NODE_OPTIONS');
  target.NODE_OPTIONS = withCanonicalRegisterNodeOptions(
    target.NODE_OPTIONS ?? '',
    preloadUrl,
    preloadUrl,
  );
}

function isInvalidExecArgvError(error: unknown): error is Error & { code: string } {
  if (!(error instanceof Error)) return false;
  return (error as { code?: unknown }).code === 'ERR_WORKER_INVALID_EXEC_ARGV';
}

function stripRejectedExecArgvFlags(
  parentExecArgv: readonly string[],
  errorMessage: string,
): string[] {
  const marker = errorMessage.indexOf(INVALID_EXEC_ARGV_PREFIX);
  if (marker === -1) return [];
  const rawList = errorMessage.slice(marker + INVALID_EXEC_ARGV_PREFIX.length).trim();
  const rejected = new Set(
    rawList
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  );
  if (rejected.size === 0) return [];
  const kept: string[] = [];
  for (let i = 0; i < parentExecArgv.length; i += 1) {
    const token = parentExecArgv[i];
    if (token === undefined) continue;
    if (token === '--') {
      kept.push(...parentExecArgv.slice(i));
      break;
    }
    if (rejected.has(token)) {
      const next = parentExecArgv[i + 1];
      if (!token.includes('=') && next !== undefined && !next.startsWith('-')) {
        i += 1;
      }
      continue;
    }
    kept.push(token);
  }
  return kept;
}

/**
 * Restore any `process.env` keys modified for `SHARE_ENV` workers once the
 * last Vite process-stop lease releases.
 */
export function restoreSharedViteWorkerEnv(
  backup: Map<string, string | undefined>,
  targetEnv: Env = process.env,
): void {
  for (const [key, prior] of backup) {
    if (prior === undefined) {
      delete targetEnv[key];
    } else {
      targetEnv[key] = prior;
    }
  }
  backup.clear();
}

/**
 * Read the Vite worker-stop config propagated via `env`, or `null` when none
 * is set. Used by `vite-process-stop.ts` when preloaded inside a worker thread.
 */
export function readViteWorkerStopEnv(env: Env = process.env): ActiveViteStopConfig | null {
  const mode = env[VITE_WORKER_STOP_MODE_ENV];
  if (mode === 'live') return { kind: 'live' };
  if (mode !== 'sandbox') return null;
  const aiMode: AiMode = env[VITE_WORKER_STOP_AI_MODE_ENV] === 'production' ? 'production' : 'sandbox';
  const rawRoot = env[VITE_WORKER_STOP_PROJECT_ROOT_ENV];
  const projectRoot = rawRoot !== undefined && rawRoot !== '' ? rawRoot : undefined;
  return { kind: 'sandbox', aiMode, projectRoot };
}

/**
 * Compute guarded `(source, options)` arguments for `new Worker(...)` while a
 * Vite process-stop lease is active. Returns fresh values without mutating the
 * caller's `options`, `execArgv`, or custom `env` object.
 */
export function guardViteWorkerArguments(
  source: unknown,
  options: WorkerOptionsLike | undefined,
  preloadUrl: string,
  config: ActiveViteStopConfig,
  parentEnv: Env = process.env,
  sharedEnvBackup?: Map<string, string | undefined>,
  parentExecArgv: readonly string[] = process.execArgv,
): [unknown, WorkerOptionsLike] {
  let guardedSource = source;
  const snapshotted = snapshotWorkerOptions(options);
  const evalMode = isEvalWorker(snapshotted);
  if (evalMode && typeof source === 'string') {
    guardedSource = withRegisterPrefix(source, preloadUrl);
  }

  const guardedOptions: WorkerOptionsLike = { ...snapshotted };
  const hasExplicitExecArgv = Array.isArray(snapshotted?.execArgv);
  if (hasExplicitExecArgv) {
    guardedOptions.execArgv = withCanonicalRegisterExecArgv(
      snapshotted.execArgv as readonly unknown[],
      preloadUrl,
      preloadUrl,
    );
  }

  const envOption = snapshotted?.env;
  if (isOwnEnv(envOption)) {
    const childEnv = cloneEnvOnce(envOption);
    applyViteWorkerStopEnv(childEnv, config, preloadUrl);
    guardedOptions.env = childEnv;
    return [guardedSource, guardedOptions];
  }

  if (envOption == null) {
    const childEnv = cloneEnvOnce(parentEnv);
    applyViteWorkerStopEnv(childEnv, config, preloadUrl);
    guardedOptions.env = childEnv;
    return [guardedSource, guardedOptions];
  }

  if (typeof envOption === 'symbol') {
    applyViteWorkerStopEnv(parentEnv, config, preloadUrl, sharedEnvBackup);
    // Node does not apply `process.env.NODE_OPTIONS` when `env` is `SHARE_ENV`,
    // so the preload must also be injected via `execArgv`.
    if (!hasExplicitExecArgv) {
      guardedOptions.execArgv = withCanonicalRegisterExecArgv(
        parentExecArgv,
        preloadUrl,
        preloadUrl,
      );
    }
  }

  return [guardedSource, guardedOptions];
}

export interface InstallViteWorkerGuardInput {
  readonly preloadUrl: string;
  readonly getActiveConfig: () => ActiveViteStopConfig | null;
  readonly sharedEnvBackup: Map<string, string | undefined>;
  readonly workerThreads?: { Worker: unknown };
  readonly parentEnv?: Env;
  readonly parentExecArgv?: readonly string[];
}

function constructWorkerWithSynthesizedExecArgvFallback(
  Original: WorkerConstructor,
  newTarget: WorkerConstructor,
  guardedSource: unknown,
  guardedOptions: WorkerOptionsLike,
  preloadUrl: string,
  parentExecArgv: readonly string[],
): object {
  try {
    return Reflect.construct(Original, [guardedSource, guardedOptions], newTarget);
  } catch (firstError) {
    if (!isInvalidExecArgvError(firstError)) throw firstError;
    const filtered = stripRejectedExecArgvFlags(parentExecArgv, firstError.message);
    if (filtered.length > 0 && filtered.length < parentExecArgv.length) {
      const retryOptions: WorkerOptionsLike = {
        ...guardedOptions,
        execArgv: withCanonicalRegisterExecArgv(filtered, preloadUrl, preloadUrl),
      };
      try {
        return Reflect.construct(Original, [guardedSource, retryOptions], newTarget);
      } catch (secondError) {
        if (!isInvalidExecArgvError(secondError)) throw secondError;
      }
    }
    const minimalOptions: WorkerOptionsLike = {
      ...guardedOptions,
      execArgv: withCanonicalRegisterExecArgv([], preloadUrl, preloadUrl),
    };
    return Reflect.construct(Original, [guardedSource, minimalOptions], newTarget);
  }
}

/**
 * Wrap `workerThreads.Worker` so workers created while a standalone Vite
 * process-stop lease is active automatically install the same resolve stop
 * hook and worker guard. When `getActiveConfig()` returns `null` (all Vite
 * leases released, or the full register is active), `Worker` arguments pass
 * through untouched.
 */
export function installViteWorkerGuard(input: InstallViteWorkerGuardInput): void {
  const target =
    input.workerThreads ??
    (createRequire(import.meta.url)('node:worker_threads') as { Worker: unknown });
  const Original = target.Worker as (WorkerConstructor & { [VITE_GUARDED_WORKER]?: true }) | undefined;
  if (typeof Original !== 'function' || Original[VITE_GUARDED_WORKER] === true) return;

  const WrappedWorker = new Proxy(Original, {
    get(proxyTarget, prop, receiver) {
      if (prop === VITE_GUARDED_WORKER) return true;
      return Reflect.get(proxyTarget, prop, receiver);
    },
    construct(proxyTarget, argArray, newTarget) {
      const effectiveNewTarget = (newTarget === WrappedWorker ? proxyTarget : newTarget) as WorkerConstructor;
      const config = input.getActiveConfig();
      if (config === null) {
        return Reflect.construct(proxyTarget, argArray, effectiveNewTarget);
      }
      const source = argArray[0];
      const rawOptions = argArray[1] as WorkerOptionsLike | undefined;
      const snapshotted = snapshotWorkerOptions(rawOptions);
      const parentExecArgv = input.parentExecArgv ?? process.execArgv;
      const synthesizedExecArgv =
        typeof snapshotted?.env === 'symbol' && !Array.isArray(snapshotted?.execArgv);
      const [guardedSource, guardedOptions] = guardViteWorkerArguments(
        source,
        snapshotted,
        input.preloadUrl,
        config,
        input.parentEnv ?? process.env,
        input.sharedEnvBackup,
        parentExecArgv,
      );
      if (synthesizedExecArgv) {
        return constructWorkerWithSynthesizedExecArgvFallback(
          proxyTarget,
          effectiveNewTarget,
          guardedSource,
          guardedOptions,
          input.preloadUrl,
          parentExecArgv,
        );
      }
      return Reflect.construct(proxyTarget, [guardedSource, guardedOptions], effectiveNewTarget);
    },
  });

  target.Worker = WrappedWorker;
  if (input.workerThreads === undefined) {
    Module.syncBuiltinESMExports();
  }
}
