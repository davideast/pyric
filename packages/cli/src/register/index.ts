/**
 * `@pyric/cli/register` — the Node substitution seam (adoption layer 2).
 *
 * Loaded via `node --import @pyric/cli/register` (which `pyric sandbox`
 * injects through NODE_OPTIONS), it makes the user's UNCHANGED `firebase-admin`
 * and `firebase` imports resolve to `pyric-admin` and `pyric`, every subpath 1:1,
 * and installs the sandbox-factory global that `pyric-admin`'s ambient
 * `initializeApp()` consumes.
 *
 * ACTIVATOR, NOT LOCATOR (adoption-experience design): activation is purely
 * the `PYRIC_SANDBOX` env var injected at invocation — never file presence,
 * never app code. Without it this module is INERT (import it freely; nothing
 * happens). Under `NODE_ENV=production` it REFUSES with one stderr line
 * unless `PYRIC_SANDBOX_FORCE=1`. On activation it logs one stderr line.
 *
 * Hooks API: `module.registerHooks` (sync, Node ≥ 22.15) intercepts BOTH
 * `require()` and `import`. On older 22.x it falls back to
 * `module.register()` (ESM-only) with a warning that CJS require() is not
 * rewritten.
 *
 * Swap or stop (ADR 0022, `./swap-or-stop.js`): an import that resolves into
 * the real `firebase-admin`, or into the real client SDK where the swap table
 * didn't choose it, throws `PYRIC_REAL_SDK_STOPPED` before the file loads.
 *
 * On activation it also installs the NETWORK GUARD (`./net-guard.js`), which
 * refuses egress from this process to live Google/Firebase endpoints, or only
 * reports it under `PYRIC_GUARD=warn`. See that module for the policy and the
 * `PYRIC_GUARD` and `PYRIC_GUARD_ALLOW` knobs. Whatever the guard mode, it
 * wraps `worker_threads.Worker` (`./worker-guard.js`) so every worker thread
 * loads this module as well, including those Node starts without preloads,
 * and gets the swap and the stop. It also wraps `child_process`
 * (`./child-process-guard.js`), so every child process starts with this
 * module in its `NODE_OPTIONS` and in this process's sandbox.
 *
 * Finally it emits the HANDSHAKE BEACON (`./beacon.js`): a fire-and-forget
 * `POST /__pyric/beacon` when the activator carries a bridge URL, plus a
 * stderr line when the developer asked for detail. That is how `pyric sandbox`
 * learns that interception actually reached this child rather than assuming
 * it did.
 */
import Module from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonicalFirebaseSpecifier, mapFirebaseSpecifier } from './mapping.js';
import { resolvesIntoPackage } from './package-identity.js';
import { markRegisterActive } from './activation.js';
import { createStopReporter, stopFor } from './swap-or-stop.js';
import { resolveEsmOnlySubpath } from './esm-exports.js';
import { NET_GUARD_GLOBAL, installNetGuard, parseGuardMode, type GuardMode } from './net-guard.js';
import { emitBeacon } from './beacon.js';
import { installWorkerGuard } from './worker-guard.js';
import { installChildProcessGuard } from './child-process-guard.js';
import { remoteSandbox } from '../remote/index.js';
import { resolveAiMode } from '../serve/firebase-module-swap.js';

/** The shared seam with pyric-admin's ambient init: a synchronous factory
 *  returning the lazy branded handle. `Symbol.for` so both packages agree
 *  without importing each other's types. */
const SANDBOX_FACTORY = Symbol.for('pyric.remote.sandboxFactory');

/** The seam with pyric-admin's App Check mirror: firebase-admin's verifier for tokens from Firebase (#1552). */
const APP_CHECK_FIREBASE_VERIFIER = Symbol.for('pyric.admin.appCheck.firebaseVerifier');

interface SyncResolveContext {
  parentURL?: string;
  conditions?: string[];
}
interface SyncResolveResult {
  url: string;
  format?: string | null;
  shortCircuit?: boolean;
}
type SyncResolve = (
  specifier: string,
  context: SyncResolveContext,
  nextResolve: (specifier: string, context?: SyncResolveContext) => SyncResolveResult,
) => SyncResolveResult;

/** `module.registerHooks` landed in Node 22.15 / 23.5 — feature-detect
 *  (typed locally: the repo's ambient node types predate it). */
const moduleApi = Module as unknown as {
  registerHooks?: (hooks: { resolve: SyncResolve }) => void;
  register?: (specifier: string | URL) => void;
  findPackageJSON?: (specifier: string, base: string | URL) => string | undefined;
};

/**
 * CJS→ESM seam: a rewritten `require()` fails against the pyric mirrors'
 * `import`-condition-only exports (the CJS resolver ignores hook-supplied
 * condition overrides), even though `require(esm)` can load them fine.
 * Locate the package from this installed CLI and resolve the subpath under
 * import conditions ourselves. The user's function package is not required
 * to install Pyric's mapped targets. Returns the resolved file URL, or null
 * to rethrow the original error.
 */
