#!/usr/bin/env bun
/**
 * Storage rules oracle capture runner.
 *
 * Sibling of run-rules.ts for the `service firebase.storage` surface. Reads the
 * conformance corpus (rules-corpus/storage/) and, when
 * credentialed, replays each scenario against the PRODUCTION Rules Test API via
 * `TestStorageRulesHandler` (the SAME `projects.test` endpoint the Firestore
 * runner uses — live-confirmed to accept Storage rulesets). One observation
 * JSON is written per scenario into
 * `observations/storage/rules-storage-<scenario.id>.json`. Production is the
 * source of truth: the captured `behavior` is a verdict table keyed by case
 * description (ALLOW / DENY), which the in-process replay suite then checks the
 * storage evaluator against.
 *
 * CREDENTIAL CONTRACT (identical to the Firestore runner / parity harness):
 *   PARITY_SA_BASE64 — base64-encoded service-account JSON holding only
 *   `firebaserules.rulesets.test`. The project the SA belongs to is the
 *   project the rules are tested against.
 *
 * RUNNABLE-BUT-INERT WITHOUT CREDENTIALS:
 *   With PARITY_SA_BASE64 absent, this runner makes NO network calls. It prints
 *   exactly what it WOULD capture (every scenario, its case count, and the
 *   observation file path each scenario lands in) plus the env var name it needs,
 *   then exits 0. This is the intended state of the staging branch: the
 *   machinery is in place, but no captures have been run and no observation
 *   files have been fabricated.
 *
 * Usage:
 *   # inert preview (no secret):
 *   bun run packages/conformance/src/run-rules-storage.ts
 *   # real capture (credentialed):
 *   PARITY_SA_BASE64="$(base64 < firebaserules-sa.json)" \
 *     bun run packages/conformance/src/run-rules-storage.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestFirestoreRulesResult, TestResult } from '../../../packages/pyric/src/rules/test/spec.ts';
import {
  ALL_RULES_STORAGE_SCENARIOS,
  RULES_STORAGE_OBSERVATION_PREFIX,
  storageObservationName,
  type StorageScenario,
} from '../rules-corpus/storage/index.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
// rules-storage-* observations belong to the native 'storage-rules' surface.
const OBS_DIR = join(HERE, '..', 'observations', 'storage-rules');

/** Resolved (installed) firebase version — the value the observation-version
 *  guard compares every observation against. */
function resolvedFirebaseVersion(): string {
  const pkgPath = fileURLToPath(import.meta.resolve('firebase/package.json'));
  const meta = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
  if (!meta.version) throw new Error('could not resolve installed firebase version');
  return meta.version;
}

interface Observation {
  name: string;
  matrixRow: string;
  rowIds: string[];
  description: string;
  observedAt: string;
  fbSdkVersion: string;
  projectId: string;
  behavior: Record<string, unknown>;
  diagnostics?: Record<string, { notes?: string[]; api?: TestResult['api'] }>;
}

/** Absolute path an observation for `scenario` writes to. */
function observationPath(scenario: StorageScenario): string {
  return join(OBS_DIR, `${storageObservationName(scenario)}.json`);
}

/** Build the verdict table (case description → prod decision) for a scenario. */
function verdictTable(
  scenario: StorageScenario,
  res: TestFirestoreRulesResult,
): Record<string, 'ALLOW' | 'DENY' | 'UNSUPPORTED'> {
  if (!res.success) {
    throw new Error(
      `Production Rules Test API failed for scenario "${scenario.id}": ` +
        `${res.error.code} ${res.error.message}`,
    );
  }
  const table: Record<string, 'ALLOW' | 'DENY' | 'UNSUPPORTED'> = {};
  res.data.results.forEach((r, i) => {
    table[scenario.cases[i].description] = r.decision;
  });
  return table;
}

/** Keep hosted diagnostics next to advanced probe verdicts. Empty entries are
 * omitted so ordinary observations stay compact. */
export function diagnosticTable(
  results: TestResult[],
): Record<string, { notes?: string[]; api?: TestResult['api'] }> {
  const table: Record<string, { notes?: string[]; api?: TestResult['api'] }> = {};
  for (const result of results) {
    const entry = {
      ...(result.notes.length > 0 ? { notes: result.notes } : {}),
      ...(result.api ? { api: result.api } : {}),
    };
    if (Object.keys(entry).length > 0) table[result.description] = entry;
  }
  return table;
}

