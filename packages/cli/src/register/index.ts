/**
 * `@pyric/cli/register` -- the Node substitution seam (adoption layer 2).
 *
 * Loaded via `node --import @pyric/cli/register` (which `pyric sandbox`
 * injects through NODE_OPTIONS), it makes the user's UNCHANGED `firebase-admin`
 * and served `firebase/*` imports resolve to `pyric-admin` and `pyric`,
 * and installs the sandbox-factory global that `pyric-admin`'s ambient
 * `initializeApp()` consumes.
 *
 * ACTIVATOR, NOT LOCATOR (adoption-experience design): activation is purely
 * the `PYRIC_SANDBOX` env var injected at invocation -- never file presence,
 * never app code. Without it this module is INERT (import it freely; nothing
 * happens). Under `NODE_ENV=production` it REFUSES with one stderr line
 * unless `PYRIC_SANDBOX_FORCE=1`. On activation it logs one stderr line.
 *
 * Hooks API: `module.registerHooks` (sync, Node >= 22.15) intercepts BOTH
 * `require()` and `import`. Non-Node runtimes (`bun --preload`, `deno`) throw
 * `PYRIC_UNSUPPORTED_RUNTIME`, and older Node versions without
 * `module.registerHooks` throw `PYRIC_UNSUPPORTED_NODE_VERSION` rather than
 * running with unswapped imports (ADR 0023, #1624).
 *
 * Swap or stop (ADR 0022, ADR 0023, `./swap-or-stop.js`): an import that
 * resolves into the real `firebase-admin`, or into the real client SDK where
 * the swap table didn't choose it (including unserved `firebase/*` subpaths),
 * throws `PYRIC_REAL_SDK_STOPPED` before the file loads.
 *
 * On activation it wraps `worker_threads.Worker` (`./worker-guard.js`) so
 * every worker thread loads this module as well, including those Node starts
 * without preloads, and gets the swap and the stop. It also wraps
 * `child_process` (`./child-process-guard.js`), so every child process starts
 * with this module in its `NODE_OPTIONS` and in this process's sandbox.
 *
 * Its HTTP servers answer a loopback process-health request on
 * `/__pyric/health` as a sandbox process (`./process-health.js`), unless
 * `PYRIC_PROCESS_HEALTH=off`.
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
import { isLiveRegisterActive, isRegisterActive, markRegisterActive } from './activation.js';
import {
  createStopReporter,
  isImportCondition,
  isUnservedFirebaseImport,
  stopFor,
  unservedFirebaseSubpathStop,
} from './swap-or-stop.js';
import { resolveEsmOnlySubpath } from './esm-exports.js';
import { warnDeprecatedGuardEnvOnce } from './deprecated-guard-env.js';
import { requireNodeRuntime, requireRegisterHooks } from './node-version-stop.js';
import { emitBeacon } from './beacon.js';
import { installWorkerGuard } from './worker-guard.js';
import { installChildProcessGuard, pinInheritedVariables } from './child-process-guard.js';
import { installRemotePeerMark } from './remote-peer-mark.js';
import { installProcessHealth, sandboxHost } from './process-health.js';
import { liveAppDirs } from './live-package.js';
import { remoteSandbox } from '../remote/index.js';
import { isBypassedBridgeImport, resolveAiMode, type AiMode } from '../serve/firebase-module-swap.js';

/** The shared seam with pyric-admin's ambient init: a synchronous factory
 *  returning the lazy branded handle. `Symbol.for` so both packages agree
 *  without importing each other's types. */
const SANDBOX_FACTORY = Symbol.for('pyric.remote.sandboxFactory');

/** The seam with pyric-admin's App Check mirror: firebase-admin's verifier for tokens from Firebase (#1552). */
const APP_CHECK_FIREBASE_VERIFIER = Symbol.for('pyric.admin.appCheck.firebaseVerifier');

interface SyncResolveContext {
  parentURL?: string;
  conditions?: unknown;
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

/** `module.registerHooks` landed in Node 22.15 / 23.5 -- feature-detect
 *  (typed locally: the repo's ambient node types predate it). */
const moduleApi = Module as unknown as {
  registerHooks?: (hooks: { resolve: SyncResolve }) => void;
  findPackageJSON?: (specifier: string, base: string | URL) => string | undefined;
};

function errorCodeOf(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err && typeof err.code === 'string') {
    return err.code;
  }
  return undefined;
}

function isMissingResolutionCode(code: string | undefined): boolean {
  return (
    code === 'ERR_MODULE_NOT_FOUND' ||
    code === 'MODULE_NOT_FOUND' ||
    code === 'ERR_PACKAGE_PATH_NOT_EXPORTED'
  );
}

