/**
 * Shared harness for the live Rules-Test-API parity packs.
 *
 * Extracted from the pre-cutover `parity-stress-integration.test.ts`
 * (deleted in be3c2b2, resurrected 2026-06 per
 * the design rationale §5) so the restored stress packs and
 * the new round-1/2 fix-class packs share one classification pipeline.
 *
 * Production is the source of truth. Per case:
 *   - OK                : sim agrees with prod and prod matches expected
 *   - SIM_BUG           : sim disagrees with prod (prod is right, sim is wrong)
 *   - SIM_NOT_SUPPORTED : sim abstained (feature not implemented) — a third
 *                         state distinct from a bug; prod never emits it
 *   - BAD_RULE          : prod disagrees with expected (the test itself is
 *                         wrong; rewrite the rule before drawing conclusions)
 *   - ERR               : either side errored at the API layer
 *
 * The tests pass if the run completes; the per-pack tally is the artifact.
 *
 * Requires: PARITY_SA_BASE64 in env — a minimal service account that holds
 * only `firebaserules.rulesets.test` (no need for the broad
 * FIREBASE_SA_BASE64 the live-integration tests use).
 */
import { cert } from 'firebase-admin/app';
import type { ProjectScope } from 'pyric-tools/deploy';
import { SimulateFirestoreRulesHandler } from '../../../src/rules/simulator/handler.js';
import { TestFirestoreRulesHandler } from '../../../src/rules/test/handler.js';
import type { TestCase, TestFirestoreRulesResult } from '../../../src/rules/test/spec.js';

// ─── Pack types ────────────────────────────────────────────────────────────

export interface Pack {
  id: string;
  fm: string;        // failure-mode / ledger tag (e.g. 'RULES-B3')
  rationale: string; // one-line: why this pack should reveal something
  rules: string;
  cases: TestCase[];
}

export type Decision = 'ALLOW' | 'DENY';
/**
 * Sim-only outcome — `UNSUPPORTED` is what `SimulateFirestoreRulesHandler`
 * returns when it hits a feature it doesn't yet implement. Prod never
 * emits this; when sim is `UNSUPPORTED` the row is `SIM_NOT_SUPPORTED`
 * (the simulator abstained) rather than agreement or bug.
 */
export type SimOutcome = Decision | 'UNSUPPORTED' | 'ERROR';
export type ProdOutcome = Decision | 'ERROR';
export type Status = 'OK' | 'SIM_BUG' | 'SIM_NOT_SUPPORTED' | 'BAD_RULE' | 'ERR';

export interface CaseRow {
  pack: string;
  description: string;
  expected: Decision;
  simulator: SimOutcome;
  production: ProdOutcome;
  status: Status;
}

// ─── Credential — ProjectScope from PARITY_SA_BASE64 ──────────────────────
//
// The old harness used `initializeAgentApp({ credentialEnvVar })`, which
// died with `packages/sdk/` in the cutover. Post-mirror equivalent: build
// a firebase-admin cert credential straight from the base64 SA env var and
// wrap it in the `ProjectScope` shape `TestFirestoreRulesHandler.execute`
// takes (F3). No admin App needed — the credential alone mints the token.

export function hasParitySecret(): boolean {
  return !!process.env.PARITY_SA_BASE64;
}

export function parityScope(): ProjectScope {
  const b64 = process.env.PARITY_SA_BASE64;
  if (!b64) {
    throw new Error(
      'PARITY_SA_BASE64 not set — export the base64-encoded service-account JSON ' +
        '(needs only firebaserules.rulesets.test) to run the live parity suite.',
    );
  }
  const sa = JSON.parse(Buffer.from(b64, 'base64').toString('utf-8')) as {
    project_id: string;
  };
  const credential = cert(sa as Parameters<typeof cert>[0]);
  let cached: { token: string; expiresAt: number } | undefined;
  return {
    projectId: sa.project_id,
    resolveToken: async () => {
      if (cached && Date.now() < cached.expiresAt - 60_000) return cached.token;
      const t = await credential.getAccessToken();
      cached = { token: t.access_token, expiresAt: Date.now() + t.expires_in * 1000 };
      return cached.token;
    },
  };
}

// ─── Classification ────────────────────────────────────────────────────────

function deriveActual(
  expectation: Decision,
  state: 'PASSED' | 'FAILED' | 'UNSUPPORTED',
): Decision | 'UNSUPPORTED' {
  if (state === 'UNSUPPORTED') return 'UNSUPPORTED';
  if (state === 'PASSED') return expectation;
  return expectation === 'ALLOW' ? 'DENY' : 'ALLOW';
}

export function simActualsFromResult(
  res: TestFirestoreRulesResult,
  cases: TestCase[],
): SimOutcome[] {
  if (!res.success) return cases.map(() => 'ERROR' as const);
  return res.data.results.map((r, i) => deriveActual(cases[i].expectation, r.state));
}

