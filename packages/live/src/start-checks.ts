/**
 * The checks every live mode start runs, from the `pyric-live` command, the
 * Vite entry and the register entry alike:
 *
 * - the app's installed `firebase` is in the range live mode supports, and
 * - one copy of `@firebase/app` is installed, so the app object Firestore,
 *   Auth, App Check and Realtime Database read is the one the app made.
 *
 * Either failure refuses the start with the reason: the version found, or the
 * path of every copy. Nothing here loads the SDK; it reads package.json files.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** The `firebase` versions live mode supports: the range pyric tests against. */
export const SUPPORTED_FIREBASE_RANGE = '^12.12.0';

const SUPPORTED_MAJOR = 12;
const LOWEST_MINOR = 12;
const RELEASE_VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

/** The `@firebase/*` packages a live row loads, each of which resolves its own `@firebase/app`. */
const ROW_PACKAGES = ['@firebase/app', '@firebase/auth', '@firebase/firestore', '@firebase/app-check', '@firebase/database', '@firebase/ai', '@firebase/storage'];

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

/**
 * The folder of package `name` as a module in `fromDir` finds it: the first
 * `node_modules/<name>` from `fromDir` up, by real path, or null. This is
 * Node's lookup for a bare specifier, done on the file system so a resolve
 * hook (the live register's own) never answers it.
 */
function resolvedPackageDir(name: string, fromDir: string): string | null {
  let dir = fromDir;
  for (;;) {
    const candidate = join(dir, 'node_modules', name);
    const isInstalled = existsSync(join(candidate, 'package.json'));
    if (isInstalled) return realpathSync(candidate);
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * The folder the app's `firebase` resolves from, for every live start check
 * and for the live rows of a Node process (`liveRegisterSdkRoot` in
 * `node-modules.ts`): the first of `appDirs`, the folders the app's modules
 * resolve from in order, that `firebase` resolves from, as Node loads it for
 * the app; else the project root. A workspace can install `firebase` only in
 * the app's folder, below the folder that holds `.firebaserc` or
 * `firebase.json` (#2161). A Node process passes its entry script's folder
 * first, then its working directory, so `node web/server.mjs` started from
 * the folder above finds the `firebase` in `web/` (#2166).
 */
export function appFirebaseRoot(appDirs: string | readonly string[], projectRoot: string): string {
  const candidates = typeof appDirs === 'string' ? [appDirs] : appDirs;
  return candidates.find((dir) => resolvedPackageDir('firebase', dir) !== null) ?? projectRoot;
}

/** The version of the `firebase` the folder resolves, or null when it has none. */
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

/** Whether `dir` is a repository root: it holds `.git`, a folder or, in a worktree, a file. */
function isRepositoryRoot(dir: string): boolean {
  return existsSync(join(dir, '.git'));
}

/**
 * The folders whose `node_modules` the project's modules can resolve from:
 * the project root and each folder above it, as Node's resolution walks, up
 * to the first one that is a repository root (it holds `.git`) or the
 * filesystem root. A copy in a parent folder that declares no workspaces
 * still resolves, so it counts.
 */
export function resolutionRoots(projectRoot: string): string[] {
  const roots: string[] = [];
  let dir = projectRoot;
  for (;;) {
    roots.push(dir);
    const parent = dirname(dir);
    const isLast = isRepositoryRoot(dir) || parent === dir;
    if (isLast) return roots;
    dir = parent;
  }
}

/**
 * Every installed copy of `@firebase/app`, by real path, sorted: each one in
 * the `node_modules` tree of the project and of every folder above it up to
 * the repository root (nested and pnpm-stored copies too), and the one each
 * live row's package resolves from the installed `firebase`.
 */
export function firebaseAppCopies(projectRoot: string): string[] {
  const found = new Set<string>();
  const visited = new Set<string>();
  for (const root of resolutionRoots(projectRoot)) walkNodeModules(join(root, 'node_modules'), 0, visited, found);
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

/** The no-firebase refusal's line: the folders it looked from, and where to start. */
function noFirebaseLine(searched: readonly string[]): string {
  const folders = searched.join(', ');
  return `This project has no firebase installed. None resolves from ${folders}. Start from the folder of the app that installs firebase.`;
}

function versionRefusal(version: string | null, searched: readonly string[]): string | null {
  const isSupported = version !== null && isSupportedFirebaseVersion(version);
  if (isSupported) return null;
  const found = version === null ? noFirebaseLine(searched) : `This project has firebase ${version} installed.`;
  return `${NOT_STARTED} @pyric/live needs firebase ${SUPPORTED_FIREBASE_RANGE}. ${found} ${INSTALL}`;
}

function copiesRefusal(copies: readonly string[]): string | null {
  const hasExtraCopies = copies.length > 1;
  if (!hasExtraCopies) return null;
  return [
    `${NOT_STARTED} @pyric/live needs one copy of @firebase/app, so that Firestore, Auth, App Check and Realtime Database read the app object your app made.`,
    `This project has ${copies.length} copies of @firebase/app installed:`,
    ...copies.map((copy) => `  ${copy}`),
    'Remove the extra copies, for example with npm dedupe, then start again.',
  ].join('\n');
}

/**
 * Why live mode refuses to start for the app whose modules resolve from
 * `appDirs` in the project in `projectRoot`, or null when both checks pass.
 * Both check the `firebase` the app loads (`appFirebaseRoot`). With none
 * installed, the refusal names every folder it looked from.
 */
export function liveStartRefusal(projectRoot: string, appDirs: string | readonly string[] = projectRoot): string | null {
  const sdkRoot = appFirebaseRoot(appDirs, projectRoot);
  const appFolders = typeof appDirs === 'string' ? [appDirs] : appDirs;
  const searched = [...new Set([...appFolders, projectRoot])];
  return versionRefusal(installedFirebaseVersion(sdkRoot), searched) ?? copiesRefusal(firebaseAppCopies(sdkRoot));
}
