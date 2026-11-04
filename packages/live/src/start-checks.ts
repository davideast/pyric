/**
 * The checks every live mode start runs, from the `pyric-live` command, the
 * Vite entry and the register entry alike:
 *
 * - the app's installed `firebase` is in the range live mode supports, and
 * - one copy of `@firebase/app` is installed, so the app object Firestore,
 *   Auth and App Check read is the one the app made.
 *
 * Either failure refuses the start with the reason: the version found, or the
 * path of every copy. Nothing here loads the SDK; it reads package.json files.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/** The `firebase` versions live mode supports: the range pyric tests against. */
export const SUPPORTED_FIREBASE_RANGE = '^12.12.0';

const SUPPORTED_MAJOR = 12;
const LOWEST_MINOR = 12;
const RELEASE_VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

/** The `@firebase/*` packages a live row loads, each of which resolves its own `@firebase/app`. */
const ROW_PACKAGES = ['@firebase/app', '@firebase/auth', '@firebase/firestore', '@firebase/app-check'];

/** How deep the walk follows nested `node_modules` folders. */
const MAX_NESTING = 8;

/** Whether `version` is a release in {@link SUPPORTED_FIREBASE_RANGE}. A prerelease is not. */
export function isSupportedFirebaseVersion(version: string): boolean {
  const parts = RELEASE_VERSION.exec(version);
  if (parts === null) return false;
  const major = Number(parts[1]);
  const minor = Number(parts[2]);
  return major === SUPPORTED_MAJOR && minor >= LOWEST_MINOR;
}

function readVersion(packageJson: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(packageJson, 'utf8')) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}

/** The folder of `name` as a module in `fromDir` resolves it, or null when it does not resolve. */
function resolvedPackageDir(name: string, fromDir: string): string | null {
  try {
    const require = createRequire(join(fromDir, 'package.json'));
    return realpathSync(dirname(require.resolve(`${name}/package.json`)));
  } catch {
    return null;
  }
}

/** The version of the `firebase` the project root resolves, or null when it has none. */
export function installedFirebaseVersion(projectRoot: string): string | null {
  const dir = resolvedPackageDir('firebase', projectRoot);
  if (dir === null) return null;
  return readVersion(join(dir, 'package.json'));
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function entriesOf(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Walks one `node_modules` folder and every one nested in it, adding each `@firebase/app` found. */
function walkNodeModules(dir: string, depth: number, visited: Set<string>, found: Set<string>): void {
  const isTooDeep = depth > MAX_NESTING;
  if (isTooDeep || !isDirectory(dir)) return;
  const real = realpathSync(dir);
  if (visited.has(real)) return;
  visited.add(real);
  for (const entry of entriesOf(dir)) {
    if (entry === '.bin') continue;
    const isPnpmStore = entry === '.pnpm';
    if (isPnpmStore) {
      for (const stored of entriesOf(join(dir, entry))) walkNodeModules(join(dir, entry, stored, 'node_modules'), depth + 1, visited, found);
      continue;
    }
    const isScope = entry.startsWith('@');
    const packageDirs = isScope ? entriesOf(join(dir, entry)).map((name) => join(dir, entry, name)) : [join(dir, entry)];
    for (const packageDir of packageDirs) {
      const isAppCopy = packageDir === join(dir, '@firebase', 'app') && existsSync(join(packageDir, 'package.json'));
      if (isAppCopy) found.add(realpathSync(packageDir));
      walkNodeModules(join(packageDir, 'node_modules'), depth + 1, visited, found);
    }
  }
}

/**
 * Every installed copy of `@firebase/app`, by real path, sorted: each one in
 * the project's `node_modules` tree (nested and pnpm-stored copies too), and
 * the one each live row's package resolves from the installed `firebase`,
 * wherever a workspace hoisted it.
 */
export function firebaseAppCopies(projectRoot: string): string[] {
  const found = new Set<string>();
  walkNodeModules(join(projectRoot, 'node_modules'), 0, new Set(), found);
  const firebaseDir = resolvedPackageDir('firebase', projectRoot);
  if (firebaseDir !== null) {
    for (const name of ROW_PACKAGES) {
      const packageDir = resolvedPackageDir(name, firebaseDir);
      if (packageDir === null) continue;
      const appDir = name === '@firebase/app' ? packageDir : resolvedPackageDir('@firebase/app', packageDir);
      if (appDir !== null) found.add(appDir);
    }
  }
  return [...found].sort();
}

const NOT_STARTED = 'Live mode did not start.';
const INSTALL = `Install a supported version with: npm install firebase@${SUPPORTED_FIREBASE_RANGE}`;

function versionRefusal(version: string | null): string | null {
  const isSupported = version !== null && isSupportedFirebaseVersion(version);
  if (isSupported) return null;
  const found = version === null ? 'This project has no firebase installed.' : `This project has firebase ${version} installed.`;
  return `${NOT_STARTED} @pyric/live needs firebase ${SUPPORTED_FIREBASE_RANGE}. ${found} ${INSTALL}`;
}

function copiesRefusal(copies: readonly string[]): string | null {
  const hasExtraCopies = copies.length > 1;
  if (!hasExtraCopies) return null;
  return [
    `${NOT_STARTED} @pyric/live needs one copy of @firebase/app, so that Firestore, Auth and App Check read the app object your app made.`,
    `This project has ${copies.length} copies of @firebase/app installed:`,
    ...copies.map((copy) => `  ${copy}`),
    'Remove the extra copies, for example with npm dedupe, then start again.',
  ].join('\n');
}

/** Why live mode refuses to start in `projectRoot`, or null when both checks pass. */
export function liveStartRefusal(projectRoot: string): string | null {
  return versionRefusal(installedFirebaseVersion(projectRoot)) ?? copiesRefusal(firebaseAppCopies(projectRoot));
}
