#!/usr/bin/env bun
/**
 * CI guard: every SDK version named by an oracle observation must match the
 * version the workspace currently resolves.
 *
 * The observations in observations/<surface>/*.json are the pinned
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
 * Usage: bun run packages/conformance/src/check-observation-versions.ts
 * Exit codes: 0 all match, 1 a mismatch / missing field / unresolvable package.
 */
import { loadObservations } from './ledger.ts';
import {
  resolvedAdminVersion,
  resolvedFirebaseVersion,
  resolvedFunctionsVersion,
} from './package-version.ts';

const resolved = resolvedFirebaseVersion();
// `admin-*` observations are captured against `firebase-admin` (the admin SDK),
// not the firebase JS SDK, and are versioned by `adminSdkVersion`. They vouch
// for admin behavior, so they must track the installed firebase-admin version.
const resolvedAdmin = resolvedAdminVersion();
const resolvedFunctions = resolvedFunctionsVersion();
const observations = loadObservations();

const missing: string[] = [];
const mismatched: { file: string; got: string; want: string }[] = [];

const VERSION_TARGETS = [
  { field: 'fbSdkVersion', resolved },
  { field: 'adminSdkVersion', resolved: resolvedAdmin },
  { field: 'functionsSdkVersion', resolved: resolvedFunctions },
] as const;

for (const obs of observations) {
  const file = obs.file;
  const present = VERSION_TARGETS.filter(({ field }) => typeof obs.raw[field] === 'string');
  if (present.length === 0) {
    missing.push(`${file} (missing SDK version field)`);
    continue;
  }
  for (const { field, resolved: want } of present) {
    const got = obs.raw[field] as string;
    if (got !== want) mismatched.push({ file: `${file} [${field}]`, got, want });
  }
}

console.log(`# Oracle observation version guard`);
console.log(`Resolved firebase (node_modules/firebase/package.json): ${resolved}`);
console.log(`Resolved firebase-admin (node_modules/firebase-admin/package.json): ${resolvedAdmin}`);
console.log(`Resolved firebase-functions (node_modules/firebase-functions/package.json): ${resolvedFunctions}`);
console.log(`Observations checked: ${observations.length}`);

if (missing.length === 0 && mismatched.length === 0) {
  console.log('\n✓ Every observation matches its installed Firebase SDK version.');
  process.exit(0);
}

if (missing.length > 0) {
  console.error(`\n✗ ${missing.length} observation(s) missing an SDK version field:`);
  for (const f of missing.slice(0, 20)) console.error(`  - ${f}`);
}
if (mismatched.length > 0) {
  console.error(`\n✗ ${mismatched.length} observation SDK version mismatch(es):`);
  for (const { file, got, want } of mismatched.slice(0, 20)) {
    console.error(`  - ${file}: captured ${got}, installed ${want}`);
  }
  console.error('\nRe-run the owning oracle capture against the installed SDK versions.');
  console.error('Do not edit observation version fields by hand.');
}
process.exit(1);