/**
 * CJS->ESM seam: a rewritten `require()` fails against the pyric mirrors'
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
    pkgJsonPath = moduleApi.findPackageJSON(pkgName, import.meta.url);
  } catch (err) {
    if (err instanceof Error) return null;
    throw err;
  }
  if (!pkgJsonPath) return null;
  try {
    const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as { exports?: unknown };
    const target = resolveEsmOnlySubpath(pkg.exports, subpath);
    if (!target) return null;
    return pathToFileURL(join(dirname(pkgJsonPath), target)).href;
  } catch (err) {
    if (err instanceof Error) return null;
    throw err;
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
    // under import conditions ourselves -- require(esm) (Node >= 22.12)
    // loads it fine once given the URL.
    const code = errorCodeOf(err);
    if (code === 'ERR_PACKAGE_PATH_NOT_EXPORTED' || code === 'MODULE_NOT_FOUND') {
      const url = resolveEsmOnlyForRequire(mapped);
      if (url) return { url, shortCircuit: true };
    }
    throw err;
  }
}

/**
 * Host-binding and launcher variables pinned alongside `PYRIC_SANDBOX` when
 * `@pyric/cli/register` activates, matching `PROTECTED_LAUNCHER_ENV_KEYS`.
 */
const PINNED_SANDBOX_OPTIONAL_KEYS = [
  'PYRIC_SANDBOX_INSTANCE',
  'PYRIC_BEACON_TOKEN',
  'PYRIC_SESSION_TOKEN',
  'PYRIC_WORKER_INIT',
  'PYRIC_WORKER_INIT_HOST',
] as const;

function buildPinnedSandboxEnv(
  activatedSandbox: string,
  activatedAiMode: AiMode,
  env: NodeJS.ProcessEnv,
): Record<string, string> {
  const passThrough = activatedAiMode === 'production' && env.PYRIC_AI_PASSTHROUGH === '1';
  const pinned: Record<string, string> = {
    PYRIC_SANDBOX: activatedSandbox,
    PYRIC_AI_MODE: activatedAiMode,
    PYRIC_AI_PASSTHROUGH: passThrough ? '1' : '',
  };
  for (const key of PINNED_SANDBOX_OPTIONAL_KEYS) {
    const value = env[key];
    if (value !== undefined && value !== '') {
      pinned[key] = value;
    }
  }
  return pinned;
}

const CLI_PACKAGE_ROOT_URL = new URL('../../', import.meta.url).href;

function isExternalFileImporter(parentUrl: string | undefined): parentUrl is string {
  if (parentUrl === undefined || !parentUrl.startsWith('file:')) {
    return false;
  }
  return !parentUrl.startsWith(CLI_PACKAGE_ROOT_URL);
}

const MAX_APP_IMPORTER_URLS = 64;

function recordExternalImporter(importers: string[], parentUrl: string | undefined): void {
  if (!isExternalFileImporter(parentUrl)) {
    return;
  }
  const existingIndex = importers.indexOf(parentUrl);
  if (existingIndex !== -1) {
    importers.splice(existingIndex, 1);
  }
  importers.push(parentUrl);
  if (importers.length > MAX_APP_IMPORTER_URLS) {
    importers.shift();
  }
}

function resolveBypassedFromAppTree(
  specifier: string,
  context: SyncResolveContext,
  nextResolve: NextSyncResolve,
  appImporterUrls: readonly string[],
): SyncResolveResult {
  // Capture before trying candidate parentURLs: Node's customization_hooks
  // mutates `context` in place whenever `nextResolve` receives a replacement.
  const originalParentUrl = context.parentURL;
  let originalConditionsArray: unknown[] | undefined;
  let originalConditionsScalar: unknown;
  const hasOriginalConditions = context.conditions !== undefined;
  if (Array.isArray(context.conditions)) {
    originalConditionsArray = [...context.conditions];
  } else if (hasOriginalConditions) {
    originalConditionsScalar = context.conditions;
  }
  const candidates: string[] = [];
  const seen = new Set<string>();
  const addCandidate = (url: string | undefined): void => {
    if (url === undefined || seen.has(url)) return;
    seen.add(url);
    candidates.push(url);
  };
  for (let index = appImporterUrls.length - 1; index >= 0; index -= 1) {
    addCandidate(appImporterUrls[index]);
  }
  for (const appDir of liveAppDirs(process.argv[1], process.cwd())) {
    addCandidate(pathToFileURL(join(appDir, 'package.json')).href);
  }
  for (const parentUrl of candidates) {
    const candidateContext: SyncResolveContext = { parentURL: parentUrl };
    if (originalConditionsArray !== undefined) {
      candidateContext.conditions = [...originalConditionsArray];
    } else if (hasOriginalConditions) {
      candidateContext.conditions = originalConditionsScalar;
    }
    try {
      return nextResolve(specifier, candidateContext);
    } catch (err) {
      if (!isMissingResolutionCode(errorCodeOf(err))) {
        throw err;
      }
      // Try the next candidate before falling back to the bridge module's own parentURL.
    }
  }
  const fallbackContext: SyncResolveContext = {};
  if (originalParentUrl !== undefined) {
    fallbackContext.parentURL = originalParentUrl;
  }
  if (originalConditionsArray !== undefined) {
    fallbackContext.conditions = [...originalConditionsArray];
  } else if (hasOriginalConditions) {
    fallbackContext.conditions = originalConditionsScalar;
  }
  return nextResolve(specifier, fallbackContext);
}