function resolveEsmOnlyForRequire(mapped: string): string | null {
  if (typeof moduleApi.findPackageJSON !== 'function') return null;
  // A scoped name (`@pyric/cli/register/client/app`) spans its first slash.
  const isScoped = mapped.startsWith('@');
  const slash = mapped.indexOf('/', isScoped ? mapped.indexOf('/') + 1 : 0);
  const pkgName = slash === -1 ? mapped : mapped.slice(0, slash);
  const subpath = slash === -1 ? '.' : `.${mapped.slice(slash)}`;
  let pkgJsonPath: string | undefined;
  try {
    pkgJsonPath = moduleApi.findPackageJSON(
      pkgName,
      import.meta.url,
    );
  } catch {
    return null;
  }
  if (!pkgJsonPath) return null;
  try {
    const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as { exports?: unknown };
    const target = resolveEsmOnlySubpath(pkg.exports, subpath);
    if (!target) return null;
    return pathToFileURL(join(dirname(pkgJsonPath), target)).href;
  } catch {
    return null;
  }
}

type NextSyncResolve = Parameters<SyncResolve>[2];

/** Resolve a mapped pyric target from this installed CLI. */
function resolveMapped(mapped: string, context: SyncResolveContext, nextResolve: NextSyncResolve): SyncResolveResult {
  try {
    return nextResolve(mapped, { ...context, parentURL: import.meta.url });
  } catch (err) {
    // CJS `require('firebase-admin/app')` resolves under the `require`
    // condition, but the pyric mirrors are ESM-only. Resolve the file
    // under import conditions ourselves — require(esm) (Node ≥ 22.12)
    // loads it fine once given the URL.
    const code = (err as { code?: string }).code;
    if (code === 'ERR_PACKAGE_PATH_NOT_EXPORTED' || code === 'MODULE_NOT_FOUND') {
      const url = resolveEsmOnlyForRequire(mapped);
      if (url) return { url, shortCircuit: true };
    }
    throw err;
  }
}

/**
 * The sync resolve hook. A canonical Firebase specifier maps directly. A
 * Turbopack-renamed one (`firebase-admin-<hash>/app`, #1443) resolves as
 * given first, and maps by its canonical name only when that landed in the
 * real package, so an unrelated package with such a name stays itself.
 */
const resolveFirebase: SyncResolve = (specifier, context, nextResolve) => {
  const canonical = canonicalFirebaseSpecifier(specifier);
  if (canonical === null) {
    const mapped = mapFirebaseSpecifier(specifier, context.parentURL);
    if (mapped === null) return nextResolve(specifier, context);
    return resolveMapped(mapped, context, nextResolve);
  }
  const renamed = nextResolve(specifier, context);
  const isRealFirebasePackage = resolvesIntoPackage(renamed.url, canonical);
  if (!isRealFirebasePackage) return renamed;
  const mapped = mapFirebaseSpecifier(canonical, context.parentURL);
  if (mapped === null) return renamed;
  return resolveMapped(mapped, context, nextResolve);
};

/**
 * Swap or stop (ADR 0022): a resolve that lands in the real `firebase-admin`,
 * or in the real client SDK where the swap table didn't choose it, throws
 * before the file loads, and the stop is written to stderr once per file. It
 * does not depend on the network guard, so `PYRIC_GUARD=off` keeps it.
 */
function withSwapOrStop(resolve: SyncResolve): SyncResolve {
  const report = createStopReporter((line) => void process.stderr.write(line));
  const allowedUrls = new Set<string>();
  return (specifier, context, nextResolve) => {
    const result = resolve(specifier, context, nextResolve);
    const stop = stopFor({
      specifier,
      canonical: canonicalFirebaseSpecifier(specifier),
      importer: context.parentURL,
      url: result.url,
    }, allowedUrls);
    if (stop === null) return result;
    report(stop);
    throw stop;
  };
}

