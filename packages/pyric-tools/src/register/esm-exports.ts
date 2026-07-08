/**
 * Minimal `exports`-field walker for the CJS→ESM seam in
 * `pyric-tools/register`.
 *
 * Why it exists: a rewritten CJS `require('firebase-admin/app')` resolves
 * `pyric-admin/app` under the `require` condition, but the pyric mirrors are
 * ESM-only (`import`-condition exports) — Node's CJS resolver throws
 * ERR_PACKAGE_PATH_NOT_EXPORTED and ignores hook-supplied condition
 * overrides. `require(esm)` (Node ≥ 22.12) can LOAD the module fine once we
 * hand it the file, so the register hook locates the package
 * (`Module.findPackageJSON`) and resolves the subpath here under import
 * conditions.
 *
 * Deliberately narrow, matching what the pyric packages actually publish:
 * literal subpaths only (no `*` patterns), string targets, and nested
 * condition objects tried in `node` → `import` → `default` order (`types`
 * and unknown conditions are skipped).
 */

type ExportsValue = string | { [key: string]: ExportsValue } | null;

const CONDITION_ORDER = ['node', 'import', 'default'] as const;

/** Resolve one condition object/string to its file target, or null. */
function resolveTarget(value: ExportsValue): string | null {
  if (typeof value === 'string') return value;
  if (value === null || typeof value !== 'object') return null;
  for (const condition of CONDITION_ORDER) {
    if (condition in value) {
      const resolved = resolveTarget(value[condition] ?? null);
      if (resolved !== null) return resolved;
    }
  }
  return null;
}

/**
 * Resolve `subpath` (e.g. `'./app'`, or `'.'` for the root) against a
 * package's `exports` field under import conditions. Returns the relative
 * file target (e.g. `'./dist/app/index.js'`) or null when the subpath is
 * not exported.
 */
export function resolveEsmOnlySubpath(
  exportsField: unknown,
  subpath: string,
): string | null {
  if (exportsField === null || exportsField === undefined) return null;
  if (typeof exportsField === 'string') {
    return subpath === '.' ? exportsField : null;
  }
  if (typeof exportsField !== 'object') return null;
  const map = exportsField as Record<string, ExportsValue>;

  const keys = Object.keys(map);
  const isSubpathMap = keys.every((k) => k === '.' || k.startsWith('./'));
  if (!isSubpathMap) {
    // Bare conditions object — describes the root subpath only.
    return subpath === '.' ? resolveTarget(map as ExportsValue) : null;
  }
  const entry = map[subpath];
  if (entry === undefined) return null;
  return resolveTarget(entry);
}