/**
 * The sync resolve hook. A canonical Firebase specifier maps directly. A
 * Turbopack-renamed one (`firebase-admin-<hash>/app`, #1443) resolves as
 * given first, and maps by its canonical name only when that landed in the
 * real package, so an unrelated package with such a name stays itself.
 */
function createResolveFirebase(activatedSandbox: string, activatedAiMode: AiMode): SyncResolve {
  const appImporterUrls: string[] = [];
  return (specifier, context, nextResolve) => {
    const isEsmImport = isImportCondition(context.conditions);
    const mapOptions = {
      sandbox: activatedSandbox,
      aiMode: activatedAiMode,
      isEsmImport,
    };
    const isBridgeBypass =
      isEsmImport && isBypassedBridgeImport(specifier, context.parentURL, activatedAiMode);
    if (isBridgeBypass) {
      return resolveBypassedFromAppTree(specifier, context, nextResolve, appImporterUrls);
    }
    const canonical = canonicalFirebaseSpecifier(specifier);
    if (canonical === null) {
      const mapped = mapFirebaseSpecifier(specifier, context.parentURL, mapOptions);
      if (mapped === null) {
        if (activatedAiMode === 'production' && specifier === 'firebase/ai') {
          if (isExternalFileImporter(context.parentURL)) {
            recordExternalImporter(appImporterUrls, context.parentURL);
          } else if (isEsmImport) {
            return resolveBypassedFromAppTree(specifier, context, nextResolve, appImporterUrls);
          }
        }
        return nextResolve(specifier, context);
      }
      recordExternalImporter(appImporterUrls, context.parentURL);
      return resolveMapped(mapped, context, nextResolve);
    }
    const renamed = nextResolve(specifier, context);
    const isRealFirebasePackage = resolvesIntoPackage(renamed.url, canonical);
    if (!isRealFirebasePackage) return renamed;
    const mapped = mapFirebaseSpecifier(canonical, context.parentURL, mapOptions);
    if (mapped === null) return renamed;
    recordExternalImporter(appImporterUrls, context.parentURL);
    return resolveMapped(mapped, context, nextResolve);
  };
}

/**
 * Swap or stop (ADR 0022): a resolve that lands in the real `firebase-admin`,
 * or in the real client SDK where the swap table didn't choose it, throws
 * before the file loads, and the stop is written to stderr once per file.
 */
function withSwapOrStop(resolve: SyncResolve, activatedAiMode: AiMode): SyncResolve {
  const report = createStopReporter((line) => void process.stderr.write(line));
  const allowedUrls = new Set<string>();
  return (specifier, context, nextResolve) => {
    // Capture caller context before resolve(): Node's customization_hooks
    // mutates context in place when nextResolve receives a replacement parentURL.
    const importer = context.parentURL;
    const isEsmImport = isImportCondition(context.conditions);
    const canonical = canonicalFirebaseSpecifier(specifier);
    const effectiveSpecifier = canonical ?? specifier;
    let result: SyncResolveResult;
    try {
      result = resolve(specifier, context, nextResolve);
    } catch (err) {
      if (isMissingResolutionCode(errorCodeOf(err)) && isUnservedFirebaseImport(effectiveSpecifier)) {
        const unservedStop = unservedFirebaseSubpathStop(specifier, importer, effectiveSpecifier);
        report(unservedStop);
        throw unservedStop;
      }
      throw err;
    }
    const stop = stopFor({
      specifier,
      canonical,
      importer,
      url: result.url,
      aiMode: activatedAiMode,
      isEsmImport,
    }, allowedUrls);
    if (stop === null) return result;
    report(stop);
    throw stop;
  };
}