function activate(): void {
  // FIRST, before any hook or global: the network guard.
  //
  // Order matters in one direction only. Everything after this line makes the
  // process load MORE code (the resolution hooks pull in the pyric mirrors,
  // the factory global pulls in the remote sandbox) and any of it could open
  // a socket. Installing the guard first leaves no window in which
  // sandbox-substituted code runs unguarded. The reverse ordering buys
  // nothing: the guard mutates globals only (`undici.globalDispatcher.*`,
  // `net`/`tls` connect, the Agent and Socket prototypes) and depends on
  // nothing the hooks establish.
  //
  // It stays BELOW the NODE_ENV=production refusal, deliberately. A refused
  // process is a real production run that we declined to touch, and warning
  // about its perfectly legitimate Google traffic, let alone blocking it,
  // would be actively harmful. `PYRIC_SANDBOX` plus no refusal is the only
  // state in which "traffic to live Google is a bug" is a true statement.
  const guard = installNetGuard();
  // Published so code that learns a destination later, such as the Vite
  // plugin's configured AI upstream, can permit it (`permitGuardHost`).
  if (guard !== null) (globalThis as unknown as Record<symbol, unknown>)[NET_GUARD_GLOBAL] = guard;
  // Built-ins and resolve hooks are per thread: every worker this process
  // starts loads this module too, including the kinds Node starts without
  // running preloads. Whatever PYRIC_GUARD says, since the worker's swap and
  // stop come from this module; the worker installs its own network guard, or
  // none under `off`, exactly as this thread does.
  installWorkerGuard(import.meta.url);
  // Child processes too (#1618): every child starts with this module in its
  // NODE_OPTIONS and with this process's PYRIC_* variables it lacks, so a
  // child of a registered process is registered whatever env it is given.
  installChildProcessGuard(import.meta.url);

  // Whether module resolution is actually being intercepted. Both branches
  // below install SOMETHING, but a runtime with neither API installs nothing,
  // which is precisely the state the beacon exists to make visible.
  let hooksInstalled = false;

  if (typeof moduleApi.registerHooks === 'function') {
    hooksInstalled = true;
    moduleApi.registerHooks({
      resolve: withSwapOrStop(resolveFirebase),
    });
  } else {
    process.stderr.write(
      '@pyric/cli/register: this Node version lacks module.registerHooks (needs >= 22.15). ' +
        'Falling back to module.register: ESM imports of firebase-admin/firebase are rewritten, ' +
        "but CJS require('firebase-admin') is NOT intercepted. Upgrade Node to >= 22.15 for full coverage.\n",
    );
    hooksInstalled = typeof moduleApi.register === 'function';
    moduleApi.register?.(new URL('./hooks.js', import.meta.url));
  }

  // The factory global — exact contract shared with pyric-admin's ambient
  // init: synchronous, returns the lazy branded handle. The url comes from
  // PYRIC_SANDBOX=remote:<url> and may be stale, so it is checked against
  // this project's host. A launcher that sets the url also pins the identity
  // of the host it started, so that url holds from any working directory.
  (globalThis as Record<symbol, unknown>)[SANDBOX_FACTORY] = (opts?: { url?: string }) =>
    remoteSandbox({ configuredUrl: opts?.url, instanceId: process.env.PYRIC_SANDBOX_INSTANCE });

  installAppCheckVerifier();

  process.stderr.write(
    `@pyric/cli/register: active. firebase-admin/firebase imports now resolve to the ` +
      `pyric sandbox (PYRIC_SANDBOX=${process.env.PYRIC_SANDBOX}).\n`,
  );

  // LAST: the handshake beacon, after the guard, the hooks and the factory
  // global are all in place. Its whole claim is "interception is live in this
  // process", so it must not be able to run before that is true. See
  // `./beacon.js` for the two channels and why the POST is fire-and-forget.
  emitBeacon({
    pid: process.pid,
    guard: installedGuardMode(guard),
    hooks: hooksInstalled,
    sandbox: process.env.PYRIC_SANDBOX ?? '',
  });
}

/**
 * Production AI mode only: the page's App Check tokens come from Firebase, so
 * pyric-admin's mirror hands them to firebase-admin's own verifier (#1552).
 * The bridge, and firebase-admin with it, loads on the first such token, so a
 * server that never verifies one never loads firebase-admin. In sandbox AI
 * mode nothing is installed, and the mirror refuses such a token with a
 * message that says why.
 */
function installAppCheckVerifier(): void {
  const isProductionAiMode = resolveAiMode(undefined, process.env) === 'production';
  if (!isProductionAiMode) return;
  (globalThis as Record<symbol, unknown>)[APP_CHECK_FIREBASE_VERIFIER] = async (token: string, projectId: string) => {
    const bridge = await import('./app-bridge-admin-app-check.js');
    return bridge.verifyFirebaseAppCheckToken(token, projectId);
  };
}

/**
 * The net-guard mode actually in force, for the beacon to report.
 *
 * Policy: the installed guard is the authority when there is one. There is no
 * guard object in exactly one case, `PYRIC_GUARD=off` (the `PYRIC_SANDBOX`
 * gate `installNetGuard` shares with this module has already passed by the
 * time it runs), and re-parsing the env is how that case names itself rather
 * than guessing a default.
 */
function installedGuardMode(guard: { mode: GuardMode } | null): GuardMode {
  if (guard !== null) return guard.mode;
  return parseGuardMode(process.env.PYRIC_GUARD);
}

/** Whether this process's firebase-admin/firebase imports are being rewritten
 *  to the pyric sandbox — true only when `PYRIC_SANDBOX` was set (and not
 *  refused by the production guard) at the moment this module loaded. */
export let active = false;

if (process.env.PYRIC_SANDBOX) {
  if (process.env.NODE_ENV === 'production' && process.env.PYRIC_SANDBOX_FORCE !== '1') {
    process.stderr.write(
      '@pyric/cli/register: refusing to activate under NODE_ENV=production — ' +
        'firebase-admin/firebase imports are NOT rewritten. ' +
        'Set PYRIC_SANDBOX_FORCE=1 to override (dev/CI only).\n',
    );
  } else {
    activate();
    active = true;
    markRegisterActive();
  }
}
// No PYRIC_SANDBOX → inert by design: importing this module rewrites nothing.
