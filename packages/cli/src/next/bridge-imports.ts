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
import { isBypassedBridgeImport } from '../serve/firebase-module-swap.js';

/** The shadow-app wrappers that import the Firebase SDK, by file name under `register/`, and the specifier each imports. */
const BRIDGE_MODULES: ReadonlyArray<readonly [name: string, specifier: string]> = [
  ['app-bridge-shadow', 'firebase/app'],
  ['app-bridge-app-check', 'firebase/app-check'],
];

/** The loader's options: each wrapper's absolute path to the import it rewrites and the relative specifier it writes. */
export interface BridgeImportRewrites {
  rewrites: Record<string, { specifier: string; target: string }>;
}

/** This package's built loader, next to this module. */
export const BRIDGE_IMPORT_LOADER = fileURLToPath(new URL(`./bridge-import-loader${moduleExtension()}`, import.meta.url));

function moduleExtension(): string {
  return import.meta.url.endsWith('.ts') ? '.ts' : '.js';
}

/** The project's `firebase` package directory, found as Node finds a package from the project root. */
function firebasePackageDir(projectRoot: string): string | undefined {
  for (let dir = projectRoot; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', 'firebase');
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
    if (dirname(dir) === dir) return undefined;
  }
}

/** The browser ESM file `firebase/<subpath>` resolves to under a bundler's browser conditions. */
function browserFile(packageDir: string, specifier: string): string | undefined {
  const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as {
    exports?: Record<string, { browser?: { import?: string }; default?: string }>;
  };
  const entry = manifest.exports?.[`./${specifier.slice('firebase/'.length)}`];
  const file = entry?.browser?.import ?? entry?.default;
  return file === undefined ? undefined : join(packageDir, file);
}

function relativeSpecifier(fromFile: string, toFile: string): string {
  const path = relative(dirname(fromFile), toFile).split(sep).join('/');
  return path.startsWith('.') ? path : `./${path}`;
}

/**
 * The rewrites for the wrappers of this install, or undefined when the
 * project has no `firebase` install to point them at. Only imports
 * {@link isBypassedBridgeImport} names are rewritten, so this plane bypasses
 * exactly what the others do.
 */
export function bridgeImportRewrites(projectRoot: string = process.cwd()): BridgeImportRewrites | undefined {
  const packageDir = firebasePackageDir(projectRoot);
  if (packageDir === undefined) return undefined;
  const registerDir = fileURLToPath(new URL('../register/', import.meta.url));
  const rewrites: BridgeImportRewrites['rewrites'] = {};
  for (const [name, specifier] of BRIDGE_MODULES) {
    const wrapper = realpathSync(join(registerDir, `${name}${moduleExtension()}`));
    const target = browserFile(packageDir, specifier);
    const isBypassed = isBypassedBridgeImport(specifier, wrapper);
    if (target === undefined || !isBypassed) continue;
    rewrites[wrapper] = { specifier, target: relativeSpecifier(wrapper, target) };
  }
  return { rewrites };
}

/** The file names of the wrappers, for bundler rules keyed by name. */
export function bridgeModuleFileNames(): string[] {
  return BRIDGE_MODULES.map(([name]) => `${name}${moduleExtension()}`);
}
