/**
 * Which installed package a resolved module file belongs to (#1443).
 *
 * Turbopack links `.next/node_modules/firebase-admin-<16 hex>` to the
 * installed `firebase-admin`, so a renamed import's name says what it probably
 * is. The register maps it only once the resolved file proves it: the nearest
 * `package.json` with a `name`, read from disk. Reading the file rather than
 * resolving `<pkg>/package.json` works for packages whose `exports` hide it,
 * and under store layouts (bun, pnpm) where the link points into `.bun/` or
 * `.pnpm/`.
 *
 * Nameless `package.json` files are skipped: `firebase-admin/lib/esm` has one
 * that only sets `"type": "module"`. A subpath manifest such as
 * `firebase/firestore/package.json` (`"name": "firebase/firestore"`) names its
 * package root, `firebase`.
 *
 * Loaded by both resolve hooks, including the loader-thread one, so it imports
 * node built-ins only and has no side effects.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Strips query and hash parameters (such as `?iitm=true`) from a `file:` URL.
 * Non-`file:` URLs and unparseable file URLs are returned unchanged.
 */
export function canonicalFileUrl(url: string): string {
  if (!url.startsWith('file:')) return url;
  try {
    return pathToFileURL(fileURLToPath(url)).href;
  } catch {
    return url;
  }
}

/** Whether two `file:` URLs name the same local file path, ignoring query or hash suffixes. */
export function isSameLocalFile(first: string, second: string): boolean {
  if (!first.startsWith('file:') || !second.startsWith('file:')) return false;
  try {
    return fileURLToPath(first) === fileURLToPath(second);
  } catch {
    return false;
  }
}

/** Package name per directory, `null` for a directory with no named manifest. */
const namesByDirectory = new Map<string, string | null>();

/** Package root directory per directory, `null` for a directory outside any named package. */
const rootDirsByDirectory = new Map<string, string | null>();

/** `firebase/firestore` → `firebase`; `@scope/pkg/sub` → `@scope/pkg`. */
function packageRoot(name: string): string {
  const parts = name.split('/');
  const isScoped = name.startsWith('@');
  const rootLength = isScoped ? 2 : 1;
  return parts.slice(0, rootLength).join('/');
}

/** The `name` of `<directory>/package.json` as written, or `null` when there is none. */
function writtenManifestName(directory: string): string | null {
  try {
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as { name?: unknown };
    const hasName = typeof manifest.name === 'string' && manifest.name !== '';
    return hasName ? (manifest.name as string) : null;
  } catch {
    return null;
  }
}

/** The package `<directory>/package.json` names, or `null` when it names none. */
function manifestName(directory: string): string | null {
  const written = writtenManifestName(directory);
  return written === null ? null : packageRoot(written);
}

function nameFromDirectory(directory: string): string | null {
  const cached = namesByDirectory.get(directory);
  if (cached !== undefined) return cached;
  const parent = dirname(directory);
  const isFilesystemRoot = parent === directory;
  let name = manifestName(directory);
  const looksFurtherUp = name === null && !isFilesystemRoot;
  if (looksFurtherUp) name = nameFromDirectory(parent);
  namesByDirectory.set(directory, name);
  return name;
}

/**
 * The package `<directory>/package.json` names, or `null` when it names none,
 * without looking further up. `withPyric` reads each installed package's own
 * name this way (#1626), so a nameless manifest never takes a parent's name.
 */
export function manifestNameAt(directory: string): string | null {
  return manifestName(directory);
}

/** The package a resolved module URL belongs to, or `null` for a URL outside any named package. */
export function packageNameOf(url: string): string | null {
  const isFileUrl = url.startsWith('file:');
  if (!isFileUrl) return null;
  return nameFromDirectory(dirname(fileURLToPath(url)));
}

function rootDirFromDirectory(directory: string, packageName: string): string | null {
  const cached = rootDirsByDirectory.get(directory);
  if (cached !== undefined) return cached;
  if (writtenManifestName(directory) === packageName) {
    rootDirsByDirectory.set(directory, directory);
    return directory;
  }
  const parent = dirname(directory);
  if (parent === directory) {
    rootDirsByDirectory.set(directory, null);
    return null;
  }
  const resolved = rootDirFromDirectory(parent, packageName);
  rootDirsByDirectory.set(directory, resolved);
  return resolved;
}

/**
 * The installed root directory of the package a resolved module URL belongs
 * to, skipping subpath manifests (`"name": "firebase/ai"`), or `null` for a
 * URL outside any named package.
 */
export function packageRootDirOf(url: string): string | null {
  if (!url.startsWith('file:')) return null;
  const name = packageNameOf(url);
  if (name === null) return null;
  return rootDirFromDirectory(dirname(fileURLToPath(url)), name);
}

/**
 * A resolved module file's path inside the package `name`, with `/`
 * separators (`ai/dist/index.mjs` for a `firebase/ai` file), or `null` when no
 * directory above it has a manifest named exactly `name`. Subpath manifests
 * (`"name": "firebase/ai"`) are passed over, so the path starts at the root.
 */
export function pathInPackageOf(url: string, name: string): string | null {
  const isFileUrl = url.startsWith('file:');
  if (!isFileUrl) return null;
  const file = fileURLToPath(url);
  let directory = dirname(file);
  while (writtenManifestName(directory) !== name) {
    const parent = dirname(directory);
    const isFilesystemRoot = parent === directory;
    if (isFilesystemRoot) return null;
    directory = parent;
  }
  return relative(directory, file).split(sep).join('/');
}

/**
 * Whether a resolved module URL lies inside the package a specifier names:
 * `firebase-admin/app` names `firebase-admin`, `firebase/firestore` names
 * `firebase`.
 */
export function resolvesIntoPackage(url: string, specifier: string): boolean {
  return packageNameOf(url) === packageRoot(specifier);
}
