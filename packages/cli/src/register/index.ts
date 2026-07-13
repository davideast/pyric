/**
 * `@pyric/cli/register` — the Node substitution seam (adoption layer 2).
 *
 * Loaded via `node --import @pyric/cli/register` (which `pyric dev` injects
 * through NODE_OPTIONS), it makes the user's UNCHANGED `firebase-admin` /
 * `firebase` imports resolve to `pyric-admin` / `pyric`, every subpath 1:1,
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
 */
import Module from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mapFirebaseSpecifier } from './mapping.js';
import { resolveEsmOnlySubpath } from './esm-exports.js';
import { remoteSandbox } from '../remote/index.js';

/** The shared seam with pyric-admin's ambient init: a synchronous factory
 *  returning the lazy branded handle. `Symbol.for` so both packages agree
 *  without importing each other's types. */
const SANDBOX_FACTORY = Symbol.for('pyric.remote.sandboxFactory');

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
 * Locate the package from the REQUIRING module and resolve the subpath under
 * import conditions ourselves. Returns the resolved file URL, or null to
 * rethrow the original error.
 */
function resolveEsmOnlyForRequire(mapped: string, parentURL: string | undefined): string | null {
  if (typeof moduleApi.findPackageJSON !== 'function') return null;
  const slash = mapped.indexOf('/');
  const pkgName = slash === -1 ? mapped : mapped.slice(0, slash);
  const subpath = slash === -1 ? '.' : `.${mapped.slice(slash)}`;
  let pkgJsonPath: string | undefined;
  try {
    pkgJsonPath = moduleApi.findPackageJSON(
      pkgName,
      parentURL ?? pathToFileURL(join(process.cwd(), 'noop.js')),
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

function activate(): void {
  if (typeof moduleApi.registerHooks === 'function') {
    moduleApi.registerHooks({
      resolve(specifier, context, nextResolve) {
        const mapped = mapFirebaseSpecifier(specifier);
        if (mapped === null) return nextResolve(specifier, context);
        try {
          return nextResolve(mapped, context);
        } catch (err) {
          // CJS `require('firebase-admin/app')` resolves under the `require`
          // condition, but the pyric mirrors are ESM-only. Resolve the file
          // under import conditions ourselves — require(esm) (Node ≥ 22.12)
          // loads it fine once given the URL.
          if ((err as { code?: string }).code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') {
            const url = resolveEsmOnlyForRequire(mapped, context.parentURL);
            if (url) return { url, shortCircuit: true };
          }
          throw err;
        }
      },
    });
  } else {
    process.stderr.write(
      '@pyric/cli/register: this Node version lacks module.registerHooks (needs >= 22.15) — ' +
        'falling back to module.register: ESM imports of firebase-admin/firebase are rewritten, ' +
        "but CJS require('firebase-admin') is NOT intercepted. Upgrade Node to >= 22.15 for full coverage.\n",
    );
    moduleApi.register?.(new URL('./hooks.js', import.meta.url));
  }

  // The factory global — exact contract shared with pyric-admin's ambient
  // init: synchronous, returns the lazy branded handle.
  (globalThis as Record<symbol, unknown>)[SANDBOX_FACTORY] = (opts?: { url?: string }) =>
    remoteSandbox(opts);

  process.stderr.write(
    `@pyric/cli/register: active — firebase-admin/firebase imports now resolve to the ` +
      `pyric sandbox (PYRIC_SANDBOX=${process.env.PYRIC_SANDBOX}).\n`,
  );
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
  }
}
// No PYRIC_SANDBOX → inert by design: importing this module rewrites nothing.
