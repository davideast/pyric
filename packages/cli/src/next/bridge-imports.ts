/**
 * The Next plane's form of the shadow-app and production AI SDK bypass (#1637,
 * ADR 0022 Ruling 7). In production AI mode `firebase/app` and
 * `firebase/app-check` alias to the passthrough entries, whose shadow-app
 * wrappers import the Firebase SDK under those same specifiers, while direct
 * application imports of `@firebase/*` remain aliased to `client-stop`.
 *
 * Webpack and Turbopack aliases apply to every importer, so here a loader
 * rewrites:
 * 1. the two `firebase/app` and `firebase/app-check` imports in Pyric's
 *    shadow-app wrappers, and
 * 2. internal `@firebase/*` imports inside `firebase/{ai,app,app-check}` and
 *    the six production AI `@firebase/*` packages (`isProductionAiSdkPackage`)
 * to relative paths to the project's own installed browser ESM files. Direct
 * app imports of `@firebase/app` or `@firebase/ai` never match this loader and
 * stay stopped.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { packageNameOf, pathInPackageOf } from '../register/package-identity.js';
import {
  isBypassedBridgeImport,
  isProductionAiSdkFile,
  isProductionAiSdkPackage,
  resolveAiMode,
} from '../serve/firebase-module-swap.js';

/** The shadow-app wrappers that import the Firebase SDK, by file name under `register/`, and the specifier each imports. */
const BRIDGE_MODULES: ReadonlyArray<readonly [name: string, specifier: string]> = [
  ['app-bridge-shadow', 'firebase/app'],
  ['app-bridge-app-check', 'firebase/app-check'],
];

/** Filename of browser ESM entry bundles across `firebase` and `@firebase/*`. */
const SDK_BROWSER_ESM_FILENAME = 'index.esm.js';

/** Matches installed `firebase` and `@firebase/*` JS modules in Webpack client rules. */
export const PRODUCTION_AI_SDK_FILE_PATTERN = /[\\/]node_modules[\\/](?:firebase|@firebase)[\\/].*\.[cm]?js$/;

/** The loader's options: each wrapper's absolute path to the specifier whose import it rewrites. */
export interface BridgeImportOptions {
  wrappers: Record<string, string>;
}

/** Thrown when production AI mode cannot point a wrapper's import at the project's Firebase SDK. */
export class PyricNextBridgeError extends Error {
  override readonly name = 'PyricNextBridgeError';
}

const UNSUPPORTED_RESOLUTION = "Pyric looks for node_modules/firebase from the project directory up; Yarn Plug'n'Play and NODE_PATH installs are not supported.";

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

interface ExportConditionMap {
  browser?: string | { import?: string; default?: string };
  import?: string | { default?: string };
  default?: string;
}

function pickBrowserExportTarget(entry: string | ExportConditionMap | undefined): string | undefined {
  if (typeof entry === 'string') return entry;
  if (entry === undefined || typeof entry !== 'object' || entry === null) return undefined;
  if (typeof entry.browser === 'string') return entry.browser;
  if (typeof entry.browser === 'object' && entry.browser !== null) {
    if (typeof entry.browser.import === 'string') return entry.browser.import;
    if (typeof entry.browser.default === 'string') return entry.browser.default;
  }
  if (typeof entry.import === 'string') return entry.import;
  if (typeof entry.import === 'object' && entry.import !== null && typeof entry.import.default === 'string') {
    return entry.import.default;
  }
  if (typeof entry.default === 'string') return entry.default;
  return undefined;
}

/** The browser ESM file `firebase/<subpath>` resolves to under a bundler's browser conditions. */
function browserFile(packageDir: string, specifier: string): string {
  const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as {
    exports?: Record<string, string | ExportConditionMap>;
  };
  const entry = manifest.exports?.[`./${specifier.slice('firebase/'.length)}`];
  const file = pickBrowserExportTarget(entry);
  if (file === undefined) {
    throw new PyricNextBridgeError(
      `pyric: production AI mode needs ${specifier} from the Firebase SDK, but ${join(packageDir, 'package.json')} exports no browser entry for it.`,
    );
  }
  return join(packageDir, file);
}

function scopedPackageDir(packageName: string, firebaseDir: string, projectDir: string): string | null {
  for (const startDir of [firebaseDir, dirname(firebaseDir), projectDir]) {
    for (let dir = startDir; ; dir = dirname(dir)) {
      const candidate = join(dir, 'node_modules', packageName);
      if (existsSync(join(candidate, 'package.json'))) {
        return realpathSync(candidate);
      }
      if (dirname(dir) === dir) break;
    }
  }
  return null;
}

function scopedBrowserEntryFile(packageDir: string): string | null {
  const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as {
    exports?: Record<string, string | ExportConditionMap>;
    module?: string;
    main?: string;
  };
  const fromExports = pickBrowserExportTarget(manifest.exports?.['.']);
  const rel = fromExports ?? manifest.module ?? manifest.main;
  if (rel === undefined) return null;
  const full = join(packageDir, rel);
  try {
    return realpathSync(full);
  } catch {
    return full;
  }
}

function toRelativeImport(fromFile: string, targetFile: string): string {
  const rel = relative(dirname(fromFile), targetFile).split(sep).join('/');
  if (rel.startsWith('.')) return rel;
  return `./${rel}`;
}

/**
 * The relative specifier a wrapper imports `specifier` by: the browser file
 * of the `firebase` that `projectDir` resolves. Throws
 * {@link PyricNextBridgeError} when there is none.
 */
export function bridgeImportTarget(wrapper: string, specifier: string, projectDir: string): string {
  const target = browserFile(firebasePackageDir(projectDir), specifier);
  return toRelativeImport(wrapper, target);
}

/**
 * Whether `filePath` is an installed browser file belonging to `firebase`
 * (`ai/`, `app/`, `app-check/`) or one of the `@firebase/*` packages allowed in
 * production AI mode (`isProductionAiSdkPackage`).
 */
export function isProductionAiClientSdkFile(filePath: string): boolean {
  const posix = filePath.replaceAll('\\', '/');
  if (!posix.includes('/node_modules/')) return false;
  const fileUrl = pathToFileURL(filePath).href;
  const pkgName = packageNameOf(fileUrl);
  if (pkgName === null) return false;
  if (isProductionAiSdkPackage(pkgName)) return true;
  return isProductionAiSdkFile(pkgName, () => pathInPackageOf(fileUrl, pkgName));
}

/**
 * Resolve an internal `@firebase/*` import inside the production AI SDK closure
 * to a relative browser-entry path, or `null` if not installed under `projectDir`.
 */
export function productionAiScopedTarget(
  importerFile: string,
  specifier: string,
  projectDir: string,
): string | null {
  if (!isProductionAiSdkPackage(specifier)) return null;
  const firebaseDir = firebasePackageDir(projectDir);
  const pkgDir = scopedPackageDir(specifier, firebaseDir, projectDir);
  if (pkgDir === null) return null;
  const targetFile = scopedBrowserEntryFile(pkgDir);
  if (targetFile === null) return null;
  return toRelativeImport(importerFile, targetFile);
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

/** The file names Turbopack runs {@link BRIDGE_IMPORT_LOADER} on in production AI mode. */
export function bridgeModuleFileNames(): string[] {
  return [
    ...BRIDGE_MODULES.map(([name]) => `${name}${moduleExtension()}`),
    SDK_BROWSER_ESM_FILENAME,
  ];
}
