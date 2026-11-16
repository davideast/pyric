/**
 * The register in child processes.
 *
 * A child process of a registered process is in the sandbox, whatever it is
 * started with (#1618). Node passes a preload to a child only through
 * `NODE_OPTIONS`, so a child loses the register when the parent got it on the
 * command line (`node --import @pyric/cli/register`), or when the caller gives
 * the child its own `NODE_OPTIONS` or `env`. Each of those children kept or
 * dropped `PYRIC_SANDBOX` and loaded the real `firebase-admin`.
 *
 * This module rewrites the environment of every child the process starts:
 * `NODE_OPTIONS` gets a canonical synchronous `--require` preload for the
 * active register (ahead of any caller preloads, including CLI `-r`/`--require`
 * flags in the spawned child), and each `PYRIC_*` variable this process has
 * and the child's environment lacks is copied in, `PYRIC_SANDBOX` first among
 * them. A variable the caller set for the child keeps the caller's value. When
 * the sandbox register is active in this process, and the live register is not,
 * the child also gets `PYRIC_SANDBOX_FORCE=1` unless the caller set it, so a
 * child started with `NODE_ENV=production` stays in the sandbox instead of
 * refusing it (#2340). A process that is not registered, or is in live mode,
 * adds no force.
 */
import Module, { createRequire } from 'node:module';
import { isLiveRegisterActive, isRegisterActive } from './activation.js';
import { withCanonicalRegisterNodeOptions } from './preload-tokens.js';

export {
  formatNodeOptionValue,
  hasForeignRegisterPreload,
  hasNonFileUrlRegisterExecArgv,
  hasPreloadBeforeRegister,
  hasPreloadBeforeRegisterTokens,
  hasSandboxRegisterAheadOfLive,
  loadsRegister,
  matchesRegisterSpecifier,
  withCanonicalRegisterExecArgv,
  withCanonicalRegisterNodeOptions,
} from './preload-tokens.js';

type Env = Record<string, string | undefined>;

/** The `child_process` exports this module replaces. */
interface ChildProcessModule {
  ChildProcess: { prototype: { spawn?: unknown } };
  spawnSync: unknown;
  execSync: unknown;
  execFileSync: unknown;
}

/** Marks a function this module already wrapped. */
const GUARDED = Symbol.for('pyric.guardedChildProcess');

/** The variables that carry the sandbox to a child. */
const SANDBOX_VARIABLE = /^PYRIC_/;

/**
 * Inviolable inherited variables pinned by the active register (for example,
 * the live register's project root, SDK root, pass-through list, and resolved
 * project id). Every child process and worker receives these exact values even
 * if the caller supplies a custom `env` or mutates `process.env`.
 */
const pinnedVariables = new Map<string, string>();

export function pinInheritedVariables(entries: Readonly<Record<string, string>>): void {
  for (const [name, value] of Object.entries(entries)) {
    process.env[name] = value;
    pinnedVariables.set(name, value);
  }
}

export function pinnedInheritedVariables(): ReadonlyMap<string, string> {
  return pinnedVariables;
}

export function clearPinnedInheritedVariables(): void {
  pinnedVariables.clear();
}

/**
 * `env` with each `PYRIC_*` variable `parentEnv` has and `env` lacks copied
 * in. A variable `env` already sets keeps its value. Returns a new object and
 * never changes `env`. The worker guard uses it too (#1621).
 */
export function withSandboxVariables(env: Env, parentEnv: Env): Env {
  const guarded: Env = { ...env };
  for (const [name, value] of Object.entries(parentEnv)) {
    const lacksIt = guarded[name] === undefined || guarded[name] === '';
    if (SANDBOX_VARIABLE.test(name) && value !== undefined && lacksIt) guarded[name] = value;
  }
  return guarded;
}

/**
 * Whether this thread is in the sandbox its children inherit: the sandbox
 * register is active here, and the live register is not. A process the
 * register refused (`NODE_ENV=production`) is not active.
 */
export function isSandboxParent(): boolean {
  return isRegisterActive() && !isLiveRegisterActive();
}

