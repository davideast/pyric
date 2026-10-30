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
 *
 * The bundler config names only the wrappers. The loader finds `firebase`
 * when it runs, from the project root the bundler gives it, so a Next config
 * that calls `withPyric` from a shared package still resolves the app's own
 * install.
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

/** The loader's options: each wrapper's absolute path to the specifier whose import it rewrites. */
export interface BridgeImportOptions {
  wrappers: Record<string, string>;
}

/** Thrown when production AI mode cannot point a wrapper's import at the project's Firebase SDK. */
export class PyricNextBridgeError extends Error {
  override readonly name = 'PyricNextBridgeError';
}

const UNSUPPORTED_RESOLUTION = 'Pyric looks for node_modules/firebase from the project directory up; Yarn Plug\'n\'Play and NODE_PATH installs are not supported.';

/** This package's built loader, next to this module. */
export const BRIDGE_IMPORT_LOADER = fileURLToPath(new URL(`./bridge-import-loader${moduleExtension()}`, import.meta.url));

function moduleExtension(): string {
  return import.meta.url.endsWith('.ts') ? '.ts' : '.js';
}

/** The project's `firebase` package directory, found as Node finds a package from the project directory. */
function firebasePackageDir(projectDir: string): string {
  for (let dir = projectDir; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', 'firebase');
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
    if (dirname(dir) === dir) break;
  }
  throw new PyricNextBridgeError(
    `pyric: production AI mode needs the Firebase SDK, but no node_modules/firebase was found from ${projectDir} up. ${UNSUPPORTED_RESOLUTION}`,
  );
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

/**
 * The relative specifier a wrapper imports `specifier` by: the browser file
 * of the `firebase` that `projectDir` resolves. Throws
 * {@link PyricNextBridgeError} when there is none.
 */
export function bridgeImportTarget(wrapper: string, specifier: string, projectDir: string): string {
  const target = browserFile(firebasePackageDir(projectDir), specifier);
  const path = relative(dirname(wrapper), target).split(sep).join('/');
  return path.startsWith('.') ? path : `./${path}`;
}

/**
 * The wrappers of this install. Only imports {@link isBypassedBridgeImport}
 * names are listed, so this plane bypasses exactly what the others do.
 */
export function bridgeImportOptions(): BridgeImportOptions {
  const registerDir = fileURLToPath(new URL('../register/', import.meta.url));
  const wrappers: Record<string, string> = {};
  for (const [name, specifier] of BRIDGE_MODULES) {
    const wrapper = realpathSync(join(registerDir, `${name}${moduleExtension()}`));
    if (isBypassedBridgeImport(specifier, wrapper)) wrappers[wrapper] = specifier;
  }
  return { wrappers };
}

/** The options both bundler configs read: present only in production AI mode, as the environment names it. */
export function productionBridgeOptions(): BridgeImportOptions | undefined {
  const isProductionAiMode = resolveAiMode(undefined, process.env) === 'production';
  return isProductionAiMode ? bridgeImportOptions() : undefined;
}

/** The file names of the wrappers, for bundler rules keyed by name. */
export function bridgeModuleFileNames(): string[] {
  return BRIDGE_MODULES.map(([name]) => `${name}${moduleExtension()}`);
}
