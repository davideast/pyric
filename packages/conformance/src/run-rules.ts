#!/usr/bin/env bun
/**
 * Firestore rules oracle capture runner.
 *
 * Reads the conformance corpus (rules-corpus/firestore/) and,
 * when credentialed, replays each scenario against the PRODUCTION Firestore Rules
 * Test API via the same `TestFirestoreRulesHandler` the live parity harness
 * uses. One observation JSON is written per scenario into
 * `observations/firestore/rules-firestore-<scenario.id>.json`, using the
 * standard Observation envelope. Production is the source of truth: the
 * captured `behavior` is a verdict table keyed by case description
 * (ALLOW / DENY), which the in-process replay suite then checks the sandbox
 * simulator against.
 *
 * CREDENTIAL CONTRACT (identical to the parity harness):
 *   PARITY_SA_BASE64 — base64-encoded service-account JSON holding only
 *   `firebaserules.rulesets.test`. The project the SA belongs to is the
 *   project the rules are tested against.
 *
 * RUNNABLE-BUT-INERT WITHOUT CREDENTIALS:
 *   With PARITY_SA_BASE64 absent, this runner makes NO network calls. It
 *   prints exactly what it WOULD capture (every scenario, its case count, and the
 *   observation file path each scenario lands in) plus the env var name it needs,
 *   then exits 0. This is the intended state of the staging branch: the
 *   machinery is in place, but no captures have been run and no observation
 *   files have been fabricated.
 *
 * Usage:
 *   # inert preview (no secret):
 *   bun run packages/conformance/src/run-rules.ts
 *   # real capture (credentialed):
 *   PARITY_SA_BASE64="$(base64 < firebaserules-sa.json)" \
 *     bun run packages/conformance/src/run-rules.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestFirestoreRulesResult } from '../../../packages/pyric/src/rules/test/spec.ts';
import {
  ALL_RULES_FIRESTORE_SCENARIOS,
  RULES_FIRESTORE_OBSERVATION_PREFIX,
  observationName,
  type Scenario,
} from '../rules-corpus/firestore/index.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
// rules-firestore-* observations belong to the native 'firestore-rules' surface.
const OBS_DIR = join(HERE, '..', 'observations', 'firestore-rules');

/** Resolved (installed) firebase version — the value the observation-version
 *  guard (check-observation-versions.ts) compares every observation against.
 *  The Rules Test API is a REST surface with no client SDK, but the envelope
 *  carries `fbSdkVersion` for consistency with the rest of the oracle and to
 *  keep the version guard green once captures land. */
function resolvedFirebaseVersion(): string {
  const pkgPath = fileURLToPath(import.meta.resolve('firebase/package.json'));
  const meta = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
  if (!meta.version) throw new Error('could not resolve installed firebase version');
  return meta.version;
}

interface Observation {
  name: string;
  /** Display prose only; machines read rowIds. Empty until matrix rows land. */
  matrixRow: string;
  /** Structured registry links. Empty here — the capture phase wires these
   *  (a matrix row citing the observation, or an observationExceptions entry).
   *  Until then `compat:validate` will flag a freshly captured file, which is
   *  the signal to wire it. */
  rowIds: string[];
  description: string;
  observedAt: string;
  fbSdkVersion: string;
  projectId: string;
  behavior: Record<string, unknown>;
}

/** Absolute path an observation for `scenario` writes to. */
function observationPath(scenario: Scenario): string {
  return join(OBS_DIR, `${observationName(scenario)}.json`);
}

/** Build the verdict table (case description → prod decision) for a scenario. */
function verdictTable(
  scenario: Scenario,
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

function printInertPlan(): void {
  console.log('[oracle:rules] PARITY_SA_BASE64 not set — INERT preview, no network calls.\n');
  console.log(`  Credential env var expected: PARITY_SA_BASE64`);
  console.log(`    (base64-encoded service-account JSON with firebaserules.rulesets.test)\n`);
  console.log(`  Observation output directory: ${OBS_DIR}`);
  console.log(`  Observation filename prefix:  ${RULES_FIRESTORE_OBSERVATION_PREFIX}\n`);
  console.log(`  Would capture ${ALL_RULES_FIRESTORE_SCENARIOS.length} scenario(s):`);
  let totalCases = 0;
  for (const scenario of ALL_RULES_FIRESTORE_SCENARIOS) {
    totalCases += scenario.cases.length;
    console.log(
      `    - ${scenario.id.padEnd(42)} [${scenario.fm.padEnd(9)}] ` +
        `${String(scenario.cases.length).padStart(2)} cases → ${observationName(scenario)}.json`,
    );
  }
  console.log(`\n  Total: ${ALL_RULES_FIRESTORE_SCENARIOS.length} scenarios, ${totalCases} cases.`);
  console.log('\n  To capture for real:');
  console.log('    PARITY_SA_BASE64="$(base64 < firebaserules-sa.json)" \\');
  console.log('      bun run packages/conformance/src/run-rules.ts');
}

async function capture(): Promise<void> {
  // Heavy imports (parser/evaluator + firebase-admin) are deferred to the
  // credentialed path so the inert preview stays dependency-light and always
  // runnable. `parityScope`/`hasParitySecret` come from the parity harness so
  // the credential contract has exactly one implementation.
  const { parityScope } = await import(
    '../../../packages/pyric/test/rules/parity/harness.ts'
  );
  const { TestFirestoreRulesHandler } = await import(
    '../../../packages/pyric/src/rules/test/handler.ts'
  );
  const scope = parityScope();
  const fbSdkVersion = resolvedFirebaseVersion();
  const handler = new TestFirestoreRulesHandler();
  mkdirSync(OBS_DIR, { recursive: true });

  console.log(`[oracle:rules] capturing ${ALL_RULES_FIRESTORE_SCENARIOS.length} scenario(s) against project "${scope.projectId}"`);
  console.log(`[oracle:rules] firebase ${fbSdkVersion}\n`);

  for (const scenario of ALL_RULES_FIRESTORE_SCENARIOS) {
    const res = await handler.execute(scope, scenario.rules, scenario.cases);
    const behavior = verdictTable(scenario, res);
    const obs: Observation = {
      name: observationName(scenario),
      matrixRow: '',
      rowIds: [],
      description: `Firestore Rules Test API verdicts for corpus scenario "${scenario.id}" (${scenario.fm}). ${scenario.rationale}`,
      observedAt: new Date().toISOString(),
      fbSdkVersion,
      projectId: scope.projectId,
      behavior,
    };
    const path = observationPath(scenario);
    writeFileSync(path, JSON.stringify(obs, null, 2) + '\n');
    const allows = Object.values(behavior).filter((v) => v === 'ALLOW').length;
    const denies = Object.values(behavior).filter((v) => v === 'DENY').length;
    console.log(
      `  ✓ ${scenario.id.padEnd(42)} allow=${allows} deny=${denies} → ${observationName(scenario)}.json`,
    );
  }

  console.log('\n[oracle:rules] capture complete.');
  console.log('[oracle:rules] NEXT: wire each new observation into the compat registry');
  console.log('               (a matrix row citing it, or an observationExceptions entry),');
  console.log('               then run `bun run compat:validate`.');
}

if (import.meta.main) {
  // Same env-var contract as the parity harness (harness.ts hasParitySecret).
  // Checked inline so the inert path imports none of the heavy machinery.
  if (!process.env.PARITY_SA_BASE64) {
    printInertPlan();
    process.exit(0);
  }
  await capture();
}
