/**
 * Mirror-package exemption for the register hooks.
 *
 * The pyric mirrors THEMSELVES import Firebase — that's their prod arm
 * (e.g. pyric-admin/database's `import { getDatabaseWithUrl } from
 * 'firebase-admin/database'`). Rewriting those would turn them into
 * self-imports and break the mirror (missing exports, infinite mirrors),
 * so a specifier is only rewritten when the REQUESTING module lives
 * outside the pyric packages.
 *
 * Identity is the OWNING PACKAGE NAME — the `name` in the nearest named
 * package.json above the requesting file — never a path substring (repo
 * checkouts and worktrees have 'pyric' in every path). Nameless
 * package.json files (`{"type": "module"}` markers in dist dirs) are
 * skipped: they set the module format, not the package identity.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mapFirebaseSpecifier } from './mapping.js';

/** The packages whose own Firebase imports must stay Firebase. */
const EXEMPT_PACKAGES: ReadonlySet<string> = new Set(['pyric', 'pyric-admin', '@pyric/cli']);

/** dir → owning package name (null = none found up to the fs root).
 *  Resolution runs on every import in the child process — cache it. */
const ownerCache = new Map<string, string | null>();

function owningPackageNameOfDir(dir: string): string | null {
  const cached = ownerCache.get(dir);
  if (cached !== undefined) return cached;
  let name: string | null = null;
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      name?: unknown;
    };
    if (typeof pkg.name === 'string' && pkg.name.length > 0) {
      name = pkg.name;
    }
  } catch {
    // no/unreadable package.json here — keep walking
  }
  if (name === null) {
    const parent = dirname(dir);
    name = parent === dir ? null : owningPackageNameOfDir(parent);
  }
  ownerCache.set(dir, name);
  return name;
}

/** The `name` of the package that owns `fileUrl` (a `file:` URL), or null
 *  (entry point, data:/node: parents, no named package.json above it). */
export function owningPackageName(fileUrl: string | undefined): string | null {
  if (!fileUrl || !fileUrl.startsWith('file:')) return null;
  try {
    return owningPackageNameOfDir(dirname(fileURLToPath(fileUrl)));
  } catch {
    return null;
  }
}

/**
 * The one rewrite decision both hook paths (`module.registerHooks` and the
 * `module.register` fallback) share: map the specifier, unless the
 * requesting module is owned by a pyric mirror package. Returns the mapped
 * specifier or null (leave resolution alone).
 */
export function rewriteSpecifier(specifier: string, parentURL: string | undefined): string | null {
  const mapped = mapFirebaseSpecifier(specifier);
  if (mapped === null) return null;
  const owner = owningPackageName(parentURL);
  if (owner !== null && EXEMPT_PACKAGES.has(owner)) return null;
  return mapped;
}
