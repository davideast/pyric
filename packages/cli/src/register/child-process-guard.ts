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
 * for the child keeps the caller's value. When the sandbox register is active
 * in this process, and the live register is not, the child also gets
 * `PYRIC_SANDBOX_FORCE=1` unless the caller set it, so a child started with
 * `NODE_ENV=production` stays in the sandbox instead of refusing it (#2340).
 * A process that is not registered, or is in live mode, adds no force.
 *
 * A shell the process starts passes the environment on, so a Node process the
 * shell starts is registered too, unless the command line it runs sets
 * `NODE_OPTIONS` itself (`NODE_OPTIONS=--max-old-space-size=4096 node
 * server.js`), which no code in this process can see.
 *
 * Every asynchronous child (`spawn`, `exec`, `execFile`, `fork`, and their
 * promisified forms) is built by `ChildProcess.prototype.spawn` from the env
 * Node has already resolved, so one wrapper there covers them. The
 * synchronous forms reach a native binding instead, so `spawnSync`,
 * `execSync` and `execFileSync` are wrapped where they are exported.
 */
import { realpathSync } from 'node:fs';
import Module, { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isLiveRegisterActive, isRegisterActive } from './activation.js';
import { isSameLocalFile } from './package-identity.js';

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

const BARE_REGISTER_NAMES = new Set(['@pyric/cli/register', '@pyric/live/register']);

interface NodeOptionWord {
  readonly value: string;
  readonly raw: string;
}

function tryRealpath(filePath: string): string {
  try {
    return realpathSync(filePath);
  } catch {
    return filePath;
  }
}

function isFilesystemPathSpecifier(specifier: string): boolean {
  return (
    specifier.startsWith('/') ||
    specifier.startsWith('./') ||
    specifier.startsWith('../') ||
    /^[A-Za-z]:[\\/]/.test(specifier)
  );
}

/**
 * Whether an `--import` target names Pyric's register (`registerUrl`), as a
 * `file:` URL, an OS filesystem path, or bare `@pyric/(cli|live)/register`.
 */
export function matchesRegisterSpecifier(specifier: string, registerUrl: string): boolean {
  if (specifier === registerUrl || BARE_REGISTER_NAMES.has(specifier)) return true;
  if (isSameLocalFile(specifier, registerUrl)) return true;
  if (!registerUrl.startsWith('file:') || !isFilesystemPathSpecifier(specifier)) return false;
  let registerFile: string;
  try {
    registerFile = fileURLToPath(registerUrl);
  } catch {
    return false;
  }
  const candidateFile = resolve(specifier);
  if (candidateFile === registerFile) return true;
  return tryRealpath(candidateFile) === tryRealpath(registerFile);
}

function tokenizeNodeOptions(nodeOptions: string): NodeOptionWord[] {
  const words: NodeOptionWord[] = [];
  let i = 0;
  while (i < nodeOptions.length) {
    while (i < nodeOptions.length && /\s/.test(nodeOptions[i]!)) i++;
    if (i >= nodeOptions.length) break;
    const start = i;
    let value = '';
    while (i < nodeOptions.length && !/\s/.test(nodeOptions[i]!)) {
      const ch = nodeOptions[i]!;
      if (ch === '"' || ch === "'") {
        const quote = ch;
        i++;
        while (i < nodeOptions.length && nodeOptions[i] !== quote) {
          if (nodeOptions[i] === '\\' && i + 1 < nodeOptions.length && quote === '"') {
            i++;
          }
          value += nodeOptions[i]!;
          i++;
        }
        if (i < nodeOptions.length) i++;
        continue;
      }
      if (ch === '\\' && i + 1 < nodeOptions.length) {
        value += nodeOptions[i + 1]!;
        i += 2;
        continue;
      }
      value += ch;
      i++;
    }
    words.push({ value, raw: nodeOptions.slice(start, i) });
  }
  return words;
}

/** Whether `nodeOptions` already loads the register (by URL, filesystem path, or package name). */
export function loadsRegister(nodeOptions: string, registerUrl: string): boolean {
  const words = tokenizeNodeOptions(nodeOptions);
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!.value;
    if (word === '--import' && i + 1 < words.length) {
      if (matchesRegisterSpecifier(words[i + 1]!.value, registerUrl)) return true;
      i++;
      continue;
    }
    if (word.startsWith('--import=')) {
      if (matchesRegisterSpecifier(word.slice('--import='.length), registerUrl)) return true;
    }
  }
  return false;
}

