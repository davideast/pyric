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
 * Source of truth for "resolved version": the `firebase@<v>` key in
 * bun.lock (what actually gets installed), not the `^`-range in
 * package.json.
 *
 * Usage: bun run scripts/oracle/check-observation-versions.ts
 * Exit codes: 0 all match, 1 a mismatch / missing field / unreadable lock.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const OBS_DIR = join(HERE, 'observations');

/** Resolved (installed) firebase version from bun.lock's package key. */
function resolvedFirebaseVersion(): string {
  const lock = readFileSync(join(ROOT, 'bun.lock'), 'utf8');
  const m = lock.match(/"firebase@([\d]+\.[\d]+\.[\d]+[^"]*)"/);
  if (!m) {
    console.error('✗ Could not find a `firebase@<version>` key in bun.lock.');
    process.exit(1);
  }
  return m[1];
}

const resolved = resolvedFirebaseVersion();
const files = readdirSync(OBS_DIR).filter((f) => f.endsWith('.json'));

const missing: string[] = [];
const mismatched: { file: string; got: string }[] = [];

for (const file of files) {
  const obs = JSON.parse(readFileSync(join(OBS_DIR, file), 'utf8'));
  const v = obs.fbSdkVersion;
  if (!v) {
    missing.push(file);
    continue;
  }
  if (v !== resolved) mismatched.push({ file, got: v });
}

console.log(`# Oracle observation version guard`);
console.log(`Resolved firebase (bun.lock): ${resolved}`);
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
