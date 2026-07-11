#!/usr/bin/env bun
/**
 * CI guard: every oracle observation must have been captured against the
 * SAME `firebase` version the workspace currently resolves.
 *
 * The observations in scripts/oracle/observations/*.json are the pinned
 * record of real prod behavior the COMPAT matrices cite. If the workspace
 * bumps `firebase` but the observations aren't re-captured, every "matches
 * prod" claim silently drifts to a stale version — exactly the rot behind
 * INF-3/INF-4 (an observation captured at one version vouching for behavior
 * at another).
 *
 * Source of truth for "resolved version": the installed
 * node_modules/firebase/package.json (what tests actually ran against),
 * not the `^`-range in package.json or a lockfile scrape.
 *
 * Usage: bun run scripts/oracle/check-observation-versions.ts
 * Exit codes: 0 all match, 1 a mismatch / missing field / unresolvable package.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OBS_DIR = join(HERE, '..', 'observations');

/** Resolved (installed) version of `pkg` from its own package.json. */
function resolvedVersion(pkg: string): string {
  try {
    const pkgPath = fileURLToPath(import.meta.resolve(`${pkg}/package.json`));
    const meta = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: unknown };
    if (typeof meta.version === 'string' && meta.version.length > 0) return meta.version;
  } catch {
    // fall through to the shared error below
  }
  console.error(`✗ Could not read the version of the installed ${pkg} package.`);
  process.exit(1);
}

const resolved = resolvedVersion('firebase');
// `admin-*` observations are captured against `firebase-admin` (the admin SDK),
// not the firebase JS SDK, and are versioned by `adminSdkVersion`. They vouch
// for admin behavior, so they must track the installed firebase-admin version.
const resolvedAdmin = resolvedVersion('firebase-admin');
const files = readdirSync(OBS_DIR).filter((f) => f.endsWith('.json'));

const missing: string[] = [];
const mismatched: { file: string; got: string }[] = [];

for (const file of files) {
  const obs = JSON.parse(readFileSync(join(OBS_DIR, file), 'utf8'));
  // An admin capture carries `adminSdkVersion` and is guarded against
  // firebase-admin; everything else carries `fbSdkVersion` and is guarded
  // against firebase.
  const isAdmin = typeof obs.adminSdkVersion === 'string';
  const field = isAdmin ? 'adminSdkVersion' : 'fbSdkVersion';
  const want = isAdmin ? resolvedAdmin : resolved;
  const v = obs[field];
  if (!v) {
    missing.push(`${file} (missing ${field})`);
    continue;
  }
  if (v !== want) mismatched.push({ file: `${file} [${field}]`, got: v });
}

console.log(`# Oracle observation version guard`);
console.log(`Resolved firebase (node_modules/firebase/package.json): ${resolved}`);
console.log(`Resolved firebase-admin (node_modules/firebase-admin/package.json): ${resolvedAdmin}`);
console.log(`Observations checked: ${files.length}`);

if (missing.length === 0 && mismatched.length === 0) {
  console.log(`\n✓ All observations captured at ${resolved}.`);
  process.exit(0);
}

if (missing.length > 0) {
  console.error(`\n✗ ${missing.length} observation(s) missing fbSdkVersion:`);
  for (const f of missing.slice(0, 20)) console.error(`  - ${f}`);
}
if (mismatched.length > 0) {
  console.error(`\n✗ ${mismatched.length} observation(s) not captured at ${resolved}:`);
  for (const { file, got } of mismatched.slice(0, 20)) console.error(`  - ${file}: ${got}`);
  console.error(`\nRe-capture them against firebase@${resolved} (bun run scripts/oracle/run.ts),`);
  console.error(`or, if the bump is intentional, re-run the full oracle capture so every`);
  console.error(`observation carries the new version. Do not edit fbSdkVersion by hand.`);
}
process.exit(1);
