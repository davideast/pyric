#!/usr/bin/env node
// Rewrite every `workspace:*` dep in a package.json to `^<version>` by
// looking up the target workspace package's version. Fails if any
// `workspace:*` dep doesn't resolve to a known workspace package
// (caught: typos, dangling refs to a deleted workspace).
//
// Why this exists:
//   `npm pack` does NOT rewrite workspace: deps (pnpm does). Without
//   rewriting, the published tarball ships with `workspace:*` — which
//   means consumers outside the originating monorepo hit
//   `EUNSUPPORTEDPROTOCOL` on `npm install`. (We hit exactly this
//   shape with @inbrowser/relay@0.2.0, which was published to npm
//   with `"@inbrowser/resumable": "workspace:*"` in its deps and
//   broke any non-monorepo consumer.)
//
//   The naive fix is `workspace:* → *`, but `*` means "any published
//   version" — a consumer could silently pull a wildly wrong version.
//   Rewriting to `^<version-of-target-workspace>` is the actually-safe
//   move: the consumer gets the version that was current at pack time.
//
// Usage:
//   node scripts/lib/rewrite-workspace-deps.mjs <path-to-package.json> <monorepo-root>
//
// Exit codes:
//   0  rewrite succeeded (or no workspace: deps present)
//   1  one or more workspace:* deps couldn't be resolved
//   2  bad arguments

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const [pkgJsonPath, rootDir] = process.argv.slice(2);
if (!pkgJsonPath || !rootDir) {
  console.error(
    'usage: rewrite-workspace-deps.mjs <path-to-package.json> <monorepo-root>',
  );
  process.exit(2);
}

// Build a {name: version} map of every workspace package by scanning
// packages/*. Examples/ packages are workspaces too but they're never
// `pack`ed, so we don't index them.
const workspaceVersions = new Map();
const pkgsRoot = join(rootDir, 'packages');
for (const dir of readdirSync(pkgsRoot)) {
  const pjPath = join(pkgsRoot, dir, 'package.json');
  try {
    if (!statSync(pjPath).isFile()) continue;
    const meta = JSON.parse(readFileSync(pjPath, 'utf-8'));
    if (meta.name && meta.version) workspaceVersions.set(meta.name, meta.version);
  } catch {
    // Skip dirs without a readable package.json
  }
}

const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
const unresolved = [];
let rewrites = 0;

for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
  if (!pkg[field]) continue;
  for (const [name, spec] of Object.entries(pkg[field])) {
    if (typeof spec !== 'string' || !spec.startsWith('workspace:')) continue;
    const targetVersion = workspaceVersions.get(name);
    if (!targetVersion) {
      unresolved.push(`${pkg.name}.${field}["${name}"] = "${spec}" — no workspace package named "${name}" found in packages/`);
      continue;
    }
    pkg[field][name] = `^${targetVersion}`;
    rewrites++;
  }
}

// Strip unreleased subpath exports at pack time. A package.json may list
// climbing-surface subpaths (CDD: code merged to main, surface not yet
// graduated) under "pyricUnreleasedExports". The repo keeps the exports so
// suites and the climb lane can import the mirrors; the PUBLISHED tarball
// omits them, and subpath-only ESM makes an unexported subpath unimportable.
// Cleared at graduation.
if (Array.isArray(pkg.pyricUnreleasedExports) && pkg.exports) {
  const stripped = [];
  for (const sub of pkg.pyricUnreleasedExports) {
    if (sub in pkg.exports) {
      delete pkg.exports[sub];
      stripped.push(sub);
    }
  }
  delete pkg.pyricUnreleasedExports;
  if (stripped.length > 0) {
    console.error(`  stripped unreleased exports from ${pkg.name}: ${stripped.join(', ')}`);
  }
}

if (unresolved.length > 0) {
  console.error(`✗ rewrite-workspace-deps: unresolved workspace: refs in ${pkg.name}:`);
  for (const u of unresolved) console.error(`    ${u}`);
  console.error('');
  console.error('  Either restore the referenced workspace package, or change');
  console.error('  the dep spec from "workspace:*" to a real version range.');
  process.exit(1);
}

writeFileSync(pkgJsonPath, JSON.stringify(pkg, null, 2) + '\n');
if (rewrites > 0) {
  console.error(`  ↺ rewrote ${rewrites} workspace: ref(s) in ${pkg.name}`);
}
