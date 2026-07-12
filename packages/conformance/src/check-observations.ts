#!/usr/bin/env bun
/**
 * Oracle conformance gate (observations x probes).
 *
 * The pinned production records live in packages/conformance/observations/*.json.
 * Typed registry rows in packages/conformance/registry/*.ts name the local probe
 * tests that replay selected observations against the shim. Status is derived:
 * a passing probe means the shim conforms to the pinned observation; a failing
 * probe is either an infrastructure/setup failure or a live contradiction.
 *
 * Usage: bun run packages/conformance/src/check-observations.ts [--json]
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  REPO_ROOT,
  buildCompatibilityLedger,
  type OracleConformanceCheck,
} from './ledger.ts';

const REQUIRED = ['name', 'matrixRow', 'rowIds', 'description', 'observedAt', 'behavior'] as const;

const ledger = buildCompatibilityLedger();
const checks = ledger.entries.flatMap((row) => (row.conformanceChecks ?? []).map((check) => ({ ...check, rowId: row.id })));
const observations = ledger.observations;
const byName = new Map(observations.map((obs) => [obs.name, obs]));

const structural: string[] = [];
for (const obs of observations) {
  for (const key of REQUIRED) if (!(key in obs.raw)) structural.push(`${obs.file}: missing '${key}'`);
  // Version field: admin-SDK captures carry `adminSdkVersion` (guarded against
  // firebase-admin); firebase-JS-SDK captures carry `fbSdkVersion`.
  const versionField = 'adminSdkVersion' in obs.raw ? 'adminSdkVersion' : 'fbSdkVersion';
  if (!(versionField in obs.raw)) structural.push(`${obs.file}: missing 'fbSdkVersion'`);
  if (`${obs.name}.json` !== obs.file) structural.push(`${obs.file}: name '${obs.name}' does not match filename`);
}

const integrityProblems: string[] = [];
for (const check of checks) {
  const obs = byName.get(check.observation);
  if (!obs) {
    integrityProblems.push(`${check.finding}: observation '${check.observation}.json' is missing`);
    continue;
  }
  for (const [key, expected] of Object.entries(check.expect)) {
    const actual = obs.behavior[key];
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      integrityProblems.push(
        `${check.finding}: ${check.observation}.behavior.${key} = ${JSON.stringify(actual)}, registry expects ${JSON.stringify(expected)}`,
      );
    }
  }
}

type OutcomeKind = 'conforming' | 'live-contradiction' | 'infrastructure' | 'missing';
type RegisteredCheck = OracleConformanceCheck & { rowId: string };
interface ProbeOutcome {
  entry: RegisteredCheck;
  kind: OutcomeKind;
  detail?: string;
}

function commandOutput(error: unknown): string {
  const anyError = error as { stdout?: unknown; stderr?: unknown; message?: unknown };
  return [anyError.stdout, anyError.stderr, anyError.message].map((v) => String(v ?? '')).filter(Boolean).join('\n');
}

function tail(output: string): string {
  return output.split('\n').filter(Boolean).slice(-8).join('\n   ');
}

function isInfrastructureFailure(output: string): boolean {
  return /Cannot find module|Module not found|error: Cannot find|ENOENT|Build failed|SyntaxError|ReferenceError|TypeError:.*import|Failed to resolve/i.test(output);
}

function runBuildScript(script: string): string | null {
  try {
    execFileSync('bun', ['run', script], { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return null;
  } catch (error) {
    return tail(commandOutput(error));
  }
}

function ensureWorkspaceBuild(): string | null {
  const sandboxEntry = join(REPO_ROOT, 'packages', 'pyric', 'dist', 'sandbox', 'index.js');
  if (!existsSync(sandboxEntry)) {
    const pyricProblem = runBuildScript('build:pyric');
    if (pyricProblem) return `build:pyric failed before probes ran:\n   ${pyricProblem}`;
  }
  return null;
}

function runProbe(entry: RegisteredCheck): ProbeOutcome {
  const probePath = join(REPO_ROOT, entry.probe);
  if (!existsSync(probePath)) return { entry, kind: 'missing' };
  try {
    execFileSync('bun', ['test', entry.probe], { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { entry, kind: 'conforming' };
  } catch (error) {
    const output = commandOutput(error);
    return {
      entry,
      kind: isInfrastructureFailure(output) ? 'infrastructure' : 'live-contradiction',
      detail: tail(output),
    };
  }
}

const foundationOk = structural.length === 0 && integrityProblems.length === 0;
let buildProblem: string | null = null;
let outcomes: ProbeOutcome[] = [];
if (foundationOk) {
  buildProblem = ensureWorkspaceBuild();
  outcomes = buildProblem
    ? checks.map((entry) => ({ entry, kind: 'infrastructure' as const, detail: buildProblem }))
    : checks.map(runProbe);
}

const conforming = outcomes.filter((outcome) => outcome.kind === 'conforming');
const live = outcomes.filter((outcome) => outcome.kind === 'live-contradiction');
const infrastructure = outcomes.filter((outcome) => outcome.kind === 'infrastructure');
const missing = outcomes.filter((outcome) => outcome.kind === 'missing');

const wantJson = process.argv.includes('--json');
if (wantJson) {
  console.log(JSON.stringify({
    total: observations.length,
    registeredChecks: checks.length,
    structuralProblems: structural,
    integrityProblems,
    conforming: conforming.map((o) => ({ finding: o.entry.finding, rowId: o.entry.rowId, observation: o.entry.observation, probe: o.entry.probe })),
    liveContradictions: live.map((o) => ({ finding: o.entry.finding, rowId: o.entry.rowId, observation: o.entry.observation, probe: o.entry.probe, detail: o.detail })),
    infrastructureFailures: infrastructure.map((o) => ({ finding: o.entry.finding, rowId: o.entry.rowId, observation: o.entry.observation, probe: o.entry.probe, detail: o.detail })),
    missingProbes: missing.map((o) => ({ finding: o.entry.finding, rowId: o.entry.rowId, observation: o.entry.observation, probe: o.entry.probe })),
  }, null, 2));
} else {
  console.log('# Oracle conformance gate (observations x probes)\n');
  console.log(`Observations loaded: ${observations.length}`);
  console.log(`Registry conformance checks: ${checks.length}`);
  console.log(`Structural problems: ${structural.length}`);
  console.log(`Observation-integrity problems: ${integrityProblems.length}`);
  console.log(`Conformance probes run: ${outcomes.length}\n`);

  for (const problem of structural) console.error(`  x ${problem}`);
  for (const problem of integrityProblems) console.error(`  x ${problem}`);

  if (conforming.length > 0) {
    console.log('## Conforming — probe passes; shim matches the recorded prod behavior\n');
    for (const outcome of conforming) {
      console.log(`- ${outcome.entry.finding} (${outcome.entry.rowId}) — ${outcome.entry.guards}`);
      console.log(`  probe: ${outcome.entry.probe}`);
    }
  }
  if (live.length > 0) {
    console.log('\n## LIVE contradictions — probe failed after setup succeeded\n');
    for (const outcome of live) {
      console.error(`- ${outcome.entry.finding} (${outcome.entry.rowId}) — ${outcome.entry.guards}`);
      console.error(`  probe: ${outcome.entry.probe}`);
      if (outcome.detail) console.error(`  ${outcome.detail}`);
    }
  }
  if (infrastructure.length > 0) {
    console.log('\n## Infrastructure failures — probe could not run cleanly\n');
    for (const outcome of infrastructure) {
      console.error(`- ${outcome.entry.finding} (${outcome.entry.rowId}) — ${outcome.entry.probe}`);
      if (outcome.detail) console.error(`  ${outcome.detail}`);
    }
  }
  if (missing.length > 0) {
    console.log('\n## Missing probes\n');
    for (const outcome of missing) console.error(`- ${outcome.entry.finding} (${outcome.entry.rowId}) — ${outcome.entry.probe}`);
  }
}

const failed = structural.length > 0 || integrityProblems.length > 0 || live.length > 0 || infrastructure.length > 0 || missing.length > 0;
if (failed) {
  console.error('\n✗ Conformance gate failed.');
  process.exit(1);
}

console.log(`\n✓ Observations sound; all ${conforming.length} registered conformance probes pass.`);
process.exit(0);