function activate(activatedSandbox: string): void {
  const writeStderr = (line: string): void => {
    process.stderr.write(line);
  };
  warnDeprecatedGuardEnvOnce(process.env);
  requireNodeRuntime(
    '@pyric/cli/register',
    process.versions,
    (globalThis as { Deno?: unknown }).Deno,
    writeStderr,
  );
  const registerHooks = requireRegisterHooks(
    moduleApi.registerHooks?.bind(Module),
    '@pyric/cli/register',
    process.versions.node,
    writeStderr,
  );
  const activatedInstance = process.env.PYRIC_SANDBOX_INSTANCE;
  const activatedAiMode = resolveAiMode(undefined, process.env);
  // Pin the sandbox activator, AI mode, and host-binding variables so mutating
  // or deleting `process.env` in the parent cannot drop sandbox enforcement or
  // switch AI mode in-process or in child processes and worker threads.
  pinInheritedVariables(buildPinnedSandboxEnv(activatedSandbox, activatedAiMode, process.env));
  // Built-ins and resolve hooks are per thread: every worker this process
  // starts loads this module too, including the kinds Node starts without
  // running preloads, so the worker gets the swap and the stop.
  installWorkerGuard(import.meta.url);
  // Child processes too (#1618): every child starts with this module in its
  // NODE_OPTIONS and with this process's PYRIC_* variables it lacks, so a
  // child of a registered process is registered whatever env it is given.
  installChildProcessGuard(import.meta.url);
  // A server in this process may forward to the host; keep its clients' peer visible.
  installRemotePeerMark();
  // Its servers say this is a sandbox process, so a proxy check can catch a live page in front of it.
  installProcessHealth(() => ({
    mode: 'sandbox',
    instanceId: activatedInstance,
    host: sandboxHost(activatedSandbox),
  }));

  registerHooks({
    resolve: withSwapOrStop(createResolveFirebase(activatedSandbox, activatedAiMode), activatedAiMode),
  });

  // The factory global -- exact contract shared with pyric-admin's ambient
  // init: synchronous, returns the lazy branded handle. The url comes from
  // PYRIC_SANDBOX=remote:<url> and may be stale, so it is checked against
  // this project's host. A launcher that sets the url also pins the identity
  // of the host it started, so that url holds from any working directory.
  (globalThis as Record<symbol, unknown>)[SANDBOX_FACTORY] = (opts?: { url?: string }) =>
    remoteSandbox({ configuredUrl: opts?.url, instanceId: activatedInstance });

  installAppCheckVerifier(activatedAiMode);

  process.stderr.write(
    `@pyric/cli/register: active. firebase-admin/firebase imports now resolve to the ` +
      `pyric sandbox (PYRIC_SANDBOX=${activatedSandbox}).\n`,
  );

  // LAST: the handshake beacon, after the hooks and the factory global are all
  // in place. Its whole claim is "interception is live in this process", so it
  // must not be able to run before that is true. See `./beacon.js` for the two
  // channels and why the POST is fire-and-forget.
  emitBeacon({
    pid: process.pid,
    hooks: true,
    sandbox: activatedSandbox,
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
function installAppCheckVerifier(activatedAiMode: AiMode): void {
  if (activatedAiMode !== 'production') return;
  (globalThis as Record<symbol, unknown>)[APP_CHECK_FIREBASE_VERIFIER] = async (token: string, projectId: string) => {
    const bridge = await import('./app-bridge-admin-app-check.js');
    return bridge.verifyFirebaseAppCheckToken(token, projectId);
  };
}

/** Whether this process's firebase-admin/firebase imports are being rewritten
 *  to the pyric sandbox -- true only when `PYRIC_SANDBOX` was set (and not
 *  refused by the production guard) at the moment this module loaded. */
export let active = false;

const activatedSandbox = process.env.PYRIC_SANDBOX;
if (activatedSandbox) {
  if (isRegisterActive()) {
    active = true;
  } else if (isLiveRegisterActive()) {
    // Live mode already resolves Firebase to the installed SDK in this
    // process; a second set of hooks would send it to the sandbox instead.
    process.stderr.write(
      '@pyric/cli/register: not activating, because @pyric/live/register is active in this process. ' +
        'Start it with one of the two.\n',
    );
  } else if (process.env.NODE_ENV === 'production' && process.env.PYRIC_SANDBOX_FORCE !== '1') {
    process.stderr.write(
      '@pyric/cli/register: refusing to activate under NODE_ENV=production -- ' +
        'firebase-admin/firebase imports are NOT rewritten. ' +
        'Set PYRIC_SANDBOX_FORCE=1 to override (dev/CI only).\n',
    );
  } else {
    activate(activatedSandbox);
    active = true;
    markRegisterActive();
  }
}
// No PYRIC_SANDBOX -> inert by design: importing this module rewrites nothing.