/**
 * Whether the caller chose `PYRIC_SANDBOX_FORCE` for the child or worker,
 * read from the caller's `env` alone. An empty value is no choice, and a
 * value equal to this process's own is inherited, as when the caller spread
 * `process.env`, so neither counts.
 */
function callerSetForce(env: Env, parentEnv: Env): boolean {
  const value = env.PYRIC_SANDBOX_FORCE;
  const hasValue = value !== undefined && value !== '';
  return hasValue && value !== parentEnv.PYRIC_SANDBOX_FORCE;
}

/**
 * `env` carrying the sandbox to a child process or a worker: the `PYRIC_*`
 * variables `parentEnv` has and `env` lacks (see {@link withSandboxVariables}),
 * and, when `parentActive`, `PYRIC_SANDBOX_FORCE=1` unless the caller chose
 * another value ({@link callerSetForce}), so a `NODE_ENV=production` there
 * does not make the register refuse. Returns a new object and never changes
 * `env`. Snapshots `env` once so property getters on caller objects cannot
 * observe different values across checks.
 */
export function withInheritedSandbox(env: Env, parentEnv: Env, parentActive: boolean): Env {
  const callerEnv: Env = { ...env };
  const guarded = withSandboxVariables(callerEnv, parentEnv);
  const forces = parentActive && !callerSetForce(callerEnv, parentEnv);
  if (forces) guarded.PYRIC_SANDBOX_FORCE = '1';
  for (const [name, value] of pinnedVariables) {
    guarded[name] = value;
  }
  return guarded;
}

/**
 * The environment to start a child with, so that it loads the register at
 * `registerUrl` (with optional synchronous counterpart `syncRegisterUrl`) in
 * the sandbox `parentEnv` names. `parentActive` says whether this process is a
 * sandbox parent ({@link isSandboxParent}). Returns a new object and never
 * changes `childEnv`.
 */
export function guardChildEnv(
  childEnv: Env,
  parentEnv: Env,
  registerUrl: string,
  parentActive: boolean = isSandboxParent(),
  syncRegisterUrl?: string,
): Env {
  const guarded = withInheritedSandbox(childEnv, parentEnv, parentActive);
  const nodeOptions = guarded.NODE_OPTIONS ?? '';
  guarded.NODE_OPTIONS = withCanonicalRegisterNodeOptions(nodeOptions, registerUrl, syncRegisterUrl);
  return guarded;
}

/** `envPairs` (`NAME=value` strings, as `ChildProcess.prototype.spawn` takes them) with the guarded env. */
export function guardEnvPairs(
  envPairs: readonly string[],
  parentEnv: Env,
  registerUrl: string,
  parentActive: boolean = isSandboxParent(),
  syncRegisterUrl?: string,
): string[] {
  const childEnv: Env = {};
  for (const pair of envPairs) {
    const split = pair.indexOf('=');
    if (split === -1) childEnv[pair] = '';
    else childEnv[pair.slice(0, split)] = pair.slice(split + 1);
  }
  const guarded = guardChildEnv(childEnv, parentEnv, registerUrl, parentActive, syncRegisterUrl);
  const pairs: string[] = [];
  for (const [name, value] of Object.entries(guarded)) {
    if (value !== undefined) pairs.push(`${name}=${value}`);
  }
  return pairs;
}

function isOptions(value: unknown): value is { env?: Env } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Where a synchronous call's options go. `execSync(command, options)` takes
 * them second. `spawnSync` and `execFileSync` take `(file, args, options)`,
 * where `args` may be left out, or passed as `undefined` or `null`.
 */
function optionsIndex(takesArgs: boolean, args: readonly unknown[]): number {
  if (!takesArgs) return 1;
  const second = args[1];
  if (isOptions(second)) return 1;
  const hasArgsSlot = Array.isArray(second) || (second == null && args.length > 2);
  return hasArgsSlot ? 2 : 1;
}

/**
 * The arguments for a synchronous `child_process` call, with options whose
 * `env` is guarded. A call that names no env gets one built from this
 * process's env, as Node would build it. Returns new values and never changes
 * the caller's.
 */
