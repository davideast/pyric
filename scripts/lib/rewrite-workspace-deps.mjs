#!/usr/bin/env node
// Rewrite every `workspace:` dep in a package.json to a concrete version by
// looking up the target workspace package's version. Fails if any
// `workspace:` dep doesn't resolve to a known workspace package
// (caught: typos, dangling refs to a deleted workspace).
//
// Why this exists:
//   `npm pack` does NOT rewrite workspace: deps (pnpm does). Without
//   rewriting, the published tarball ships with `workspace:*`, which
//   means consumers outside the originating monorepo hit
//   `EUNSUPPORTEDPROTOCOL` on `npm install`. (We hit exactly this
//   shape with @inbrowser/relay@0.2.0, which was published to npm
//   with `"@inbrowser/resumable": "workspace:*"` in its deps and
//   broke any non-monorepo consumer.)
//
//   The naive fix is `workspace:* → *`, but `*` means "any published
//   version", so a consumer could silently pull a wildly wrong version.
//   A dependency on a package of the pyric release line packs as
//   `^<version-of-target-workspace>`: those packages publish together.
//
// Pinned packages:
//   A dependency on a package in PINNED_WORKSPACE_PACKAGES packs at its exact
//   version. @pyric/rules has its own version line, and pyric imports its
//   `@pyric/rules/internal*` paths, which carry no compatibility promise: a
//   caret would let a later 0.1.x rules publish break an installed pyric.
//
// Usage:
//   node scripts/lib/rewrite-workspace-deps.mjs <path-to-package.json> <monorepo-root>
//   node scripts/lib/rewrite-workspace-deps.mjs --check <path-to-package.json> <monorepo-root>
//
// `--check` reads a packed manifest and fails if it gives a pinned workspace
// package anything but its exact version: a range, another version, or a
// `workspace:` spec the rewrite missed.
//
// Exit codes:
//   0  rewrite succeeded (or no workspace: deps present); the check passed
//   1  one or more workspace: deps couldn't be resolved; the check failed
//   2  bad arguments

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const PINNED_WORKSPACE_PACKAGES = new Set(['@pyric/rules']);

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
const INSTALLED_DEPENDENCY_FIELDS = ['dependencies', 'peerDependencies', 'optionalDependencies'];

/**
 * A {name: version} map of every workspace package, from packages/*.
 * Examples/ packages are workspaces too but they're never `pack`ed, so
 * they are not indexed.
 */
export function readWorkspaceVersions(rootDir) {
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
  return workspaceVersions;
}

function packedSpec(name, version) {
  if (PINNED_WORKSPACE_PACKAGES.has(name)) return version;
  return `^${version}`;
}

/** Rewrite `pkg`'s workspace: deps in place. */
export function rewriteWorkspaceDependencies(pkg, workspaceVersions) {
  const unresolved = [];
  let rewrites = 0;
  for (const field of DEPENDENCY_FIELDS) {
    if (!pkg[field]) continue;
    for (const [name, spec] of Object.entries(pkg[field])) {
      if (typeof spec !== 'string' || !spec.startsWith('workspace:')) continue;
      const targetVersion = workspaceVersions.get(name);
      if (!targetVersion) {
        unresolved.push(`${pkg.name}.${field}["${name}"] = "${spec}" — no workspace package named "${name}" found in packages/`);
        continue;
      }
      pkg[field][name] = packedSpec(name, targetVersion);
      rewrites++;
    }
  }
  return { unresolved, rewrites };
}

/** Each installed dependency on a pinned workspace package that is not its exact version. */
export function findRangedPins(pkg, workspaceVersions) {
  const problems = [];
  for (const field of INSTALLED_DEPENDENCY_FIELDS) {
    for (const [name, spec] of Object.entries(pkg[field] ?? {})) {
      if (!PINNED_WORKSPACE_PACKAGES.has(name)) continue;
      const expected = workspaceVersions.get(name);
      if (spec === expected) continue;
      problems.push(`${pkg.name} ${field}["${name}"] is "${spec}", expected exactly "${expected}"`);
    }
  }
  return problems;
}

// Strip unreleased subpath exports at pack time. A package.json may list
// climbing-surface subpaths (CDD: code merged to main, surface not yet
// graduated) under "pyricUnreleasedExports". The repo keeps the exports so
// suites and the climb lane can import the mirrors; the PUBLISHED tarball
// omits them, and subpath-only ESM makes an unexported subpath unimportable.
// Cleared at graduation.
function stripUnreleasedExports(pkg) {
  if (!Array.isArray(pkg.pyricUnreleasedExports) || !pkg.exports) return;
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

function check(pkgJsonPath, rootDir) {
  const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
  const problems = findRangedPins(pkg, readWorkspaceVersions(rootDir));
  if (problems.length === 0) return 0;
  console.error(`✗ ${pkg.name} packed manifest gives a pinned workspace package a range:`);
  for (const problem of problems) console.error(`    ${problem}`);
  return 1;
}

function rewrite(pkgJsonPath, rootDir) {
  const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
  const { unresolved, rewrites } = rewriteWorkspaceDependencies(pkg, readWorkspaceVersions(rootDir));
  stripUnreleasedExports(pkg);
  if (unresolved.length > 0) {
    console.error(`✗ rewrite-workspace-deps: unresolved workspace: refs in ${pkg.name}:`);
    for (const u of unresolved) console.error(`    ${u}`);
    console.error('');
    console.error('  Either restore the referenced workspace package, or change');
    console.error('  the dep spec from "workspace:*" to a real version range.');
    return 1;
  }
  writeFileSync(pkgJsonPath, JSON.stringify(pkg, null, 2) + '\n');
  if (rewrites > 0) {
    console.error(`  ↺ rewrote ${rewrites} workspace: ref(s) in ${pkg.name}`);
  }
  return 0;
}

function main(args) {
  const checking = args[0] === '--check';
  const [pkgJsonPath, rootDir] = checking ? args.slice(1) : args;
  if (!pkgJsonPath || !rootDir) {
    console.error(
      'usage: rewrite-workspace-deps.mjs [--check] <path-to-package.json> <monorepo-root>',
    );
    return 2;
  }
  return checking ? check(pkgJsonPath, rootDir) : rewrite(pkgJsonPath, rootDir);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
