#!/usr/bin/env bun
/**
 * Oracle rig fleet planner.
 *
 * The mandatory plan-mode protocol for the oracle rigs in
 * scripts/oracle/rigs/: reads every rig manifest and reports, for each one,
 * exactly what it needs and whether the CURRENT environment satisfies it —
 * without running anything. Zero network calls; zero secrets are ever
 * printed (only whether an env var is present, never its value).
 *
 * Usage: bun run scripts/oracle/plan.ts   (bun run oracle:plan)
 * Exit code: always 0 — this is a report, not a gate.
 */
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRigManifests } from './rigs/load.ts';
import type { RigManifest } from './rigs/types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');
const OBS_DIR = join(HERE, 'observations');

/** Counts observation files per prefix using LONGEST-prefix match among this
 *  rig's own prefixes — 'rtdb-' and 'rtdb-modular-' both belong to the
 *  oracle-run rig, and a naive startsWith tally would double-count every
 *  'rtdb-modular-*' file under 'rtdb-' too. Each file is assigned to exactly
 *  one (its longest matching) prefix, mirroring the validator's rule. */
function observationCounts(prefixes: string[]): Map<string, number> {
  const files = readdirSync(OBS_DIR).filter((f) => f.endsWith('.json'));
  const sortedByLength = [...prefixes].sort((a, b) => b.length - a.length);
  const counts = new Map<string, number>(prefixes.map((prefix) => [prefix, 0]));
  for (const file of files) {
    const longest = sortedByLength.find((prefix) => file.startsWith(prefix));
    if (longest) counts.set(longest, (counts.get(longest) ?? 0) + 1);
  }
  return counts;
}

/** Present/missing only — the value itself is never read into anything that gets printed. */
function envPresence(name: string): 'present' | 'missing' {
  return process.env[name] ? 'present' : 'missing';
}

interface RigReport {
  manifest: RigManifest;
  scriptExists: boolean;
  envStatus: { name: string; status: 'present' | 'missing' }[];
  runnableNow: boolean;
  blockedBy: string[];
}

function assessRig(manifest: RigManifest): RigReport {
  const scriptExists = existsSync(join(REPO_ROOT, manifest.script));
  const envStatus = manifest.requires.env.map((req) => ({ name: req.name, status: envPresence(req.name) }));
  const blockedBy: string[] = [];
  if (!scriptExists) blockedBy.push(`script missing: ${manifest.script}`);

  // Every credentialed rig in this fleet treats its listed env vars as
  // alternatives: oracle-run accepts a manual Web config OR a service-account
  // path; the two rules rigs have exactly one required var, where "any" and
  // "all" coincide. Unattended rigs need no env at all.
  const envSatisfied =
    manifest.automation === 'unattended' || envStatus.length === 0 || envStatus.some((e) => e.status === 'present');
  if (manifest.automation !== 'unattended' && !envSatisfied) {
    const missing = envStatus.filter((e) => e.status === 'missing').map((e) => e.name);
    blockedBy.push(`missing env: ${missing.join(', ')}`);
  }

  return { manifest, scriptExists, envStatus, runnableNow: scriptExists && envSatisfied, blockedBy };
}

function printRig(report: RigReport): void {
  const { manifest } = report;
  console.log(`## ${manifest.id}`);
  console.log(manifest.description);
  console.log(`  automation:  ${manifest.automation}`);
  console.log(`  network:     ${manifest.network}`);
  console.log(`  script:      ${manifest.script} (${report.scriptExists ? 'found' : 'MISSING'})`);

  console.log('  observations:');
  for (const [prefix, count] of observationCounts(manifest.observationPrefixes)) {
    console.log(`    ${prefix.padEnd(20)} ${count} file(s)`);
  }

  console.log('  env:');
  if (report.envStatus.length === 0) {
    console.log('    (none required)');
  } else {
    for (const { name, status } of report.envStatus) console.log(`    ${name.padEnd(32)} ${status}`);
  }

  if (manifest.requires.projectFeatures.length > 0) {
    console.log('  project features (unverifiable-here):');
    for (const feature of manifest.requires.projectFeatures) console.log(`    - ${feature}`);
  }
  if (manifest.requires.local.length > 0) {
    console.log('  local requirements (unverifiable-here):');
    for (const local of manifest.requires.local) console.log(`    - ${local}`);
  }

  console.log(`  runnable now: ${report.runnableNow ? 'yes' : 'no'}`);
  for (const reason of report.blockedBy) console.log(`    blocked by: ${reason}`);
  console.log('');
}

async function main(): Promise<void> {
  const manifests = await loadRigManifests();
  const reports = manifests.map(assessRig);

  console.log('# Oracle rig fleet plan\n');
  console.log(`Rigs: ${reports.length}\n`);
  for (const report of reports) printRig(report);

  const runnable = reports.filter((r) => r.runnableNow);
  const blocked = reports.filter((r) => !r.runnableNow);

  console.log('## Summary\n');
  console.log(`Runnable now (${runnable.length}): ${runnable.map((r) => r.manifest.id).join(', ') || '(none)'}`);
  console.log(`Blocked (${blocked.length}):`);
  for (const report of blocked) console.log(`  - ${report.manifest.id}: ${report.blockedBy.join('; ')}`);

  process.exit(0);
}

if (import.meta.main) {
  await main();
}