export function guardSyncArguments(
  takesArgs: boolean,
  args: readonly unknown[],
  parentEnv: Env,
  registerUrl: string,
  syncRegisterUrl?: string,
): unknown[] {
  const guarded = [...args];
  const index = optionsIndex(takesArgs, guarded);
  const options: { env?: Env } = isOptions(guarded[index]) ? { ...guarded[index] } : {};
  guarded[index] = {
    ...options,
    env: guardChildEnv(options.env ?? parentEnv, parentEnv, registerUrl, undefined, syncRegisterUrl),
  };
  return guarded;
}

type AnyFunction = (this: unknown, ...args: unknown[]) => unknown;

function isGuarded(value: unknown): boolean {
  return typeof value === 'function' && (value as { [GUARDED]?: true })[GUARDED] === true;
}

function markGuarded<T extends AnyFunction>(wrapper: T, original: AnyFunction): T {
  Object.defineProperty(wrapper, GUARDED, { value: true });
  Object.defineProperty(wrapper, 'name', { value: original.name });
  return wrapper;
}

/**
 * The options `ChildProcess.prototype.spawn` receives, with the env guarded.
 * Node resolves the child's env into `envPairs` before this call. Bun builds
 * its children elsewhere and ignores the env here, so its asynchronous
 * children are not covered; its synchronous ones are.
 */
export function guardSpawnOptions(
  options: unknown,
  registerUrl: string,
  syncRegisterUrl?: string,
): unknown {
  if (!isOptions(options)) return options;
  const { envPairs } = options as { envPairs?: unknown };
  if (!Array.isArray(envPairs)) return options;
  return {
    ...options,
    envPairs: guardEnvPairs(envPairs as string[], process.env, registerUrl, undefined, syncRegisterUrl),
  };
}

function guardAsyncSpawn(
  target: ChildProcessModule,
  registerUrl: string,
  syncRegisterUrl?: string,
): void {
  const prototype = target.ChildProcess?.prototype;
  const original = prototype?.spawn;
  if (typeof original !== 'function' || isGuarded(original)) return;
  const spawnOriginal = original as AnyFunction;
  prototype.spawn = markGuarded(function (this: unknown, ...args: unknown[]) {
    args[0] = guardSpawnOptions(args[0], registerUrl, syncRegisterUrl);
    return spawnOriginal.apply(this, args);
  }, spawnOriginal);
}

function guardSyncExport(
  target: ChildProcessModule,
  name: 'spawnSync' | 'execSync' | 'execFileSync',
  registerUrl: string,
  syncRegisterUrl?: string,
): void {
  const original = target[name];
  if (typeof original !== 'function' || isGuarded(original)) return;
  const takesArgs = name !== 'execSync';
  const syncOriginal = original as AnyFunction;
  target[name] = markGuarded(function (this: unknown, ...args: unknown[]) {
    return syncOriginal.apply(
      this,
      guardSyncArguments(takesArgs, args, process.env, registerUrl, syncRegisterUrl),
    );
  }, syncOriginal);
}

/**
 * Start every child process of this process with the register at
 * `registerUrl` (and optional synchronous entry `syncRegisterUrl`).
 * `childProcess` defaults to `node:child_process`; tests pass a stand-in.
 */
export function installChildProcessGuard(
  registerUrl: string,
  childProcess?: ChildProcessModule,
  syncRegisterUrl?: string,
): void {
  const target = childProcess ?? (createRequire(import.meta.url)('node:child_process') as ChildProcessModule);
  guardAsyncSpawn(target, registerUrl, syncRegisterUrl);
  guardSyncExport(target, 'spawnSync', registerUrl, syncRegisterUrl);
  guardSyncExport(target, 'execSync', registerUrl, syncRegisterUrl);
  guardSyncExport(target, 'execFileSync', registerUrl, syncRegisterUrl);
  // ESM `import { spawnSync } from 'node:child_process'` reads the export as
  // synced, so publish the replacements there too.
  if (childProcess === undefined) Module.syncBuiltinESMExports();
}