export function prodActualsFromResult(
  res: TestFirestoreRulesResult,
  cases: TestCase[],
): ProdOutcome[] {
  if (!res.success) return cases.map(() => 'ERROR' as const);
  return res.data.results.map((r, i) => {
    const actual = deriveActual(cases[i].expectation, r.state);
    // Prod never returns UNSUPPORTED. If we ever see it, surface as ERROR
    // — it would mean the result type drifted out of sync with reality.
    return actual === 'UNSUPPORTED' ? 'ERROR' : actual;
  });
}

export function classify(
  expected: Decision,
  sim: SimOutcome,
  prod: ProdOutcome,
): Status {
  if (prod === 'ERROR') return 'ERR';
  if (sim === 'ERROR') return 'ERR';
  if (sim === 'UNSUPPORTED') return 'SIM_NOT_SUPPORTED'; // sim abstained — neither agreement nor bug
  if (prod !== expected) return 'BAD_RULE';              // production didn't behave as the test expected
  if (sim !== prod) return 'SIM_BUG';                    // production is right, simulator is wrong
  return 'OK';
}

// ─── Pack runner ───────────────────────────────────────────────────────────

/**
 * Run one pack through both engines and classify each case.
 * Throws when the production API call itself fails — that's a real
 * signal (bad SA / unreachable API / rejected rules), not a tally row.
 */
export async function runPack(pack: Pack, scope: ProjectScope): Promise<CaseRow[]> {
  const sim = new SimulateFirestoreRulesHandler();
  const prod = new TestFirestoreRulesHandler();

  const simRes = sim.simulate(pack.rules, pack.cases);
  const prodRes = await prod.execute(scope, pack.rules, pack.cases);

  if (!prodRes.success) {
    throw new Error(
      `Production API call failed for pack "${pack.id}": ${prodRes.error.code} ${prodRes.error.message}`,
    );
  }

  const simActuals = simActualsFromResult(simRes, pack.cases);
  const prodActuals = prodActualsFromResult(prodRes, pack.cases);

  return pack.cases.map((tc, i) => ({
    pack: pack.id,
    description: tc.description,
    expected: tc.expectation,
    simulator: simActuals[i],
    production: prodActuals[i],
    status: classify(tc.expectation, simActuals[i], prodActuals[i]),
  }));
}

// ─── Reporting ─────────────────────────────────────────────────────────────

export interface Tally {
  ok: number;
  simBugs: number;
  simUnsup: number;
  bad: number;
  errs: number;
  n: number;
}

export function tally(rows: CaseRow[]): Tally {
  return {
    ok: rows.filter(r => r.status === 'OK').length,
    simBugs: rows.filter(r => r.status === 'SIM_BUG').length,
    simUnsup: rows.filter(r => r.status === 'SIM_NOT_SUPPORTED').length,
    bad: rows.filter(r => r.status === 'BAD_RULE').length,
    errs: rows.filter(r => r.status === 'ERR').length,
    n: rows.length,
  };
}

export function reportParity(title: string, packs: Pack[], allRows: CaseRow[]): void {
  console.log(`\n═══ ${title} ═══`);
  console.log('   Production is the source of truth.');
  console.log('   OK = sim matches prod & prod matches expected');
  console.log('   SIM_BUG = sim disagrees with prod (sim wrong)');
  console.log('   SIM_NOT_SUPPORTED = sim abstained (feature not implemented)');
  console.log('   BAD_RULE = prod disagrees with expected (test design wrong)');
  console.log('   ERR = API/handler error');

  for (const pack of packs) {
    const rows = allRows.filter(r => r.pack === pack.id);
    if (rows.length === 0) continue;
    const t = tally(rows);
    console.log(`\n── Pack: ${pack.id}  (FM: ${pack.fm})`);
    console.log(`   ${pack.rationale}`);
    for (const r of rows) {
      console.log(
        `   [${r.status.padEnd(17)}] sim=${String(r.simulator).padEnd(11)} prod=${String(r.production).padEnd(5)} expected=${r.expected.padEnd(5)} :: ${r.description}`,
      );
    }
    console.log(
      `   Pack: ok=${t.ok}  sim_bugs=${t.simBugs}  sim_not_supported=${t.simUnsup}  bad_rules=${t.bad}  errors=${t.errs}  (n=${t.n})`,
    );
  }

  const t = tally(allRows);
  console.log(
    `\n── Overall: ok=${t.ok}  sim_bugs=${t.simBugs}  sim_not_supported=${t.simUnsup}  bad_rules=${t.bad}  errors=${t.errs}  (n=${t.n})`,
  );
  console.log('═══════════════════════════════════════════════\n');
}