export function selectStorageScenarios(
  args: string[],
  scenarios: StorageScenario[] = ALL_RULES_STORAGE_SCENARIOS,
): StorageScenario[] {
  const requested: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--scenario') {
      const id = args[i + 1];
      if (!id || id.startsWith('--')) throw new Error('--scenario requires a scenario id');
      requested.push(id);
      i += 1;
    } else if (arg.startsWith('--scenario=')) {
      const id = arg.slice('--scenario='.length);
      if (!id) throw new Error('--scenario requires a scenario id');
      requested.push(id);
    }
  }
  if (requested.length === 0) return scenarios;

  const byId = new Map(scenarios.map((scenario) => [scenario.id, scenario]));
  return requested.map((id) => {
    const scenario = byId.get(id);
    if (!scenario) {
      throw new Error(
        `Unknown Storage rules scenario '${id}'. Available: ${scenarios.map((item) => item.id).join(', ')}`,
      );
    }
    return scenario;
  });
}

function printInertPlan(scenarios: StorageScenario[]): void {
  console.log('[oracle:rules-storage] PARITY_SA_BASE64 not set — INERT preview, no network calls.\n');
  console.log(`  Credential env var expected: PARITY_SA_BASE64`);
  console.log(`    (base64-encoded service-account JSON with firebaserules.rulesets.test)\n`);
  console.log(`  Observation output directory: ${OBS_DIR}`);
  console.log(`  Observation filename prefix:  ${RULES_STORAGE_OBSERVATION_PREFIX}\n`);
  console.log(`  Would capture ${scenarios.length} scenario(s):`);
  let totalCases = 0;
  for (const scenario of scenarios) {
    totalCases += scenario.cases.length;
    console.log(
      `    - ${scenario.id.padEnd(28)} [${scenario.fm.padEnd(13)}] ` +
        `${String(scenario.cases.length).padStart(2)} cases → ${storageObservationName(scenario)}.json`,
    );
  }
  console.log(`\n  Total: ${scenarios.length} scenarios, ${totalCases} cases.`);
  console.log('\n  To capture for real:');
  console.log('    PARITY_SA_BASE64="$(base64 < firebaserules-sa.json)" \\');
  console.log('      bun run packages/conformance/src/run-rules-storage.ts');
}

async function capture(scenarios: StorageScenario[]): Promise<void> {
  // Heavy imports (firebase-admin credential + handler) deferred to the
  // credentialed path so the inert preview stays dependency-light.
  const { parityScope } = await import(
    '../../../packages/pyric/test/rules/parity/harness.ts'
  );
  const { TestStorageRulesHandler } = await import(
    '../../../packages/pyric/src/rules/test/handler.ts'
  );
  const scope = parityScope();
  const fbSdkVersion = resolvedFirebaseVersion();
  const handler = new TestStorageRulesHandler();
  mkdirSync(OBS_DIR, { recursive: true });

  console.log(`[oracle:rules-storage] capturing ${scenarios.length} scenario(s) against project "${scope.projectId}"`);
  console.log(`[oracle:rules-storage] firebase ${fbSdkVersion}\n`);

  for (const scenario of scenarios) {
    const res = await handler.execute(scope, scenario.rules, scenario.cases);
    if (!res.success) {
      throw new Error(
        `Production Rules Test API failed for scenario "${scenario.id}": ` +
          `${res.error.code} ${res.error.message}`,
      );
    }
    const behavior = verdictTable(scenario, res);
    const diagnostics = diagnosticTable(res.data.results);
    const obs: Observation = {
      name: storageObservationName(scenario),
      matrixRow: '',
      rowIds: [],
      description: `Storage Rules Test API verdicts for corpus scenario "${scenario.id}" (${scenario.fm}). ${scenario.rationale}`,
      observedAt: new Date().toISOString(),
      fbSdkVersion,
      projectId: scope.projectId,
      behavior,
      ...(Object.keys(diagnostics).length > 0 ? { diagnostics } : {}),
    };
    const path = observationPath(scenario);
    writeFileSync(path, JSON.stringify(obs, null, 2) + '\n');
    const allows = Object.values(behavior).filter((v) => v === 'ALLOW').length;
    const denies = Object.values(behavior).filter((v) => v === 'DENY').length;
    console.log(
      `  ✓ ${scenario.id.padEnd(28)} allow=${allows} deny=${denies} → ${storageObservationName(scenario)}.json`,
    );
  }

  console.log('\n[oracle:rules-storage] capture complete.');
  console.log('[oracle:rules-storage] NEXT: reconcile the stale storage matrix rows (#96/#104)');
  console.log('               against the captured truth, wire each observation into the');
  console.log('               compat registry (a matrix row citing it, or an');
  console.log('               observationExceptions entry), then run `bun run compat:validate`.');
}

if (import.meta.main) {
  const scenarios = selectStorageScenarios(Bun.argv.slice(2));
  if (!process.env.PARITY_SA_BASE64) {
    printInertPlan(scenarios);
    process.exit(0);
  }
  await capture(scenarios);
}
