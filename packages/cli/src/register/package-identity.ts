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
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Package name per directory, `null` for a directory with no named manifest. */
const namesByDirectory = new Map<string, string | null>();

/** `firebase/firestore` → `firebase`; `@scope/pkg/sub` → `@scope/pkg`. */
function packageRoot(name: string): string {
  const parts = name.split('/');
  const isScoped = name.startsWith('@');
  const rootLength = isScoped ? 2 : 1;
  return parts.slice(0, rootLength).join('/');
}

/** The `name` of `<directory>/package.json`, or `null` when there is none. */
function manifestName(directory: string): string | null {
  try {
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as { name?: unknown };
    const hasName = typeof manifest.name === 'string' && manifest.name !== '';
    return hasName ? packageRoot(manifest.name as string) : null;
  } catch {
    return null;
  }
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

/** The package a resolved module URL belongs to, or `null` for a URL outside any named package. */
export function packageNameOf(url: string): string | null {
  const isFileUrl = url.startsWith('file:');
  if (!isFileUrl) return null;
  return nameFromDirectory(dirname(fileURLToPath(url)));
}

/**
 * Whether a resolved module URL lies inside the package a specifier names:
 * `firebase-admin/app` names `firebase-admin`, `firebase/firestore` names
 * `firebase`.
 */
export function resolvesIntoPackage(url: string, specifier: string): boolean {
  return packageNameOf(url) === packageRoot(specifier);
}
