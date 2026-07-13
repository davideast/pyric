// Exports ↔ dist drift check for a publishable package.
//
// Two directions, because each catches a different shipping bug:
//   FORWARD  — every file an `exports` condition points at (types/import/node/
//              browser/default, nested) actually exists in the built package.
//              A dangling target ships an export that throws ERR_MODULE_NOT_FOUND
//              (or a `.d.ts` path that breaks every TS consumer) — FAILS.
//   REVERSE  — a built public entrypoint (dist/<dir>/index.js) that NO export maps
//              to. That's a feature you built but consumers can't reach — almost
//              always a forgotten `exports` entry — WARNS (allowlist internal ones).
//
// Runtime `import()` (packaging-test Phase 4) proves a subpath resolves but never
// looks at the `types` condition, and can't see the reverse gap at all. This does.
//
// Usage: node scripts/lib/check-exports.mjs <packageDir> [<packageDir> ...]
//        node scripts/lib/check-exports.mjs --all      (the 4 publishable packages)
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLISHABLE = ['pyric', 'pyric-admin', 'cli', 'ui'].map((p) =>
  join(REPO, 'packages', p),
);

// dist/<dir> entrypoints that are intentionally NOT exported (internal-only build
// artifacts a consumer should never import directly). Keyed by package name.
const REVERSE_ALLOW = {
  // The CLI is the `pyric` bin (package.json "bin"), reachable as a command — not
  // a subpath import — so it is intentionally absent from "exports".
  '@pyric/cli': ['cli'],
};

/** Collect every string leaf under an exports condition tree. */
function collectTargets(node, acc) {
  if (typeof node === 'string') { acc.push(node); return; }
  if (node && typeof node === 'object') for (const v of Object.values(node)) collectTargets(v, acc);
}

/** The set of top-level dist subdirs that look like a public entrypoint (have an
 *  index.js). Used for the reverse check. */
function distEntrypoints(pkgDir) {
  const dist = join(pkgDir, 'dist');
  if (!existsSync(dist)) return [];
  const out = [];
  for (const name of readdirSync(dist)) {
    const d = join(dist, name);
    if (statSync(d).isDirectory() && existsSync(join(d, 'index.js'))) out.push(name);
  }
  return out;
}

function checkPackage(pkgDir) {
  const pkgJsonPath = join(pkgDir, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
  const name = pkg.name;
  const errors = [];
  const warnings = [];

  const exportsMap = pkg.exports || {};
  if (Object.keys(exportsMap).length === 0) errors.push(`${name}: package has no "exports" map`);

  // FORWARD: every condition target exists.
  const exportedFiles = new Set();
  for (const [subpath, node] of Object.entries(exportsMap)) {
    const targets = [];
    collectTargets(node, targets);
    if (targets.length === 0) errors.push(`${name}: export "${subpath}" resolves to no file targets`);
    for (const rel of targets) {
      exportedFiles.add(rel.replace(/^\.\//, ''));
      const abs = join(pkgDir, rel);
      if (!existsSync(abs)) errors.push(`${name}: export "${subpath}" → ${rel} does NOT exist (run build?)`);
    }
  }

  // REVERSE: a built dist/<dir>/index.js that nothing exports.
  const allow = new Set(REVERSE_ALLOW[name] || []);
  const referencedDirs = new Set([...exportedFiles].map((f) => f.split('/')[1]).filter(Boolean));
  for (const dir of distEntrypoints(pkgDir)) {
    if (allow.has(dir)) continue;
    if (!referencedDirs.has(dir)) {
      warnings.push(`${name}: dist/${dir}/index.js is built but NOT referenced by any export (forgotten "exports" entry? else add to REVERSE_ALLOW)`);
    }
  }
  return { name, errors, warnings };
}

const args = process.argv.slice(2);
const dirs = args.length === 0 || args[0] === '--all' ? PUBLISHABLE : args;

let failed = false;
for (const dir of dirs) {
  const { name, errors, warnings } = checkPackage(dir);
  if (errors.length === 0 && warnings.length === 0) {
    console.log(`  ✓ ${name} — exports ↔ dist consistent`);
  } else {
    for (const w of warnings) console.warn(`  ⚠ ${w}`);
    for (const e of errors) console.error(`  ✗ ${e}`);
    if (errors.length) failed = true;
  }
}
if (failed) {
  console.error('\nexports↔dist drift: FAIL');
  process.exit(1);
}
console.log('\nexports↔dist drift: OK');