/**
 * Ensure `nodeOptions` loads `registerUrl` via its canonical `file:` URL,
 * rewriting any bare `@pyric/(cli|live)/register` or filesystem-path register
 * preload in place while preserving all other user options verbatim.
 */
export function withCanonicalRegisterNodeOptions(nodeOptions: string, registerUrl: string): string {
  const words = tokenizeNodeOptions(nodeOptions);
  const importFlag = `--import ${registerUrl}`;
  if (words.length === 0) return importFlag;

  const rewritten: string[] = [];
  let foundRegister = false;

  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    if (word.value === '--import' && i + 1 < words.length) {
      const nextWord = words[i + 1]!;
      if (matchesRegisterSpecifier(nextWord.value, registerUrl)) {
        if (!foundRegister) {
          rewritten.push('--import', registerUrl);
          foundRegister = true;
        }
        i++;
        continue;
      }
      rewritten.push(word.raw, nextWord.raw);
      i++;
      continue;
    }
    if (word.value.startsWith('--import=')) {
      const target = word.value.slice('--import='.length);
      if (matchesRegisterSpecifier(target, registerUrl)) {
        if (!foundRegister) {
          rewritten.push(`--import=${registerUrl}`);
          foundRegister = true;
        }
        continue;
      }
    }
    rewritten.push(word.raw);
  }

  if (!foundRegister) {
    return `${nodeOptions.trimEnd()} ${importFlag}`;
  }
  return rewritten.join(' ');
}

/**
 * Ensure a `Worker` `execArgv` array loads `registerUrl` via its canonical
 * `file:` URL, rewriting bare or filesystem-path register preloads in place.
 */
export function withCanonicalRegisterExecArgv(execArgv: readonly unknown[], registerUrl: string): unknown[] {
  const out: unknown[] = [];
  let foundRegister = false;
  for (let i = 0; i < execArgv.length; i++) {
    const item = execArgv[i];
    if (item === '--import' && i + 1 < execArgv.length && typeof execArgv[i + 1] === 'string') {
      const target = execArgv[i + 1] as string;
      if (matchesRegisterSpecifier(target, registerUrl)) {
        if (!foundRegister) {
          out.push('--import', registerUrl);
          foundRegister = true;
        }
        i++;
        continue;
      }
      out.push(item, target);
      i++;
      continue;
    }
    if (typeof item === 'string' && item.startsWith('--import=')) {
      const target = item.slice('--import='.length);
      if (matchesRegisterSpecifier(target, registerUrl)) {
        if (!foundRegister) {
          out.push(`--import=${registerUrl}`);
          foundRegister = true;
        }
        continue;
      }
    }
    out.push(item);
  }
  if (!foundRegister) {
    out.push('--import', registerUrl);
  }
  return out;
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
 * `env`.
 */
export function withInheritedSandbox(env: Env, parentEnv: Env, parentActive: boolean): Env {
  const guarded = withSandboxVariables(env, parentEnv);
  const forces = parentActive && !callerSetForce(env, parentEnv);
  if (forces) guarded.PYRIC_SANDBOX_FORCE = '1';
  return guarded;
}

/**
 * The environment to start a child with, so that it loads the register at
 * `registerUrl` in the sandbox `parentEnv` names. `parentActive` says whether
 * this process is a sandbox parent ({@link isSandboxParent}). Returns a new
 * object and never changes `childEnv`. `file:` URLs are percent-encoded, so
 * the import needs no quoting in `NODE_OPTIONS`.
 */
export function guardChildEnv(
  childEnv: Env,
  parentEnv: Env,
  registerUrl: string,
  parentActive: boolean = isSandboxParent(),
): Env {
  const guarded = withInheritedSandbox(childEnv, parentEnv, parentActive);
  guarded.NODE_OPTIONS = withCanonicalRegisterNodeOptions(guarded.NODE_OPTIONS ?? '', registerUrl);
  return guarded;
}

/** `envPairs` (`NAME=value` strings, as `ChildProcess.prototype.spawn` takes them) with the guarded env. */
export function guardEnvPairs(
  envPairs: readonly string[],
  parentEnv: Env,
  registerUrl: string,
  parentActive: boolean = isSandboxParent(),
): string[] {
  const childEnv: Env = {};
  for (const pair of envPairs) {
    const split = pair.indexOf('=');
    if (split === -1) childEnv[pair] = '';
    else childEnv[pair.slice(0, split)] = pair.slice(split + 1);
  }
  const guarded = guardChildEnv(childEnv, parentEnv, registerUrl, parentActive);
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
