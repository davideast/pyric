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
 * `NODE_OPTIONS` gets `--import <register>` when it lacks the register, and
 * each `PYRIC_*` variable this process has and the child's environment lacks
 * is copied in, `PYRIC_SANDBOX` first among them. A variable the caller set
 * for the child keeps the caller's value. A shell the process starts passes
 * the environment on, so a Node process the shell starts is registered too,
 * unless the command line it runs sets `NODE_OPTIONS` itself
 * (`NODE_OPTIONS=--max-old-space-size=4096 node server.js`), which no code in
 * this process can see.
 *
 * Every asynchronous child (`spawn`, `exec`, `execFile`, `fork`, and their
 * promisified forms) is built by `ChildProcess.prototype.spawn` from the env
 * Node has already resolved, so one wrapper there covers them. The
 * synchronous forms reach a native binding instead, so `spawnSync`,
 * `execSync` and `execFileSync` are wrapped where they are exported.
 */
import Module, { createRequire } from 'node:module';

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

/** The register, named by its package rather than its file. */
const REGISTER_BY_NAME = /(^|\s)--import[= ]?["']?@pyric\/cli\/register(["'\s]|$)/;

/** Whether `nodeOptions` already loads the register. */
function loadsRegister(nodeOptions: string, registerUrl: string): boolean {
  return nodeOptions.includes(registerUrl) || REGISTER_BY_NAME.test(nodeOptions);
}

/**
 * The environment to start a child with, so that it loads the register at
 * `registerUrl` in the sandbox `parentEnv` names. Returns a new object and
 * never changes `childEnv`. `file:` URLs are percent-encoded, so the import
 * needs no quoting in `NODE_OPTIONS`.
 */
export function guardChildEnv(childEnv: Env, parentEnv: Env, registerUrl: string): Env {
  const guarded: Env = { ...childEnv };
  for (const [name, value] of Object.entries(parentEnv)) {
    const childLacksIt = guarded[name] === undefined || guarded[name] === '';
    if (SANDBOX_VARIABLE.test(name) && value !== undefined && childLacksIt) guarded[name] = value;
  }
  const nodeOptions = guarded.NODE_OPTIONS ?? '';
  if (!loadsRegister(nodeOptions, registerUrl)) {
    const importFlag = `--import ${registerUrl}`;
    guarded.NODE_OPTIONS = nodeOptions.trim() === '' ? importFlag : `${nodeOptions} ${importFlag}`;
  }
  return guarded;
}

/** `envPairs` (`NAME=value` strings, as `ChildProcess.prototype.spawn` takes them) with the guarded env. */
export function guardEnvPairs(envPairs: readonly string[], parentEnv: Env, registerUrl: string): string[] {
  const childEnv: Env = {};
  for (const pair of envPairs) {
    const split = pair.indexOf('=');
    if (split === -1) childEnv[pair] = '';
    else childEnv[pair.slice(0, split)] = pair.slice(split + 1);
  }
  const guarded = guardChildEnv(childEnv, parentEnv, registerUrl);
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
): unknown[] {
  const guarded = [...args];
  const index = optionsIndex(takesArgs, guarded);
  const options = isOptions(guarded[index]) ? guarded[index] : {};
  guarded[index] = { ...options, env: guardChildEnv(options.env ?? parentEnv, parentEnv, registerUrl) };
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
export function guardSpawnOptions(options: unknown, registerUrl: string): unknown {
  if (!isOptions(options)) return options;
  const { envPairs } = options as { envPairs?: unknown };
  if (!Array.isArray(envPairs)) return options;
  return { ...options, envPairs: guardEnvPairs(envPairs as string[], process.env, registerUrl) };
}

function guardAsyncSpawn(target: ChildProcessModule, registerUrl: string): void {
  const prototype = target.ChildProcess?.prototype;
  const original = prototype?.spawn;
  if (typeof original !== 'function' || isGuarded(original)) return;
  const spawnOriginal = original as AnyFunction;
  prototype.spawn = markGuarded(function (this: unknown, ...args: unknown[]) {
    args[0] = guardSpawnOptions(args[0], registerUrl);
    return spawnOriginal.apply(this, args);
  }, spawnOriginal);
}

function guardSyncExport(
  target: ChildProcessModule,
  name: 'spawnSync' | 'execSync' | 'execFileSync',
  registerUrl: string,
): void {
  const original = target[name];
  if (typeof original !== 'function' || isGuarded(original)) return;
  const takesArgs = name !== 'execSync';
  const syncOriginal = original as AnyFunction;
  target[name] = markGuarded(function (this: unknown, ...args: unknown[]) {
    return syncOriginal.apply(this, guardSyncArguments(takesArgs, args, process.env, registerUrl));
  }, syncOriginal);
}

/**
 * Start every child process of this process with the register at
 * `registerUrl` (see the module comment). `childProcess` defaults to
 * `node:child_process`; tests pass a stand-in.
 */
export function installChildProcessGuard(registerUrl: string, childProcess?: ChildProcessModule): void {
  const target = childProcess ?? (createRequire(import.meta.url)('node:child_process') as ChildProcessModule);
  guardAsyncSpawn(target, registerUrl);
  guardSyncExport(target, 'spawnSync', registerUrl);
  guardSyncExport(target, 'execSync', registerUrl);
  guardSyncExport(target, 'execFileSync', registerUrl);
  // ESM `import { spawnSync } from 'node:child_process'` reads the export as
  // synced, so publish the replacements there too.
  if (childProcess === undefined) Module.syncBuiltinESMExports();
}
