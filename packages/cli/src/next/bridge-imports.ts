/**
 * The Next plane's form of the shadow-app bypass (#1637). In production AI
 * mode `firebase/app` and `firebase/app-check` alias to the passthrough
 * entries, whose shadow-app wrappers import the Firebase SDK under those same
 * specifiers. Vite and the register let those imports through by importer
 * (`isBypassedBridgeImport`). Webpack and Turbopack aliases apply to every
 * importer, so here a loader rewrites the two imports in the wrappers to
 * relative paths to the Firebase SDK's browser files in the project's own
 * `firebase` install. Nothing else of the SDK loads: the same three modules
 * Vite lets through.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isBypassedBridgeImport, resolveAiMode } from '../serve/firebase-module-swap.js';

/** The shadow-app wrappers that import the Firebase SDK, by file name under `register/`, and the specifier each imports. */
const BRIDGE_MODULES: ReadonlyArray<readonly [name: string, specifier: string]> = [
  ['app-bridge-shadow', 'firebase/app'],
  ['app-bridge-app-check', 'firebase/app-check'],
];

/** The loader's options: each wrapper's absolute path to the import it rewrites and the relative specifier it writes. */
export interface BridgeImportRewrites {
  rewrites: Record<string, { specifier: string; target: string }>;
}

/** Thrown when the project's `firebase` has no browser entry for a module the wrappers import. */
export class PyricNextBridgeError extends Error {
  override readonly name = 'PyricNextBridgeError';
}

/** This package's built loader, next to this module. */
export const BRIDGE_IMPORT_LOADER = fileURLToPath(new URL(`./bridge-import-loader${moduleExtension()}`, import.meta.url));

function moduleExtension(): string {
  return import.meta.url.endsWith('.ts') ? '.ts' : '.js';
}

/** The project's `firebase` package directory, found as Node finds a package from the project directory. */
function firebasePackageDir(projectDir: string): string | undefined {
  for (let dir = projectDir; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', 'firebase');
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
    if (dirname(dir) === dir) return undefined;
  }
}

/** The browser ESM file `firebase/<subpath>` resolves to under a bundler's browser conditions. */
function browserFile(packageDir: string, specifier: string): string {
  const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as {
    exports?: Record<string, { browser?: { import?: string }; default?: string }>;
  };
  const entry = manifest.exports?.[`./${specifier.slice('firebase/'.length)}`];
  const file = entry?.browser?.import ?? entry?.default;
  if (file === undefined) {
    throw new PyricNextBridgeError(
      `pyric: production AI mode needs ${specifier} from the Firebase SDK, but ${join(packageDir, 'package.json')} exports no browser entry for it.`,
    );
  }
  return join(packageDir, file);
}

function relativeSpecifier(fromFile: string, toFile: string): string {
  const path = relative(dirname(fromFile), toFile).split(sep).join('/');
  return path.startsWith('.') ? path : `./${path}`;
}

/**
 * The rewrites for the wrappers of this install, pointed at the `firebase`
 * that Next's project directory resolves, or undefined when it resolves
 * none. Only imports {@link isBypassedBridgeImport} names are rewritten, so
 * this plane bypasses exactly what the others do.
 */
export function bridgeImportRewrites(projectDir: string): BridgeImportRewrites | undefined {
  const packageDir = firebasePackageDir(projectDir);
  if (packageDir === undefined) return undefined;
  const registerDir = fileURLToPath(new URL('../register/', import.meta.url));
  const rewrites: BridgeImportRewrites['rewrites'] = {};
  for (const [name, specifier] of BRIDGE_MODULES) {
    const wrapper = realpathSync(join(registerDir, `${name}${moduleExtension()}`));
    if (!isBypassedBridgeImport(specifier, wrapper)) continue;
    rewrites[wrapper] = { specifier, target: relativeSpecifier(wrapper, browserFile(packageDir, specifier)) };
  }
  return { rewrites };
}

/**
 * The rewrites both bundler configs read: present only in production AI
 * mode, as the environment names it, and only when the project resolves a
 * `firebase` install.
 */
export function productionBridgeRewrites(projectDir: string): BridgeImportRewrites | undefined {
  const isProductionAiMode = resolveAiMode(undefined, process.env) === 'production';
  return isProductionAiMode ? bridgeImportRewrites(projectDir) : undefined;
}

/** The file names of the wrappers, for bundler rules keyed by name. */
export function bridgeModuleFileNames(): string[] {
  return BRIDGE_MODULES.map(([name]) => `${name}${moduleExtension()}`);
}
